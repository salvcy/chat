import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * Per-user realtime invalidation hub.
 *
 * It never sees a title, a prompt, a message, or a blob id. A commit sends
 * the latest integer revision and the id of the thread that moved, and
 * connected devices use the pair as a hint to run the normal authenticated
 * read. Hibernatable sockets keep the connection alive while the object
 * sleeps, so idle accounts consume no Durable Object time.
 *
 * The thread id is new, and it is the difference between "something changed
 * on this account" and "this specific conversation changed". With the old
 * revision-only message every device re-read the whole account delta on every
 * notification, including devices looking at a different conversation
 * entirely. Now a device re-reads the open thread only when the notification
 * names it. The id is a random client-minted string that already sits in the
 * clear in the `thread` table, so this discloses nothing the database does
 * not.
 *
 * It also relays, and only relays, what an account's devices say to each
 * other while one of them is streaming an answer: `live` frames carrying the
 * newest part of the reply (sealed with the account's vault key — the hub
 * reads the thread id and a frame number, never the text), `want` asking the
 * streaming device for a full frame, and `stop` asking it to stop. Nothing is
 * stored. A device that is not connected misses the frames and reads the
 * checkpoint from D1 instead, exactly as before.
 */

/** Relayed message kinds; anything else a client sends is dropped. */
const RELAYED = new Set(["live", "want", "stop"]);
/** A frame is a sealed patch of a few hundred bytes; a keyframe, a reply. */
const MAX_RELAY_CHARS = 512 * 1024;
const THREAD_ID = /^[A-Za-z0-9_-]{1,96}$/;

/**
 * `close()` rejects the reserved codes, and 1006 is exactly what an abrupt
 * disconnect delivers. Throwing here is not a local failure: an exception in
 * a hibernation handler tears down the object, which drops the sockets every
 * *other* device on the account is holding.
 */
function echoableCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

export class SyncHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("websocket upgrade required", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // The connection id is a tag so it survives hibernation — the object
      // can be evicted from memory and still know which socket caused a
      // revision when it wakes up to fan one out.
      const connection = url.searchParams.get("c");
      this.ctx.acceptWebSocket(server, connection ? [connection] : []);

      // The opening frame names no thread: it is the account's current
      // revision, so a device that reconnects after a gap knows whether it
      // has anything to catch up on at all.
      const rev = Number(url.searchParams.get("rev") ?? 0);
      server.send(
        JSON.stringify({ rev: Number.isSafeInteger(rev) ? rev : 0, thread: null }),
      );
      this.announcePeers();
      // The desktop app offered `chat.v1` alongside its token (index.ts,
      // LIVE_PROTOCOL); a browser drops a handshake whose offer goes
      // unanswered. Only ever this one fixed value — the token is not echoed.
      const protocol = url.searchParams.get("p") === "chat.v1" ? "chat.v1" : null;
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
      });
    }

    if (url.pathname === "/notify" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        rev?: unknown;
        thread?: unknown;
        exclude?: unknown;
        settings?: unknown;
      } | null;
      const rev = Number(body?.rev);
      if (!Number.isSafeInteger(rev) || rev < 0) {
        return new Response("invalid revision", { status: 400 });
      }
      const exclude =
        typeof body?.exclude === "string" && body.exclude ? body.exclude : null;
      const thread =
        typeof body?.thread === "string" && body.thread ? body.thread : null;

      // `settings` says the account's settings blob changed: re-read it.
      const message = JSON.stringify(
        body?.settings === true ? { rev, thread, settings: true } : { rev, thread },
      );
      for (const socket of this.ctx.getWebSockets()) {
        // Never echo a revision back to the device that caused it. Without
        // this, a device that pushes mid-stream wakes itself, finds the rows
        // its own 1.2s snapshot just re-dirtied, pushes again, and loops at
        // round-trip speed instead of at the intended debounce.
        if (exclude && this.ctx.getTags(socket).includes(exclude)) continue;
        try {
          socket.send(message);
        } catch {
          // A dead edge connection disappears from getWebSockets after close;
          // one stale socket must never keep the other devices from syncing.
          try {
            socket.close(1011, "connection unavailable");
          } catch {
            // Already gone.
          }
        }
      }
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * Pass a device's live message to the account's other devices, verbatim.
   *
   * Only the envelope is read — its kind and thread — and the original string
   * is what goes out, so a frame costs one parse and no re-serialisation.
   */
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > MAX_RELAY_CHARS) return;
    let envelope: { t?: unknown; thread?: unknown } | null = null;
    try {
      envelope = JSON.parse(message) as { t?: unknown; thread?: unknown };
    } catch {
      return;
    }
    if (
      !envelope ||
      typeof envelope.t !== "string" ||
      !RELAYED.has(envelope.t) ||
      typeof envelope.thread !== "string" ||
      !THREAD_ID.test(envelope.thread)
    ) {
      return;
    }

    const sender = this.ctx.getTags(socket)[0];
    for (const other of this.ctx.getWebSockets()) {
      if (other === socket) continue;
      if (sender && this.ctx.getTags(other).includes(sender)) continue;
      try {
        other.send(message);
      } catch {
        // A socket mid-close; the next fan-out will not find it.
      }
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(echoableCloseCode(code), reason);
    } catch {
      // The peer is already gone; there is nothing left to acknowledge.
    }
    this.announcePeers(socket);
  }

  /**
   * Tell every device how many are connected. A device alone on its account
   * then publishes no live frames at all — they would cost a relay each and
   * reach nobody.
   */
  private announcePeers(leaving?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter((socket) => socket !== leaving);
    const message = JSON.stringify({ t: "peers", n: sockets.length });
    for (const socket of sockets) {
      try {
        socket.send(message);
      } catch {
        // Closing; it will not be counted next time.
      }
    }
  }
}

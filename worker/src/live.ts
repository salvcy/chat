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
 */

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
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/notify" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        rev?: unknown;
        thread?: unknown;
        exclude?: unknown;
      } | null;
      const rev = Number(body?.rev);
      if (!Number.isSafeInteger(rev) || rev < 0) {
        return new Response("invalid revision", { status: 400 });
      }
      const exclude =
        typeof body?.exclude === "string" && body.exclude ? body.exclude : null;
      const thread =
        typeof body?.thread === "string" && body.thread ? body.thread : null;

      const message = JSON.stringify({ rev, thread });
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

  /** Clients do not publish data through this channel. */
  webSocketMessage(socket: WebSocket): void {
    socket.send(JSON.stringify({ type: "pong" }));
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(echoableCloseCode(code), reason);
    } catch {
      // The peer is already gone; there is nothing left to acknowledge.
    }
  }
}

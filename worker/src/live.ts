import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * Per-user realtime invalidation hub.
 *
 * It never sees a record, title, prompt, or blob id. A sync commit sends the
 * latest integer revision and connected devices use that as a hint to run the
 * normal authenticated pull. Hibernatable sockets keep the connection alive
 * while the object sleeps, so idle accounts consume no Durable Object time.
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

      const rev = Number(url.searchParams.get("rev") ?? 0);
      server.send(JSON.stringify({ rev: Number.isSafeInteger(rev) ? rev : 0 }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/notify" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        rev?: unknown;
        exclude?: unknown;
      } | null;
      const rev = Number(body?.rev);
      if (!Number.isSafeInteger(rev) || rev < 0) {
        return new Response("invalid revision", { status: 400 });
      }
      const exclude =
        typeof body?.exclude === "string" && body.exclude ? body.exclude : null;

      const message = JSON.stringify({ rev });
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

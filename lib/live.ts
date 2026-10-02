"use client";

import type { FrameEnvelope } from "./live-frames";
import { openLive, sealLive } from "./store";

/**
 * Device-to-device messages over the account's realtime socket.
 *
 * The socket itself belongs to the session (`lib/session.ts`), which attaches
 * it here when it opens and hands over every relayed message it receives. A
 * chat that is streaming publishes frames through `publishFrame`; a chat that
 * has the same thread open subscribes and lays them over its transcript. The
 * hub relays without reading: frames are sealed with the vault key, bound to
 * their thread, stream and number.
 */

export type LiveMessage =
  | { t: "live"; thread: string; stream: string; n: number; data: string }
  | { t: "want"; thread: string }
  | { t: "stop"; thread: string; stream: string };

let socket: WebSocket | null = null;
/** Other devices on this account with a socket open, as the hub last said. */
let peers = 0;
const listeners = new Set<(message: LiveMessage) => void>();

/** A socket this far behind drops frames rather than queueing them. */
const BACKLOG_BYTES = 256 * 1024;

export function attachLiveSocket(next: WebSocket | null): void {
  socket = next;
  if (!next) peers = 0;
}

/** The hub counts sockets, this one included. */
export function setLivePeers(connected: number): void {
  peers = Math.max(0, connected - 1);
}

/** Whether anyone would receive a frame. */
export function hasLivePeers(): boolean {
  return peers > 0 && liveConnected();
}

export function isLiveMessage(value: unknown): value is LiveMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (typeof message.thread !== "string") return false;
  if (message.t === "want") return true;
  if (message.t === "stop") return typeof message.stream === "string";
  return (
    message.t === "live" &&
    typeof message.stream === "string" &&
    typeof message.n === "number" &&
    typeof message.data === "string"
  );
}

export function dispatchLive(message: LiveMessage): void {
  for (const listener of listeners) {
    try {
      listener(message);
    } catch {
      // One chat's failure must not keep a message from the others, or
      // take the socket's handler down with it.
    }
  }
}

export function subscribeLive(listener: (message: LiveMessage) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function send(message: LiveMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > BACKLOG_BYTES) return false;
  socket.send(JSON.stringify(message));
  return true;
}

export function liveConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

const recordFor = (thread: string, stream: string, n: number) => `live/${thread}/${stream}/${n}`;

/** Seal and send one frame. False when it did not leave this device. */
export async function publishFrame(thread: string, frame: FrameEnvelope): Promise<boolean> {
  if (!liveConnected()) return false;
  const data = await sealLive(recordFor(thread, frame.stream, frame.n), frame);
  return send({ t: "live", thread, stream: frame.stream, n: frame.n, data });
}

export async function openFrame(
  message: Extract<LiveMessage, { t: "live" }>,
): Promise<FrameEnvelope | null> {
  const frame = await openLive<FrameEnvelope>(
    recordFor(message.thread, message.stream, message.n),
    message.data,
  );
  return frame && frame.stream === message.stream && frame.n === message.n ? frame : null;
}

/** Ask whoever is streaming this thread for a whole frame. */
export function askForKeyframe(thread: string): boolean {
  return send({ t: "want", thread });
}

/** Ask whoever is streaming this thread to stop. */
export function askToStop(thread: string, stream: string): boolean {
  return send({ t: "stop", thread, stream });
}

"use client";

import type { UIMessage } from "ai";
import {
  downloadBlob,
  downloadPayloadBlob,
  uploadBlob,
  uploadPayloadBlob,
} from "./blob";
import { openRecord, sealRecord, toBase64Url } from "./crypto";
import {
  DEFAULT_SETTINGS,
  type ChatSettings,
  type DialDataParts,
  type DialMetadata,
  type ReasoningEffort,
} from "./types";
import { reuseUploadedBlobReferences } from "./message-sync";

/**
 * The data layer. There is exactly one store and it is not in this browser.
 *
 * This replaces `lib/db.ts` and `lib/sync.ts` together — an IndexedDB schema
 * with four tables, and an 800-line engine for reconciling it against the
 * server through a cursor. Both are gone, and so is every bug that was only
 * possible because two copies of the truth existed:
 *
 *  - a cursor advancing past rows it had not seen
 *  - a pull overwriting a local row that had not been pushed yet
 *  - a deletion on one device undone by the next pull on another
 *  - a tombstone table needed to make deletes survive at all
 *
 * None of those can be reintroduced here, because none of them have anywhere
 * to happen. A write is a request; a read is a request; what the server
 * returns *is* the state. The realtime socket is a hint that a read is worth
 * repeating, and losing one costs a beat of latency rather than data.
 *
 * What this module still owns is the part that never depended on where the
 * truth lived: sealing records with the vault key, moving image and document
 * bytes into R2 so they never sit in a row, and spilling an oversized payload
 * to R2 behind a sentinel. All three came across from the sync engine
 * essentially unchanged, because all three were correct.
 */

const API = "/v1";

/* -------------------------------- types -------------------------------- */

export type ConversationMeta = {
  id: string;
  title: string;
  /** True once a model has named it — stops the fallback from overwriting. */
  titleGenerated?: boolean;
  /** OpenRouter model id — persisted per conversation. */
  model: string;
  reasoning: ReasoningEffort;
  search: boolean;
  /** Per-conversation system prompt. "" = none. */
  system: string;
  /** Pinned threads sort above everything else. */
  pinned?: boolean;
  /** Rolling totals across the thread, summed from message metadata. */
  totalCostUsd?: number;
  totalTokens?: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * A stored message carries its flight recorder, so reopening shows it.
 *
 * `seq` is its position in the thread. It was explicit before because
 * IndexedDB guarantees no insertion order; it stays explicit because it is
 * now the server's `ORDER BY`, and because edit-and-resend deletes a range of
 * it.
 *
 * The `dirty` / `stamp` / `rev` columns that used to ride along are gone.
 * They existed to describe how far a local row had got through being
 * uploaded, and there is no local row any more.
 */
export type StoredMessage = UIMessage<DialMetadata, DialDataParts> & {
  conversationId: string;
  seq: number;
};

/** What a thread's `meta` column holds, sealed. */
type SealedMeta = Omit<ConversationMeta, "id" | "pinned" | "updatedAt">;

/* ------------------------------- helpers ------------------------------- */

/** Plain-text of a message, across its text parts. */
export function textOf(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

/**
 * Local fallback title — first user line, tightened. Used immediately so the
 * sidebar is never blank, then replaced by the generated one when it lands.
 */
export function deriveTitle(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first ? textOf(first) : "";
  if (!text) return "new chat";
  // Collapse whitespace so a pasted block doesn't become a ragged row.
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Sum the flight recorders on a thread into its rolling totals. */
export function totalsOf(messages: UIMessage<DialMetadata>[]): {
  totalCostUsd: number;
  totalTokens: number;
} {
  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const m of messages) {
    const meta = m.metadata;
    if (!meta) continue;
    totalCostUsd += meta.costUsd ?? 0;
    totalTokens += (meta.promptTokens ?? 0) + (meta.completionTokens ?? 0);
  }
  return { totalCostUsd, totalTokens };
}

export function settingsOf(meta: ConversationMeta | undefined): ChatSettings {
  if (!meta) return { ...DEFAULT_SETTINGS };
  return {
    model: meta.model,
    reasoning: meta.reasoning,
    search: meta.search,
    system: meta.system ?? "",
  };
}

/* ------------------------------ the vault ------------------------------ */

/**
 * The key and the account's encryption mode, held here rather than passed
 * through every call.
 *
 * The mode is the authority on whether this account is encrypted — never the
 * presence of a key. That distinction caused real data loss once: a device
 * whose IndexedDB had been cleared still had a valid session cookie, saw no
 * key, concluded the account was unencrypted, and wrote plaintext over
 * ciphertext. After that the correct password could not open it, because what
 * it was asked to decrypt was no longer ciphertext.
 */
let vaultKey: CryptoKey | null = null;
let encrypted = false;

export function setVaultKey(key: CryptoKey | null): void {
  vaultKey = key;
}

export function setEncryption(mode: string): void {
  encrypted = mode !== "none";
}

export class LockedError extends Error {
  constructor() {
    super("this account is encrypted and this device does not have the key");
    this.name = "LockedError";
  }
}

/** Encrypted account, no key: reading returns noise and writing destroys. */
function assertUnlocked(): void {
  if (encrypted && !vaultKey) throw new LockedError();
}

async function seal(recordId: string, value: unknown): Promise<string> {
  return vaultKey
    ? sealRecord(vaultKey, recordId, value)
    : JSON.stringify(value);
}

async function unseal<T>(recordId: string, payload: string): Promise<T | null> {
  if (vaultKey) return openRecord<T>(vaultKey, recordId, payload);
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

/* ------------------------------ transport ------------------------------ */

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: init?.body
      ? { "Content-Type": "application/json", ...init?.headers }
      : init?.headers,
  });

  // 204 is the only empty success this API returns (DELETE). A literal 304
  // is deliberately *not* handled: `fetch` turns a validated conditional
  // request back into a 200 from the HTTP cache, so one arriving here would
  // mean something unexpected — and treating it as an empty body would blank
  // the sidebar rather than say so.
  if (response.status === 204) return null;

  const body = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;

  if (!response.ok) {
    throw new StoreError(
      body?.error ?? "the request could not be completed",
      response.status,
    );
  }
  return body;
}

/** This device's live-socket id, so the server never wakes us with our own write. */
let connectionId: string | null = null;

/**
 * Let the account session advance its revision cursor when this browser
 * commits a write.
 *
 * Without this, a later focus refresh asks for revisions that this same
 * browser just created, mistakes its own streaming checkpoint for a remote
 * edit, and can pull an older partial answer back over the completed one.
 */
let revisionObserver: ((revision: number) => void) | null = null;

export function setLiveConnectionId(id: string | null): void {
  connectionId = id;
}

export function setRevisionObserver(
  observer: ((revision: number) => void) | null,
): void {
  revisionObserver = observer;
}

function noteRevision(revision: number): void {
  if (Number.isSafeInteger(revision) && revision > 0) {
    revisionObserver?.(revision);
  }
}

/* ---------------------------- heavy attachments ------------------------ */

/**
 * Move image and document bytes into R2 before a message is sealed.
 *
 * A generated PNG is megabytes of base64 sitting inside the message, and a
 * row is capped at 128KB upstream — one image would fail the whole write. The
 * sealed payload keeps only a blob id, media type, and optional custom-domain
 * URL; the R2 object is itself encrypted in the browser.
 */
type StrippedMessage = StoredMessage & { blobsStripped?: true };

type DialBlobMetadata = {
  imageReference?: boolean;
  blobId?: string;
  blobUrl?: string;
  [key: string]: unknown;
};

function dialMetadata(
  part: Extract<StoredMessage["parts"][number], { type: "file" }>,
): DialBlobMetadata {
  const value = part.providerMetadata?.dial;
  return value && typeof value === "object" ? (value as DialBlobMetadata) : {};
}

/** Message ids come from the AI SDK and are not guaranteed to be key-safe. */
async function safeIdFor(recordId: string): Promise<string> {
  return /^[A-Za-z0-9_-]{1,96}$/.test(recordId)
    ? recordId
    : toBase64Url(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(recordId),
        ),
      );
}

/**
 * Deterministic, and prefixed by the thread.
 *
 * Deterministic so an upload retry replaces its own object rather than
 * accumulating copies. Thread-prefixed so deleting a conversation is a single
 * R2 prefix delete — it used to be keyed by message alone, which meant one
 * delete fanned out an unbounded list/delete loop per message in the thread.
 */
async function blobIdFor(
  threadId: string,
  messageId: string,
  kind: "generated" | "file" | "payload",
  partIndex: number,
  assetIndex = 0,
): Promise<string> {
  const safe = await safeIdFor(messageId);
  const tag = kind === "generated" ? "g" : kind === "file" ? "f" : "p";
  return `${threadId}/${safe}.${tag}.${partIndex}.${assetIndex}`;
}

type PreparedMessage = {
  remote: StrippedMessage;
  /** Same pixels as the in-memory copy, now carrying their durable R2 ids. */
  localParts: StoredMessage["parts"];
};

async function prepareBlobs(
  threadId: string,
  message: StoredMessage,
): Promise<PreparedMessage> {
  let stripped = false;
  const localParts: StoredMessage["parts"] = [];
  const remoteParts: StoredMessage["parts"] = [];

  for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
    const part = message.parts[partIndex];

    if (part.type === "data-image") {
      if (part.data.images.some((asset) => asset.blobId)) stripped = true;
      const pairs = await Promise.all(
        part.data.images.map(async (asset, assetIndex) => {
          if (!asset.url.startsWith("data:")) {
            return { local: asset, remote: asset };
          }
          stripped = true;
          const blobId =
            asset.blobId ??
            (await blobIdFor(
              threadId,
              message.id,
              "generated",
              partIndex,
              assetIndex,
            ));
          // A reference means this exact deterministic object is already in
          // R2; uploading it again would be a needless write.
          const uploaded = asset.blobId
            ? { id: blobId, url: asset.blobUrl ?? null }
            : await uploadBlob(blobId, asset.url, vaultKey);
          const reference = {
            ...asset,
            blobId: uploaded.id,
            ...(uploaded.url ? { blobUrl: uploaded.url } : {}),
          };
          return { local: reference, remote: { ...reference, url: "" } };
        }),
      );
      localParts.push({
        ...part,
        data: { ...part.data, images: pairs.map((pair) => pair.local) },
      });
      remoteParts.push({
        ...part,
        data: { ...part.data, images: pairs.map((pair) => pair.remote) },
      });
      continue;
    }

    if (part.type === "file" && part.url.startsWith("data:")) {
      stripped = true;
      const dial = dialMetadata(part);
      const blobId =
        typeof dial.blobId === "string"
          ? dial.blobId
          : await blobIdFor(threadId, message.id, "file", partIndex);
      const uploaded =
        typeof dial.blobId === "string"
          ? {
              id: blobId,
              url: typeof dial.blobUrl === "string" ? dial.blobUrl : null,
            }
          : await uploadBlob(blobId, part.url, vaultKey);
      const nextDial = {
        ...dial,
        blobId: uploaded.id,
        ...(uploaded.url ? { blobUrl: uploaded.url } : {}),
      };
      const referenced = {
        ...part,
        providerMetadata: { ...part.providerMetadata, dial: nextDial },
      };
      localParts.push(referenced);
      remoteParts.push({ ...referenced, url: "" });
      continue;
    }

    if (part.type === "file" && typeof dialMetadata(part).blobId === "string") {
      stripped = true;
    }
    localParts.push(part);
    remoteParts.push(part);
  }

  return {
    remote: stripped
      ? { ...message, parts: remoteParts, blobsStripped: true }
      : { ...message, parts: remoteParts },
    localParts,
  };
}

/**
 * Parts that have already been through `prepareBlobs`, by message id.
 *
 * Uploading is idempotent — the ids are deterministic — but it is not free,
 * and a thread that is written repeatedly (a streaming answer checkpoints
 * every few seconds) would otherwise re-send the same megabytes. This is a
 * per-session memo, not storage: losing it costs one redundant upload.
 */
const uploaded = new Map<string, StoredMessage["parts"]>();

/** Fill R2 references this device has not downloaded yet. */
async function hydrateBlobs(message: StoredMessage): Promise<StoredMessage> {
  const parts: StoredMessage["parts"] = [];

  for (const part of message.parts) {
    if (part.type === "data-image") {
      const images = await Promise.all(
        part.data.images.map(async (asset) => {
          if (asset.url.startsWith("data:") || !asset.blobId) return asset;
          const url = await downloadBlob(
            asset.blobId,
            asset.mediaType,
            vaultKey,
            asset.blobUrl,
          );
          return url ? { ...asset, url } : asset;
        }),
      );
      parts.push({ ...part, data: { ...part.data, images } });
      continue;
    }

    if (part.type === "file" && !part.url) {
      const dial = dialMetadata(part);
      if (typeof dial.blobId === "string") {
        const url = await downloadBlob(
          dial.blobId,
          part.mediaType,
          vaultKey,
          typeof dial.blobUrl === "string" ? dial.blobUrl : undefined,
        );
        parts.push(url ? { ...part, url } : part);
        continue;
      }
    }
    parts.push(part);
  }

  const copy = { ...message } as StrippedMessage;
  delete copy.blobsStripped;
  return { ...copy, parts };
}

/* ----------------------------- payload spill --------------------------- */

/**
 * The 128KB row cap is really about 90KB of text.
 *
 * `seal` base64s the ciphertext — a 4/3 expansion — on top of JSON escaping,
 * so a long reasoning answer overflows the column. Anything past this goes to
 * R2 behind a sentinel instead. The spilled bytes are the *sealed* payload,
 * so nothing is encrypted twice and the service learns nothing new, and the
 * object shares the thread's prefix so deleting the conversation erases it.
 */
const PAYLOAD_SPILL_LIMIT = 96 * 1024;
const SPILL_PREFIX = "@r2:";

async function writePayload(
  threadId: string,
  messageId: string,
  sealed: string,
): Promise<string> {
  if (sealed.length <= PAYLOAD_SPILL_LIMIT) return sealed;
  const blobId = await blobIdFor(threadId, messageId, "payload", 0);
  await uploadPayloadBlob(blobId, sealed);
  return `${SPILL_PREFIX}${blobId}`;
}

async function readPayload(payload: string): Promise<string | null> {
  if (!payload.startsWith(SPILL_PREFIX)) return payload;
  return downloadPayloadBlob(payload.slice(SPILL_PREFIX.length));
}

/* ------------------------------ the surface ---------------------------- */

type ThreadWire = {
  id: string;
  rev: number;
  meta: string | null;
  pinned: boolean;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
};

type MessageWire = {
  id: string;
  seq: number;
  rev: number;
  payload: string | null;
  updatedAt: number;
};

/**
 * Rebuild a `ConversationMeta` from a wire row.
 *
 * The sort keys come from the row's own columns and everything else from the
 * sealed blob. A row we cannot open — wrong key, or a payload written by a
 * newer format — yields a placeholder rather than nothing, so an unreadable
 * thread appears in the sidebar as something the user can delete instead of
 * silently vanishing.
 */
async function openThreadRow(row: ThreadWire): Promise<ConversationMeta> {
  const sealed = row.meta ? await unseal<SealedMeta>(row.id, row.meta) : null;
  return {
    id: row.id,
    title: sealed?.title ?? "unreadable",
    titleGenerated: sealed?.titleGenerated,
    model: sealed?.model ?? DEFAULT_SETTINGS.model,
    reasoning: sealed?.reasoning ?? DEFAULT_SETTINGS.reasoning,
    search: sealed?.search ?? DEFAULT_SETTINGS.search,
    system: sealed?.system ?? "",
    totalCostUsd: sealed?.totalCostUsd,
    totalTokens: sealed?.totalTokens,
    pinned: row.pinned,
    createdAt: sealed?.createdAt ?? row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A page count high enough that hitting it means a bug rather than a big
 * account — 200 threads or messages per page, so this is 100k of either.
 */
const MAX_PAGES = 500;

export async function listThreads(): Promise<ConversationMeta[]> {
  assertUnlocked();
  const rows: ThreadWire[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = (await call(`/threads?offset=${rows.length}`)) as {
      threads: ThreadWire[];
      hasMore: boolean;
    } | null;
    if (!body) break;
    rows.push(...body.threads);
    if (!body.hasMore || body.threads.length === 0) break;
  }
  return Promise.all(rows.map(openThreadRow));
}

export type OpenThread = {
  meta: ConversationMeta;
  messages: StoredMessage[];
};

export async function readThread(id: string): Promise<OpenThread | null> {
  assertUnlocked();
  /*
   * Paged by `seq`, not by offset.
   *
   * The server ends a page early when the payloads reach its response
   * budget, so a page can be short without being the last one — a thread of
   * long reasoning answers hits the byte ceiling well before the row
   * ceiling. Resuming from the last seq seen is the only cursor that is
   * correct under both limits.
   */
  let thread: ThreadWire | null = null;
  const rows: MessageWire[] = [];
  let after = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: { thread: ThreadWire; messages: MessageWire[]; hasMore: boolean } | null;
    try {
      body = (await call(
        `/threads/${encodeURIComponent(id)}?after=${after}`,
      )) as { thread: ThreadWire; messages: MessageWire[]; hasMore: boolean };
    } catch (error) {
      if (error instanceof StoreError && error.status === 404) return null;
      throw error;
    }
    if (!body) return null;
    thread = body.thread;
    rows.push(...body.messages);
    if (!body.hasMore || body.messages.length === 0) break;
    after = body.messages[body.messages.length - 1].seq + 1;
  }
  if (!thread) return null;

  const messages: StoredMessage[] = [];
  for (const row of rows) {
    if (!row.payload) continue;
    const payload = await readPayload(row.payload);
    if (!payload) continue;
    const opened = await unseal<StoredMessage>(row.id, payload);
    if (!opened) continue;
    messages.push(
      await hydrateBlobs({ ...opened, id: row.id, conversationId: id, seq: row.seq }),
    );
  }

  return { meta: await openThreadRow(thread), messages };
}

export type ThreadWrite = {
  id: string;
  /** Present when the thread's own metadata changed. */
  meta?: ConversationMeta;
  /** Delete every message at this seq and above before writing. */
  truncateFrom?: number;
  messages?: StoredMessage[];
  /**
   * Bump the thread's revision and timestamp.
   *
   * Left false by a streaming checkpoint. A long answer writes its assistant
   * message every few seconds, and touching the thread row alongside it would
   * double the rows written for the turn to announce something no reader
   * needs — the delta probe already sees the message move.
   */
  touch?: boolean;
};

export async function writeThread(input: ThreadWrite): Promise<number> {
  assertUnlocked();

  const body: Record<string, unknown> = {};
  if (input.meta) {
    const { id, pinned, updatedAt, ...sealable } = input.meta;
    void id;
    void updatedAt;
    body.meta = await seal(input.meta.id, sealable satisfies SealedMeta);
    body.pinned = pinned === true;
    body.createdAt = input.meta.createdAt;
  }
  if (input.truncateFrom !== undefined) body.truncateFrom = input.truncateFrom;
  if (input.touch) body.touch = true;
  if (connectionId) body.client = connectionId;

  if (input.messages?.length) {
    body.messages = await Promise.all(
      input.messages.map(async (message) => {
        const memo = uploaded.get(message.id);
        const prepared = await prepareBlobs(
          input.id,
          memo
            ? {
                ...message,
                // Reuse only R2 ids from the memo. Text and reasoning in a
                // streaming message must always come from this snapshot.
                parts: reuseUploadedBlobReferences(message.parts, memo),
              }
            : message,
        );
        // Text-only messages have nothing reusable. Keeping them here was the
        // original corruption vector because an assistant id survives for the
        // whole stream while its text grows.
        if (prepared.remote.blobsStripped) {
          uploaded.set(message.id, prepared.localParts);
        } else {
          uploaded.delete(message.id);
        }

        const { conversationId, seq, ...rest } = prepared.remote;
        void conversationId;
        const sealed = await seal(message.id, rest);
        return {
          id: message.id,
          seq,
          payload: await writePayload(input.id, message.id, sealed),
        };
      }),
    );
  }

  const result = (await call(`/threads/${encodeURIComponent(input.id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  })) as { rev: number } | null;
  const revision = result?.rev ?? 0;
  noteRevision(revision);
  return revision;
}

export async function deleteThread(id: string): Promise<void> {
  const query = connectionId
    ? `?client=${encodeURIComponent(connectionId)}`
    : "";
  const result = (await call(`/threads/${encodeURIComponent(id)}${query}`, {
    method: "DELETE",
  })) as { rev?: number } | null;
  noteRevision(result?.rev ?? 0);
}

export type Delta = {
  rev: number;
  threads: ConversationMeta[];
  /** Ids that are gone — removed from the list rather than updated. */
  removed: string[];
  /** True when something inside the thread the caller has open moved. */
  threadChanged: boolean;
};

export async function readDelta(
  since: number,
  openThreadId: string | null,
): Promise<Delta> {
  assertUnlocked();
  const query = new URLSearchParams({ since: String(since) });
  if (openThreadId) query.set("thread", openThreadId);

  const body = (await call(`/delta?${query}`)) as {
    rev: number;
    threads: ThreadWire[];
    threadChanged: boolean;
  } | null;
  if (!body) return { rev: since, threads: [], removed: [], threadChanged: false };

  const live = body.threads.filter((row) => !row.deleted);
  return {
    rev: body.rev,
    threads: await Promise.all(live.map(openThreadRow)),
    removed: body.threads.filter((row) => row.deleted).map((row) => row.id),
    threadChanged: body.threadChanged,
  };
}

export async function deleteAccount(): Promise<void> {
  await call("/me", { method: "DELETE" });
}

/** Drop the per-session upload memo — used when signing out. */
export function forgetUploads(): void {
  uploaded.clear();
}

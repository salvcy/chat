"use client";

import {
  downloadBlob,
  downloadPayloadBlob,
  uploadBlob,
  uploadPayloadBlob,
} from "./blob";
import { openRecord, sealRecord, toBase64Url } from "./crypto";
import {
  db,
  type ConversationMeta,
  type StoredMessage,
} from "./db";

/**
 * The sync engine: Dexie ⇄ the Worker, over encrypted records.
 *
 * The protocol is deliberately the simplest thing that is actually correct
 * for this workload. Every account has one monotonic revision counter;
 * pulling means "give me everything above N", pushing means "here are rows,
 * stamp them". No vector clocks, no CRDTs, no merge UI — messages are
 * append-only and the only mutable object is a conversation's own metadata
 * being edited by one person across their own devices. There is no
 * concurrent-editor problem here to solve, and inventing one would cost
 * complexity that never pays for itself.
 *
 * Order matters: **pull before push**. Applying the server's view first and
 * then writing local changes over it means a local edit always wins, which
 * is the behaviour someone expects from the device they are typing on.
 *
 * Records are encrypted when the account has a vault key and stored as plain
 * JSON when it does not. Every account with a password has a key, because it
 * falls out of the same derivation as the credential; an account that only
 * ever signed in with Google has none until someone sets a passphrase. The
 * server cannot tell the two apart — a payload is a string either way — so
 * the branch lives here and nowhere else.
 */

const API = "/v1";

/** Matches the Worker's own limit; a larger batch is rejected there. */
const PUSH_BATCH = 100;

/** Safety valve on the pull loop — a runaway page count is a bug, not data. */
const MAX_PULL_PAGES = 500;

/* ------------------------------- envelope ------------------------------ */

/**
 * What actually gets encrypted. The `kind` tag lives *inside* the ciphertext
 * rather than in a server column, so the database cannot tell a conversation
 * from a message — it holds opaque bytes under an opaque id and nothing more.
 */
type Envelope =
  | { kind: "conversation"; data: ConversationMeta }
  | { kind: "message"; data: StoredMessage };

/* --------------------------- heavy attachments ------------------------- */

/**
 * Move image bytes into R2 before a message is encrypted.
 *
 * A generated PNG is megabytes of base64 sitting inside the message, and
 * records are capped at 128KB upstream — one image would fail the whole
 * push. The encrypted record keeps only a blob id, media type, and optional
 * custom-domain URL; the R2 object is itself encrypted in the browser.
 *
 * `blobsStripped` marks that this happened, which is what lets `merge` below
 * avoid overwriting a device's real pixels with a stripped copy of itself.
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
  return value && typeof value === "object"
    ? (value as DialBlobMetadata)
    : {};
}

/**
 * Stable ids make an upload retry idempotent. They also share the message
 * id as a prefix, which lets the Worker erase every attachment for a deleted
 * opaque record without decrypting that record or maintaining a second
 * ownership table.
 */
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

async function blobIdFor(
  messageId: string,
  kind: "generated" | "file",
  partIndex: number,
  assetIndex = 0,
): Promise<string> {
  const safe = await safeIdFor(messageId);
  return `${safe}.${kind === "generated" ? "g" : "f"}.${partIndex}.${assetIndex}`;
}

type PreparedMessage = {
  remote: StrippedMessage;
  /** Same pixels as the local row, now carrying their durable R2 ids. */
  localParts: StoredMessage["parts"];
};

async function prepareBlobs(
  message: StoredMessage,
  key: CryptoKey | null,
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
            (await blobIdFor(message.id, "generated", partIndex, assetIndex));
          // A reference means this exact deterministic object was already
          // uploaded. saveTurn marks the whole transcript dirty on each turn,
          // so uploading referenced images again would be needless R2 writes.
          const uploaded = asset.blobId
            ? { id: blobId, url: asset.blobUrl ?? null }
            : await uploadBlob(blobId, asset.url, key);
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
          : await blobIdFor(message.id, "file", partIndex);
      const uploaded =
        typeof dial.blobId === "string"
          ? { id: blobId, url: typeof dial.blobUrl === "string" ? dial.blobUrl : null }
          : await uploadBlob(blobId, part.url, key);
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
 * Reunite an incoming stripped message with pixels this device already has.
 *
 * Without this, a round trip would erase them: device A uploads a stripped
 * copy, pulls it straight back, and overwrites its own full-fidelity row
 * with the version it just sent.
 */
function unstrip(message: StrippedMessage): StoredMessage {
  const copy = { ...message };
  delete copy.blobsStripped;
  return copy;
}

function merge(
  incoming: StrippedMessage,
  local: StoredMessage | undefined,
): StoredMessage {
  if (!incoming.blobsStripped || !local) return unstrip(incoming);

  const byIndex = new Map(local.parts.map((part, index) => [index, part]));
  const parts = incoming.parts.map((part, index) => {
    const original = byIndex.get(index);
    if (!original || original.type !== part.type) return part;
    if (part.type === "data-image" && original.type === "data-image") {
      return {
        ...part,
        data: {
          ...part.data,
          images: part.data.images.map((asset, assetIndex) => {
            const localAsset = original.data.images[assetIndex];
            return localAsset?.url.startsWith("data:")
              ? { ...asset, url: localAsset.url }
              : asset;
          }),
        },
      };
    }
    if (part.type === "file" && original.type === "file") {
      return original.url.startsWith("data:")
        ? { ...part, url: original.url }
        : part;
    }
    return part;
  });

  return { ...unstrip(incoming), parts };
}

/** Fill R2 references that this device has not downloaded yet. */
async function hydrateBlobs(
  message: StoredMessage,
  key: CryptoKey | null,
): Promise<StoredMessage> {
  const parts: StoredMessage["parts"] = [];

  for (const part of message.parts) {
    if (part.type === "data-image") {
      const images = await Promise.all(
        part.data.images.map(async (asset) => {
          if (asset.url.startsWith("data:") || !asset.blobId) return asset;
          const url = await downloadBlob(
            asset.blobId,
            asset.mediaType,
            key,
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
          key,
          typeof dial.blobUrl === "string" ? dial.blobUrl : undefined,
        );
        parts.push(url ? { ...part, url } : part);
        continue;
      }
    }
    parts.push(part);
  }

  return { ...message, parts };
}

/* -------------------------------- cursor ------------------------------- */

const CURSOR_KEY = "dial:sync-cursor";

/**
 * Keyed by user: signing in as someone else on a shared device must not
 * resume the previous account's cursor and skip their entire history.
 */
function readCursor(userId: string): number {
  try {
    const raw = localStorage.getItem(CURSOR_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { userId?: string; rev?: number };
    return parsed.userId === userId && typeof parsed.rev === "number"
      ? parsed.rev
      : 0;
  } catch {
    return 0;
  }
}

function writeCursor(userId: string, rev: number): void {
  try {
    localStorage.setItem(CURSOR_KEY, JSON.stringify({ userId, rev }));
  } catch {
    // Storage blocked: the next session re-pulls from 0, which is correct,
    // just slower. Records are upserted by id, so replaying is harmless.
  }
}

export function clearCursor(): void {
  try {
    localStorage.removeItem(CURSOR_KEY);
  } catch {
    // Nothing to do.
  }
}

/* ------------------------------- transport ----------------------------- */

/* --------------------------- live connection --------------------------- */

/**
 * This device's realtime socket id, when it has one.
 *
 * It rides along on every push so the hub can skip the socket that caused
 * the revision. Module state rather than a `runSync` argument because the
 * socket's lifetime is owned by `useAccount` and is unrelated to the
 * lifetime of any one reconciliation — threading it through every call site
 * would only let the two drift apart.
 */
let liveConnectionId: string | null = null;

export function setLiveConnectionId(id: string | null): void {
  liveConnectionId = id;
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    // The session cookie is the credential. It is httpOnly, so this code
    // could not read or forge it even if it tried.
    credentials: "same-origin",
    headers: {
      ...init?.headers,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });

  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;

  if (!response.ok) {
    throw new SyncError(
      payload?.error ?? `sync failed (${response.status})`,
      response.status,
    );
  }
  return payload;
}

/** Erase the account and everything in it, server-side. */
export async function deleteAccount(): Promise<void> {
  await call("/me", { method: "DELETE" });
}

/* --------------------------------- pull -------------------------------- */

type PulledRecord = {
  id: string;
  rev: number;
  deleted: boolean;
  payload: string | null;
};

/* ------------------------- oversized payloads -------------------------- */

/**
 * Records that do not fit in D1 spill into R2.
 *
 * Stripping image bytes was only half the problem. A long answer from a
 * reasoning model carries its whole trace, and `sealRecord` base64s the
 * ciphertext — a 4/3 expansion on top of JSON escaping — so the 128KB
 * server limit is really about 90KB of message text. Past that the push
 * failed with "a record exceeded the 128KB payload limit", and because one
 * rejected batch throws, a single long answer stopped the account's entire
 * sync rather than just its own row.
 *
 * The spilled object is the sealed payload verbatim: it is already
 * ciphertext bound to this record id, so the service learns nothing from
 * holding it that it did not already hold in D1.
 */
const PAYLOAD_SPILL_LIMIT = 96 * 1024;

/**
 * `@` is outside base64url and is not `{`, so this can never be mistaken for
 * a sealed record or for the plain JSON a keyless account stores.
 */
const SPILL_PREFIX = "@r2:";

/** Shares the record's prefix, so deleting the record erases this too. */
async function payloadBlobId(recordId: string): Promise<string> {
  return `${await safeIdFor(recordId)}.p.0.0`;
}

/** Read a payload, whichever way this account stores them. */
async function readPayload(
  dek: CryptoKey | null,
  id: string,
  payload: string,
): Promise<Envelope | null> {
  let raw = payload;
  if (payload.startsWith(SPILL_PREFIX)) {
    const spilled = await downloadPayloadBlob(payload.slice(SPILL_PREFIX.length));
    if (!spilled) return null;
    raw = spilled;
  }
  if (dek) return openRecord<Envelope>(dek, id, raw);
  try {
    return JSON.parse(raw) as Envelope;
  } catch {
    return null;
  }
}

/** Write a payload, whichever way this account stores them. */
async function writePayload(
  dek: CryptoKey | null,
  id: string,
  envelope: Envelope,
): Promise<string> {
  const sealed = dek
    ? await sealRecord(dek, id, envelope)
    : JSON.stringify(envelope);
  if (sealed.length <= PAYLOAD_SPILL_LIMIT) return sealed;

  // The object id is derived from the record id, so a retry overwrites the
  // same key rather than leaking a new one. A record that later shrinks back
  // under the limit leaves its object behind until the record is deleted,
  // which clears the whole prefix.
  const blobId = await payloadBlobId(id);
  await uploadPayloadBlob(blobId, sealed);
  return `${SPILL_PREFIX}${blobId}`;
}

export class LockedError extends Error {
  constructor() {
    super("this device needs your password to read your history");
    this.name = "LockedError";
  }
}

async function applyRecords(
  dek: CryptoKey | null,
  records: PulledRecord[],
): Promise<number> {
  let applied = 0;

  for (const record of records) {
    if (record.deleted) {
      await db.transaction(
        "rw",
        db.conversations,
        db.messages,
        db.tombstones,
        async () => {
          await db.conversations.delete(record.id);
          await db.messages.delete(record.id);
          // Our own tombstone for this id is now redundant — the server has
          // it. Leaving it would re-push a deletion forever.
          await db.tombstones.delete(record.id);
        },
      );
      applied++;
      continue;
    }

    if (!record.payload) continue;
    const envelope = await readPayload(dek, record.id, record.payload);
    // Null means the payload could not be read. A single unreadable record
    // is skipped — corruption, or a format from a newer build — but the
    // caller advances the cursor past whatever this pull returned, so
    // *systematically* unreadable records must never get here. That is why
    // a locked account is refused up front rather than quietly producing an
    // empty history whose cursor has already moved past it.
    if (!envelope) continue;

    if (envelope.kind === "conversation") {
      await db.conversations.put({
        ...envelope.data,
        id: record.id,
        dirty: 0,
        rev: record.rev,
      });
    } else {
      const local = await db.messages.get(record.id);
      const merged = merge(envelope.data as StrippedMessage, local);
      await db.messages.put({
        ...(await hydrateBlobs(merged, dek)),
        id: record.id,
        dirty: 0,
        rev: record.rev,
      });
    }
    applied++;
  }

  return applied;
}

/* ------------------------------- the loop ------------------------------ */

/**
 * Drop the local-only bookkeeping before a row is encrypted. These columns
 * describe this device's relationship to the server, not the record, and
 * round-tripping them would let one device's sync state overwrite another's.
 */
function withoutSyncColumns<T extends { dirty?: number; stamp?: number; rev?: number }>(
  row: T,
): T {
  const copy = { ...row };
  delete copy.dirty;
  delete copy.stamp;
  delete copy.rev;
  return copy;
}

export type SyncOutcome = {
  pulled: number;
  pushed: number;
  rev: number;
};

/**
 * One full reconciliation. Safe to call often; it is a no-op when there is
 * nothing on either side.
 */
export async function runSync({
  userId,
  dek,
  encrypted,
}: {
  userId: string;
  /** Null for accounts with no vault key — payloads are plain JSON then. */
  dek: CryptoKey | null;
  /** Whether the account's records are stored encrypted. */
  encrypted: boolean;
}): Promise<SyncOutcome> {
  // Refuse rather than half-work. Syncing an encrypted account without its
  // key would pull ciphertext, fail to read every record, and still advance
  // the cursor past all of it — leaving a signed-in user staring at an empty
  // history that a later unlock would never restore.
  if (encrypted && !dek) throw new LockedError();

  let cursor = readCursor(userId);
  let pulled = 0;

  /* ---- pull ---- */
  for (let page = 0; page < MAX_PULL_PAGES; page++) {
    const response = (await call(`/sync?since=${cursor}`)) as {
      records: PulledRecord[];
      rev: number;
      hasMore: boolean;
    };

    if (response.records.length === 0) {
      cursor = Math.max(cursor, response.rev);
      break;
    }

    pulled += await applyRecords(dek, response.records);
    cursor = response.records[response.records.length - 1].rev;
    writeCursor(userId, cursor);

    if (!response.hasMore) break;
  }

  /* ---- push ---- */
  const dirtyConversations = await db.conversations
    .where("dirty")
    .equals(1)
    .toArray();
  const dirtyMessages = await db.messages.where("dirty").equals(1).toArray();
  const tombstones = await db.tombstones.toArray();

  type Outgoing = {
    body: { id: string; payload?: string; deleted?: boolean };
    commit: () => Promise<void>;
  };

  const outgoing: Outgoing[] = [];

  /*
   * Clearing `dirty` is guarded on the stamp read before the upload. A
   * streaming turn snapshots every 1.2s, so a row being rewritten while its
   * own request is in flight is routine rather than theoretical — and
   * clearing the flag blind would mean the newest version of that message
   * never reaches the server.
   */

  for (const row of dirtyConversations) {
    const data = withoutSyncColumns(row);
    outgoing.push({
      body: {
        id: row.id,
        payload: await writePayload(dek, row.id, {
          kind: "conversation",
          data,
        } satisfies Envelope),
      },
      commit: async () => {
        await db.conversations
          .where("id")
          .equals(row.id)
          .and((current) => current.stamp === row.stamp)
          .modify({ dirty: 0 });
      },
    });
  }

  for (const row of dirtyMessages) {
    const rest = withoutSyncColumns(row);
    const prepared = await prepareBlobs(rest as StoredMessage, dek);
    // Persist successful upload references immediately but leave the row
    // dirty until D1 confirms its encrypted record. If that POST fails, the
    // retry reuses the same R2 object instead of paying for another PUT.
    await db.messages
      .where("id")
      .equals(row.id)
      .and((current) => current.stamp === row.stamp)
      .modify((current) => {
        current.parts = prepared.localParts;
      });
    outgoing.push({
      body: {
        id: row.id,
        payload: await writePayload(dek, row.id, {
          kind: "message",
          data: prepared.remote,
        } satisfies Envelope),
      },
      commit: async () => {
        await db.messages
          .where("id")
          .equals(row.id)
          .and((current) => current.stamp === row.stamp)
          .modify((current) => {
            current.parts = prepared.localParts;
            current.dirty = 0;
          });
      },
    });
  }

  for (const stone of tombstones) {
    outgoing.push({
      body: { id: stone.id, deleted: true },
      commit: async () => {
        await db.tombstones.delete(stone.id);
      },
    });
  }

  let pushed = 0;
  for (let i = 0; i < outgoing.length; i += PUSH_BATCH) {
    const batch = outgoing.slice(i, i + PUSH_BATCH);
    const response = (await call("/sync", {
      method: "POST",
      body: JSON.stringify({
        records: batch.map((item) => item.body),
        client: liveConnectionId,
      }),
    })) as { rev: number; applied: number };

    // Only clear local flags once the server has confirmed the batch.
    for (const item of batch) await item.commit();
    pushed += response.applied;
    cursor = response.rev;
  }

  writeCursor(userId, cursor);
  return { pulled, pushed, rev: cursor };
}

/** Everything local, for the "sign out and wipe" path. */
export async function clearLocalData(): Promise<void> {
  await db.transaction(
    "rw",
    db.conversations,
    db.messages,
    db.tombstones,
    async () => {
      await db.conversations.clear();
      await db.messages.clear();
      await db.tombstones.clear();
    },
  );
  clearCursor();
}

/** Re-upload everything — used after attaching an existing vault. */
export async function markAllDirty(): Promise<void> {
  await db.transaction("rw", db.conversations, db.messages, async () => {
    await db.conversations.toCollection().modify({ dirty: 1 });
    await db.messages.toCollection().modify({ dirty: 1 });
  });
}

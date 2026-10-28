"use client";

/**
 * Browser-side R2 blob transport.
 *
 * R2 never receives an image it can read for an encrypted account. Pixels
 * are packed into a tiny versioned envelope and AES-GCM encrypted with the
 * same non-extractable key as chat records before they leave the browser.
 * The blob id is authenticated as AAD, so moving ciphertext to another key
 * makes decryption fail instead of displaying the wrong image.
 *
 * Accounts without a vault key use the same envelope with a plaintext mode.
 * That preserves the existing `encryption: none` contract for any future
 * OAuth account without pretending it is end-to-end encrypted.
 */

import { apiFetch } from "./api";

const API = "/v1/blobs";
const MAGIC = new Uint8Array([0x44, 0x49, 0x41, 0x4c]); // DIAL
const VERSION = 1;
const MODE_PLAIN = 0;
const MODE_AES_GCM = 1;
const IV_BYTES = 12;
const HEADER_BYTES = MAGIC.length + 2;
const MAX_PLAINTEXT_BYTES = 10 * 1024 * 1024;

const encoder = new TextEncoder();

/**
 * Blob ids are two path segments — `<threadId>/<messageId>.<kind>.<n>.<m>` —
 * because keying objects under their thread is what lets a deleted
 * conversation be erased with one R2 prefix delete.
 *
 * That slash has to survive into the URL as a slash. Running
 * `encodeURIComponent` over the whole id would send `%2F`, which proxies and
 * origins are free to normalise or reject, so each segment is encoded on its
 * own and the separator is written literally.
 */
function blobPath(blobId: string): string {
  return blobId.split("/").map(encodeURIComponent).join("/");
}

export type UploadedBlob = {
  id: string;
  /** Present once the R2 bucket has a public custom domain. */
  url: string | null;
};

export class BlobTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BlobTransportError";
  }
}

function aad(blobId: string): Uint8Array {
  return encoder.encode(`dial/blob/v1:${blobId}`);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function hasHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= HEADER_BYTES &&
    MAGIC.every((byte, index) => bytes[index] === byte) &&
    bytes[MAGIC.length] === VERSION
  );
}

function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(",");
  if (comma < 0 || !url.slice(0, comma).includes(";base64")) {
    throw new BlobTransportError("image data was not base64 encoded", 400);
  }
  const binary = atob(url.slice(comma + 1));
  if (binary.length > MAX_PLAINTEXT_BYTES) {
    throw new BlobTransportError("image exceeded the 10 MB sync limit", 413);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function pack(
  blobId: string,
  plaintext: Uint8Array,
  key: CryptoKey | null,
): Promise<Uint8Array> {
  if (!key) {
    const packed = new Uint8Array(HEADER_BYTES + plaintext.length);
    packed.set(MAGIC, 0);
    packed[MAGIC.length] = VERSION;
    packed[MAGIC.length + 1] = MODE_PLAIN;
    packed.set(plaintext, HEADER_BYTES);
    return packed;
  }

  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: arrayBuffer(iv),
      additionalData: arrayBuffer(aad(blobId)),
    },
    key,
    arrayBuffer(plaintext),
  );
  const packed = new Uint8Array(
    HEADER_BYTES + IV_BYTES + ciphertext.byteLength,
  );
  packed.set(MAGIC, 0);
  packed[MAGIC.length] = VERSION;
  packed[MAGIC.length + 1] = MODE_AES_GCM;
  packed.set(iv, HEADER_BYTES);
  packed.set(new Uint8Array(ciphertext), HEADER_BYTES + IV_BYTES);
  return packed;
}

async function unpack(
  blobId: string,
  packed: Uint8Array,
  key: CryptoKey | null,
): Promise<Uint8Array> {
  if (!hasHeader(packed)) {
    throw new BlobTransportError("image blob used an unknown format", 422);
  }
  const mode = packed[MAGIC.length + 1];
  if (mode === MODE_PLAIN) return packed.slice(HEADER_BYTES);
  if (mode !== MODE_AES_GCM || !key) {
    throw new BlobTransportError("this device cannot decrypt that image", 423);
  }
  if (packed.length <= HEADER_BYTES + IV_BYTES) {
    throw new BlobTransportError("image blob was incomplete", 422);
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: arrayBuffer(packed.slice(HEADER_BYTES, HEADER_BYTES + IV_BYTES)),
        additionalData: arrayBuffer(aad(blobId)),
      },
      key,
      arrayBuffer(packed.slice(HEADER_BYTES + IV_BYTES)),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new BlobTransportError("image blob could not be decrypted", 422);
  }
}

async function errorFrom(response: Response): Promise<BlobTransportError> {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return new BlobTransportError(
    payload?.error ?? `image sync failed (${response.status})`,
    response.status,
  );
}

/**
 * Store one oversized record payload in R2 and read it back.
 *
 * These take the payload *after* `sealRecord` has run, so for an encrypted
 * account the bytes handed to R2 are already AES-GCM ciphertext bound to the
 * record id — encrypting the envelope a second time would buy nothing. For an
 * account with no vault key it is the same plain JSON D1 would have held, so
 * neither mode changes what the service can read. The plaintext envelope is
 * kept only so every object in the bucket has one recognisable shape.
 */
export async function uploadPayloadBlob(
  blobId: string,
  payload: string,
): Promise<void> {
  const packed = await pack(blobId, encoder.encode(payload), null);
  const response = await apiFetch(`${API}/${blobPath(blobId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: arrayBuffer(packed),
  });
  if (!response.ok) throw await errorFrom(response);
}

export async function downloadPayloadBlob(
  blobId: string,
): Promise<string | null> {
  const response = await apiFetch(`${API}/${blobPath(blobId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await errorFrom(response);
  const packed = new Uint8Array(await response.arrayBuffer());
  return new TextDecoder().decode(await unpack(blobId, packed, null));
}

/** The bytes behind a local `data:` or `blob:` URL. */
async function localBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith("blob:")) {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    if (bytes.length > MAX_PLAINTEXT_BYTES) {
      throw new BlobTransportError("image exceeded the 10 MB sync limit", 413);
    }
    return bytes;
  }
  return dataUrlBytes(url);
}

/**
 * A `blob:` URL as a `data:` URL, for anything that leaves this tab — a
 * request to OpenRouter, an export. Object URLs mean nothing anywhere else.
 * Anything else comes back unchanged.
 */
export async function inlineUrl(url: string): Promise<string> {
  if (!url.startsWith("blob:")) return url;
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read an attachment"));
    reader.readAsDataURL(blob);
  });
}

/** Encrypt (when possible) and upload one local data or object URL. PUT is idempotent. */
export async function uploadBlob(
  blobId: string,
  url: string,
  key: CryptoKey | null,
): Promise<UploadedBlob> {
  const packed = await pack(blobId, await localBytes(url), key);
  const response = await apiFetch(`${API}/${blobPath(blobId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: arrayBuffer(packed),
  });
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as UploadedBlob;
}

async function fetchPacked(blobId: string, publicUrl?: string): Promise<Response> {
  if (publicUrl) {
    try {
      const direct = await fetch(publicUrl, { mode: "cors" });
      if (direct.ok) return direct;
    } catch {
      // A custom domain may still be provisioning. The authenticated Worker
      // route remains the correctness fallback until it is ready.
    }
  }
  return apiFetch(`${API}/${blobPath(blobId)}`);
}

/* ------------------------------ display cache ----------------------------- */

/**
 * Downloaded images and documents, held as object URLs.
 *
 * These used to come back as `data:` URLs: the bytes base64'd into a
 * JavaScript string (4/3 of the size), which the `<img>` then copied into its
 * own attribute — about 2.7 times the file held per image, and re-downloaded
 * and decrypted every time its thread was opened. A `Blob` holds the bytes
 * once, outside the JavaScript heap, and the URL handed around is fifty
 * characters.
 *
 * Kept by blob id and the message revision it was read at (a regenerated
 * image reuses its id), within a byte budget, least recently used first —
 * except the open thread's, which are on screen and never revoked.
 */
type Held = { url: string; bytes: number; thread: string; used: number };
const held = new Map<string, Held>();
const downloading = new Map<string, Promise<string | null>>();
let heldBytes = 0;
let pinnedThread: string | null = null;
const retainedThreads = new Map<string, number>();

/**
 * How much of other threads' media to keep for an instant reopen: 64MB on a
 * machine reporting 8GB or more, 24MB anywhere else — a phone, or a browser
 * that does not say (`deviceMemory` is Chromium-only).
 */
function heldBudget(): number {
  const memory = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
  return ((memory ?? 0) >= 8 ? 64 : 24) * 1024 * 1024;
}

function trimHeld(): void {
  const budget = heldBudget();
  if (heldBytes <= budget) return;
  const oldest = [...held.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [key, entry] of oldest) {
    if (heldBytes <= budget) break;
    if (entry.thread === pinnedThread || retainedThreads.has(entry.thread)) continue;
    URL.revokeObjectURL(entry.url);
    held.delete(key);
    heldBytes -= entry.bytes;
  }
}

/** The thread on screen: its blobs stay, whatever the budget says. */
export function pinBlobThread(thread: string | null): void {
  pinnedThread = thread;
  trimHeld();
}

/** A mounted chat may still need its media for a request, save, or draft. */
export function retainBlobThread(thread: string): () => void {
  retainedThreads.set(thread, (retainedThreads.get(thread) ?? 0) + 1);
  return () => {
    const count = (retainedThreads.get(thread) ?? 1) - 1;
    if (count > 0) retainedThreads.set(thread, count);
    else retainedThreads.delete(thread);
    trimHeld();
  };
}

/** Revoke everything — signing out. */
export function forgetDisplayedBlobs(): void {
  for (const entry of held.values()) URL.revokeObjectURL(entry.url);
  held.clear();
  heldBytes = 0;
}

/** Download, authenticate and decrypt a blob; an object URL to display it. */
export async function displayBlob(
  blobId: string,
  mediaType: string,
  key: CryptoKey | null,
  publicUrl: string | undefined,
  version: number,
): Promise<string | null> {
  const cacheKey = `${blobId}#${version}`;
  const hit = held.get(cacheKey);
  if (hit) {
    hit.used = Date.now();
    return hit.url;
  }
  const running = downloading.get(cacheKey);
  if (running) return running;

  const task = (async () => {
    const response = await fetchPacked(blobId, publicUrl);
    if (response.status === 404) return null;
    if (!response.ok) throw await errorFrom(response);
    const plaintext = await unpack(blobId, new Uint8Array(await response.arrayBuffer()), key);
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new BlobTransportError("image exceeded the 10 MB sync limit", 413);
    }
    const url = URL.createObjectURL(new Blob([arrayBuffer(plaintext)], { type: mediaType }));
    held.set(cacheKey, {
      url,
      bytes: plaintext.length,
      thread: blobId.split("/")[0],
      used: Date.now(),
    });
    heldBytes += plaintext.length;
    trimHeld();
    return url;
  })();
  downloading.set(cacheKey, task);
  try {
    return await task;
  } finally {
    downloading.delete(cacheKey);
  }
}

/* ------------------------------- the account's files ----------------------------- */

/** One stored file, as the storage view lists it — nothing sealed in here. */
export type StoredFile = {
  id: string;
  /** Ciphertext size in R2, which is what the quota counts. */
  size: number;
  uploaded: number;
  /** `g` blobs are images a model made; `f` blobs are what the person attached. */
  kind: "generated" | "attachment";
  threadId: string;
};

/**
 * Every image and attachment the account holds, newest first.
 *
 * The listing is metadata the server already has — ids, sizes, times — and
 * says nothing about what a file is. The type and the pixels come from
 * `readStoredBlob`, in this tab, with the vault key.
 */
export async function listStoredBlobs(): Promise<StoredFile[]> {
  const files: StoredFile[] = [];
  let cursor: string | null = null;
  do {
    const response = await apiFetch(
      cursor ? `${API}?cursor=${encodeURIComponent(cursor)}` : API,
    );
    if (!response.ok) throw await errorFrom(response);
    const page = (await response.json()) as {
      files: Array<{ id: string; size: number; uploaded: number }>;
      cursor: string | null;
    };
    for (const file of page.files) {
      files.push({
        ...file,
        kind: /\.g\.\d+\.\d+$/.test(file.id) ? "generated" : "attachment",
        threadId: file.id.split("/")[0],
      });
    }
    cursor = page.cursor;
  } while (cursor && files.length < 10_000);
  return files.sort((a, b) => b.uploaded - a.uploaded);
}

/**
 * What a decrypted file is, from its first bytes.
 *
 * The media type is part of the sealed message, not the object, so the
 * storage view — which reads objects, not messages — asks the bytes. Only
 * the formats this app accepts or generates are recognised.
 */
export function sniffMediaType(bytes: Uint8Array): string {
  const at = (offset: number, ...expected: number[]) =>
    expected.every((byte, i) => bytes[offset + i] === byte);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x68, 0x65, 0x69, 0x63))) {
    return at(8, 0x61, 0x76, 0x69, 0x66) ? "image/avif" : "image/heic";
  }
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  return "application/octet-stream";
}

/** Download, authenticate and decrypt one stored file, with its type. */
export async function readStoredBlob(
  blobId: string,
  key: CryptoKey | null,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const response = await fetchPacked(blobId);
  if (!response.ok) throw await errorFrom(response);
  const bytes = await unpack(blobId, new Uint8Array(await response.arrayBuffer()), key);
  return { bytes, mediaType: sniffMediaType(bytes) };
}

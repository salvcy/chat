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

const API = "/v1/blobs";
const MAGIC = new Uint8Array([0x44, 0x49, 0x41, 0x4c]); // DIAL
const VERSION = 1;
const MODE_PLAIN = 0;
const MODE_AES_GCM = 1;
const IV_BYTES = 12;
const HEADER_BYTES = MAGIC.length + 2;
const MAX_PLAINTEXT_BYTES = 10 * 1024 * 1024;

const encoder = new TextEncoder();

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

function toDataUrl(bytes: Uint8Array, mediaType: string): string {
  // Spreading a multi-megabyte Uint8Array over String.fromCharCode overflows
  // the call stack. Chunking is both faster and safe on Safari.
  const chunks: string[] = [];
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + size)),
    );
  }
  return `data:${mediaType};base64,${btoa(chunks.join(""))}`;
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
  const response = await fetch(`${API}/${encodeURIComponent(blobId)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
    body: arrayBuffer(packed),
  });
  if (!response.ok) throw await errorFrom(response);
}

export async function downloadPayloadBlob(
  blobId: string,
): Promise<string | null> {
  const response = await fetch(`${API}/${encodeURIComponent(blobId)}`, {
    credentials: "same-origin",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await errorFrom(response);
  const packed = new Uint8Array(await response.arrayBuffer());
  return new TextDecoder().decode(await unpack(blobId, packed, null));
}

/** Encrypt (when possible) and upload one local data URL. PUT is idempotent. */
export async function uploadBlob(
  blobId: string,
  dataUrl: string,
  key: CryptoKey | null,
): Promise<UploadedBlob> {
  const packed = await pack(blobId, dataUrlBytes(dataUrl), key);
  const response = await fetch(`${API}/${encodeURIComponent(blobId)}`, {
    method: "PUT",
    credentials: "same-origin",
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
  return fetch(`${API}/${encodeURIComponent(blobId)}`, {
    credentials: "same-origin",
  });
}

/** Download, authenticate, and reconstruct a browser-displayable data URL. */
export async function downloadBlob(
  blobId: string,
  mediaType: string,
  key: CryptoKey | null,
  publicUrl?: string,
): Promise<string | null> {
  const response = await fetchPacked(blobId, publicUrl);
  if (response.status === 404) return null;
  if (!response.ok) throw await errorFrom(response);
  const packed = new Uint8Array(await response.arrayBuffer());
  const plaintext = await unpack(blobId, packed, key);
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new BlobTransportError("image exceeded the 10 MB sync limit", 413);
  }
  return toDataUrl(plaintext, mediaType);
}

"use client";

/**
 * Vault cryptography.
 *
 * One token does three jobs. It is the account identifier, the credential
 * presented to the server, and the root of the encryption key — and because
 * all three are derived from it with one-way functions, the server can
 * verify the second without ever being able to compute the third.
 *
 *     token ──HKDF("auth")──▶ authSecret ──SHA-256──▶ verifier   (server sees)
 *       └────HKDF("vault")──▶ dek                                (never sent)
 *
 * That is the whole privacy claim, and it is worth stating what it does and
 * does not cover: the server cannot read conversations. OpenRouter and the
 * upstream model provider still see every prompt in the clear, because
 * somebody has to answer it.
 *
 * ## Why HKDF and not Argon2/PBKDF2
 *
 * Key stretching exists to make *guessing* expensive, and it is the right
 * answer for a human-chosen password. This token is 240 bits of
 * `crypto.getRandomValues` output — there is nothing to guess, and no amount
 * of stretching improves a secret that is already beyond brute force.
 * Running 600k PBKDF2 iterations over it would burn a second of the user's
 * CPU to add exactly zero security. HKDF is the correct primitive for
 * expanding one high-entropy secret into several independent keys.
 *
 * The same fact is what keeps the Worker cheap: it verifies by hashing a
 * high-entropy value once, so a request costs a single SHA-256 rather than
 * the scrypt pass a password would have required.
 */

/**
 * Crockford base32: no I, L, O or U, so a handwritten token cannot be
 * misread into a different valid one. This token is the only thing standing
 * between someone and their history, so people will write it down.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 30 bytes → exactly 48 base32 characters, no padding, 240 bits. */
const TOKEN_BYTES = 30;
const GROUP = 8;

/**
 * Domain separation. Changing this invalidates every existing token, so it
 * carries a version — a future migration mints v2 keys without silently
 * producing different ones for the same token.
 *
 * It is a label, not the app's address. The app moved to chat.belayet.app
 * and this string did not, and must not: every existing key was derived
 * with it.
 */
const SALT = "chat.belayet.co/vault/v1";

/* ------------------------------- encoding ------------------------------ */

function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Crockford's decoding rules: case-insensitive, and I/L→1, O→0. */
export function normalizeToken(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

function group(raw: string): string {
  return (raw.match(new RegExp(`.{1,${GROUP}}`, "g")) ?? []).join("-");
}

/** A fresh vault token, grouped for transcription. */
export function createToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return group(toBase32(bytes));
}

/** Display form of a token the user typed, so it matches what we generate. */
export function formatToken(input: string): string {
  return group(normalizeToken(input));
}

export function isValidToken(input: string): boolean {
  const normalized = normalizeToken(input);
  return (
    normalized.length === Math.ceil((TOKEN_BYTES * 8) / 5) &&
    [...normalized].every((c) => ALPHABET.includes(c))
  );
}

/* ------------------------------- base64url ----------------------------- */

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------ derivation ----------------------------- */

async function hkdf(
  token: string,
  info: string,
  bytes: number,
): Promise<ArrayBuffer> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    "HKDF",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(SALT),
      info: new TextEncoder().encode(info),
    },
    material,
    bytes * 8,
  );
}

export type VaultKeys = {
  /** Presented to the server as a bearer credential. */
  authSecret: string;
  /** sha256(authSecret) — what the server stores. Sent once, at signup. */
  verifier: string;
  /** AES-GCM key for record payloads. Non-extractable; never leaves here. */
  dek: CryptoKey;
};

export async function deriveKeys(rawToken: string): Promise<VaultKeys> {
  const token = normalizeToken(rawToken);

  const authBits = await hkdf(token, "auth", 32);
  const authSecret = toBase64Url(authBits);
  // The server hashes exactly the string it receives, so the verifier must
  // be computed over the encoded form rather than the raw bytes.
  const verifier = hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(authSecret),
    ),
  );

  const dekBits = await hkdf(token, "vault", 32);
  const dek = await crypto.subtle.importKey(
    "raw",
    dekBits,
    { name: "AES-GCM" },
    // Non-extractable: nothing in this app has any reason to read the key
    // back out, and refusing makes it unreachable from injected script.
    false,
    ["encrypt", "decrypt"],
  );

  return { authSecret, verifier, dek };
}

/* ------------------------------ record I/O ----------------------------- */

const IV_BYTES = 12;

/**
 * Encrypt one record.
 *
 * `recordId` is bound in as additional authenticated data, so ciphertext
 * cannot be moved from one row to another — a server that swapped two
 * payloads would produce a decryption failure rather than a plausible
 * message under the wrong id. The id is client-minted, which is why it is
 * safe to authenticate against; a server-supplied value would let the
 * server choose what we verify.
 */
export async function sealRecord(
  dek: CryptoKey,
  recordId: string,
  value: unknown,
): Promise<string> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(recordId),
    },
    dek,
    new TextEncoder().encode(JSON.stringify(value)),
  );

  const packed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), IV_BYTES);
  return toBase64Url(packed);
}

/** Decrypt one record. Returns null on any failure — never throws upward. */
export async function openRecord<T>(
  dek: CryptoKey,
  recordId: string,
  payload: string,
): Promise<T | null> {
  try {
    const packed = fromBase64Url(payload);
    if (packed.length <= IV_BYTES) return null;
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: packed.slice(0, IV_BYTES),
        additionalData: new TextEncoder().encode(recordId),
      },
      dek,
      packed.slice(IV_BYTES),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    // A wrong key, a corrupted row, or a payload written by a future
    // format. All three mean "this record is not readable here", and none
    // of them should be able to take the sync loop down.
    return null;
  }
}

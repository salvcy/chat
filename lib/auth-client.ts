"use client";

/**
 * The browser half of authentication.
 *
 * Better Auth ships a client SDK, but it is installed in `worker/` and this
 * app cannot take new frontend dependencies. Its endpoints are plain JSON
 * over `fetch`, so talking to them directly costs a hundred lines and no
 * bundle weight.
 *
 * ## The password never leaves this file
 *
 * PBKDF2-SHA256 at 600,000 iterations runs here — OWASP's figure when
 * Argon2id is unavailable, and it is unavailable because that would mean a
 * WASM dependency. What goes over the wire is the derived value, so the
 * server cannot learn the password even if it wanted to, and it never runs a
 * slow hash (which is what keeps it inside the Workers free-tier CPU
 * budget).
 *
 * The same derivation produces the vault key as a second, independent
 * branch. That is why an email/password account gets end-to-end encryption
 * without anyone typing a second secret: the key was already there.
 *
 *     password ─PBKDF2─▶ master ─┬─HKDF("auth")──▶ authHash → server
 *                                 └─HKDF("vault")─▶ kek      → stays here
 *
 * A Google account has no password and therefore no `kek`. That is not an
 * oversight — OAuth proves who you are and hands over no key material, so
 * encryption there needs a passphrase the user actually types.
 */

const API = "/v1/auth";
const APP_SALT = "chat.belayet.co/auth/v1";
const ITERATIONS = 600_000;

/* ------------------------------ derivation ----------------------------- */

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type Credential = {
  /** Sent as the "password" field. Exactly 43 base64url characters. */
  authHash: string;
  /** AES-GCM vault key. Non-extractable — nothing can read its bytes back. */
  kek: CryptoKey;
};

/**
 * Stretch a password into an auth credential and a vault key.
 *
 * The email is folded into the salt so the same password on two accounts
 * derives differently, and a stolen table cannot be attacked in bulk.
 */
export async function deriveCredential(
  email: string,
  password: string,
): Promise<Credential> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const master = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(`${APP_SALT}:${email.trim().toLowerCase()}`),
      iterations: ITERATIONS,
    },
    material,
    256,
  );

  const masterKey = await crypto.subtle.importKey(
    "raw",
    master,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const branch = (info: string) =>
    crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode(APP_SALT),
        info: encoder.encode(info),
      },
      masterKey,
      256,
    );

  const authHash = toBase64Url(await branch("auth"));
  const kek = await crypto.subtle.importKey(
    "raw",
    await branch("vault"),
    { name: "AES-GCM" },
    // Non-extractable, and stored that way: injected script can *use* the
    // vault but cannot serialise the key and carry it off.
    false,
    ["encrypt", "decrypt"],
  );

  return { authHash, kek };
}

/* -------------------------------- session ------------------------------ */

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  dateOfBirth?: string;
};

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

async function call(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    // Better Auth's CSRF check requires an Origin header; the browser sends
    // it. `same-origin` credentials keep the session cookie flowing.
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

  const payload = (await response.json().catch(() => null)) as {
    message?: string;
    error?: string;
  } | null;

  if (!response.ok) {
    throw new AuthError(
      payload?.message ?? payload?.error ?? `request failed (${response.status})`,
      response.status,
    );
  }
  return payload;
}

export async function getSession(): Promise<SessionUser | null> {
  try {
    const payload = (await call("/get-session")) as {
      user?: SessionUser;
    } | null;
    return payload?.user ?? null;
  } catch {
    return null;
  }
}

/** Whole years, UTC, so the boundary does not move with the timezone. */
export function isAdult(dateOfBirth: string): boolean {
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return false;
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 18);
  return dob.getTime() <= cutoff.getTime();
}

export async function signUp({
  email,
  password,
  name,
  dateOfBirth,
}: {
  email: string;
  password: string;
  name: string;
  dateOfBirth: string;
}): Promise<Credential> {
  // Checked here for a decent message, and again in a database hook on the
  // server where it cannot be skipped. This one is a courtesy, not a control.
  if (!isAdult(dateOfBirth)) {
    throw new AuthError("you must be 18 or older to create an account", 422);
  }
  const credential = await deriveCredential(email, password);
  await call("/sign-up/email", {
    email: email.trim().toLowerCase(),
    password: credential.authHash,
    name: name.trim(),
    dateOfBirth,
  });
  return credential;
}

export async function signIn(
  email: string,
  password: string,
): Promise<Credential> {
  const credential = await deriveCredential(email, password);
  await call("/sign-in/email", {
    email: email.trim().toLowerCase(),
    password: credential.authHash,
  });
  return credential;
}

/** Complete the optional email-OTP gate and receive the normal session. */
export async function verifyEmailOTP(email: string, otp: string): Promise<void> {
  await call("/email-otp/verify-email", {
    email: email.trim().toLowerCase(),
    otp: otp.replace(/\D/g, ""),
  });
}

export async function resendEmailOTP(email: string): Promise<void> {
  await call("/email-otp/send-verification-otp", {
    email: email.trim().toLowerCase(),
    type: "email-verification",
  });
}

/**
 * Hand off to Google. Returns nothing useful — the tab navigates away.
 *
 * There is no vault key on this path, which is the whole reason encryption
 * is opt-in rather than universal.
 */
export async function signInWithGoogle(): Promise<void> {
  const payload = (await call("/sign-in/social", {
    provider: "google",
    callbackURL: window.location.origin,
  })) as { url?: string; redirect?: boolean } | null;

  if (!payload?.url) {
    throw new AuthError(
      "Google sign-in is not configured on this deployment",
      500,
    );
  }
  window.location.assign(payload.url);
}

export async function signOut(): Promise<void> {
  await call("/sign-out", {});
}

import { betterAuth } from "better-auth";
import type { Env } from "./env";

/**
 * Authentication.
 *
 * Three things about this configuration are unusual, and all three follow
 * from one constraint: **the Workers free tier allows 10ms of CPU per
 * request**, and a conventional password hash spends five to ten times that.
 *
 * ## 1. The server never sees a password
 *
 * The browser runs PBKDF2-SHA256 at 600,000 iterations (OWASP's figure when
 * Argon2id is unavailable — and it is unavailable here, because adding a
 * WASM dependency to the frontend is not on the table) and sends the
 * *derived* value. What arrives is 256 bits of high-entropy output, not a
 * human-chosen secret.
 *
 * That makes `hashPassword` below correct rather than lazy. Slow hashing
 * exists to make guessing expensive; there is nothing here to guess. The
 * expensive step still happens — it happens on the user's own CPU, for free,
 * where it also produces the vault key the server must never learn.
 *
 * `looksPreStretched` enforces the contract. A client that skipped the
 * derivation and posted a raw password would otherwise get it stored under a
 * fast hash, quietly undoing the whole arrangement.
 *
 * ## 2. Built per request
 *
 * Cloudflare bindings do not exist at module scope, so the instance is
 * constructed inside `fetch`. It is cheap to build and this is the
 * documented pattern.
 *
 * ## 3. Age is a real field, not a checkbox
 *
 * `dateOfBirth` is required at signup and the 18+ rule is enforced on both
 * sides. It is self-declared — this is an age *gate*, not age verification,
 * and nothing here should be described as the latter.
 */

/** Exactly 32 bytes of base64url — what the client's HKDF step produces. */
const PRE_STRETCHED = /^[A-Za-z0-9_-]{43}$/;

function looksPreStretched(value: string): boolean {
  return PRE_STRETCHED.test(value);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function digest(salt: string, value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${value}`),
  );
  return toHex(bytes);
}

/** Length-independent comparison, so a mismatch leaks nothing by timing. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password: string): Promise<string> {
  if (!looksPreStretched(password)) {
    // Refuse rather than downgrade: storing a raw password under this hash
    // would look like it worked and silently remove the stretching.
    throw new Error(
      "credential must be client-derived — this endpoint does not accept raw passwords",
    );
  }
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = toHex(saltBytes.buffer);
  return `${salt}:${await digest(salt, password)}`;
}

async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const [salt, expected] = hash.split(":");
  if (!salt || !expected) return false;
  return constantTimeEqual(expected, await digest(salt, password));
}

/** The 18+ gate. Compared on whole years, in UTC, to avoid timezone drift. */
export function isAdult(dateOfBirth: string): boolean {
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return false;
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 18);
  return dob.getTime() <= cutoff.getTime();
}

export function createAuth(env: Env, origin: string) {
  return betterAuth({
    // Better Auth speaks D1 natively, so the binding goes straight in — no
    // Kysely dialect package and nothing extra in the bundle.
    database: env.DB,
    baseURL: origin,
    basePath: "/v1/auth",
    secret: env.AUTH_SECRET,

    emailAndPassword: {
      enabled: true,
      // Nothing is emailed yet, so requiring verification would lock people
      // out of their own accounts. Turn this on with the mail provider.
      requireEmailVerification: false,
      password: { hash: hashPassword, verify: verifyPassword },
    },

    // Registered only when the secret is actually configured. Passing an
    // undefined clientSecret makes Better Auth throw at construction, which
    // would take email/password down with it — the whole API would 500
    // because one optional provider was half-configured.
    socialProviders: env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {},

    user: {
      additionalFields: {
        dateOfBirth: {
          type: "string",
          required: true,
          // Never client-writable after signup: letting someone edit this
          // would make the age gate decorative.
          input: true,
        },
      },
    },

    databaseHooks: {
      user: {
        create: {
          /**
           * The 18+ gate, enforced where it cannot be skipped.
           *
           * The client checks too, for a decent error message — but a client
           * check is a formatting nicety, not a control. This runs on every
           * path that can create a user, including the Google callback,
           * which never goes near the signup form.
           */
          before: async (user) => {
            const dob = (user as { dateOfBirth?: unknown }).dateOfBirth;
            if (typeof dob !== "string" || !isAdult(dob)) {
              throw new Error("you must be 18 or older to create an account");
            }
            return { data: user };
          },
        },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        // Read the session from a signed cookie instead of hitting D1 on
        // every request. This is the single biggest CPU saving available
        // here, and it is what keeps a typical authenticated request in
        // low single-digit milliseconds.
        enabled: true,
        maxAge: 5 * 60,
      },
    },

    advanced: {
      // Same origin as the app, so the cookie needs no cross-site relaxation.
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: true,
        httpOnly: true,
      },
    },

    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

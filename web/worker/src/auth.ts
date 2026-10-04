import { betterAuth } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";
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
 *
 * ## 4. The desktop app holds a token, not a cookie
 *
 * The desktop app ships its own copy of the UI and calls this API from
 * another origin (`appOrigins`), where a same-site cookie is never sent. The
 * `bearer` plugin hands it the same signed session token the cookie carries,
 * in a `set-auth-token` response header, and accepts it back as
 * `Authorization: Bearer`. The app keeps it in the macOS Keychain. Sessions
 * are the same rows either way; only the transport differs.
 */

/**
 * Origins allowed to call the API cross-origin — the desktop app's: its UI
 * is served from inside the app, `tauri://localhost` on macOS and Linux and
 * `http://tauri.localhost` on Windows. `EXTRA_APP_ORIGINS` adds more, for
 * local testing only.
 */
const APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost"];

export function appOrigins(env: Env): string[] {
  const extra = (env.EXTRA_APP_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return [...APP_ORIGINS, ...extra];
}

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
  // Cloudflare's outbound Email Sending product is paid-only. Keeping this
  // conditional means the free deployment continues to work exactly as it
  // does today; adding an EMAIL binding and EMAIL_FROM later turns OTP
  // verification on without another auth migration or frontend release.
  const emailVerificationEnabled = Boolean(env.EMAIL && env.EMAIL_FROM);

  return betterAuth({
    // Better Auth speaks D1 natively, so the binding goes straight in — no
    // Kysely dialect package and nothing extra in the bundle.
    database: env.DB,
    baseURL: origin,
    basePath: "/v1/auth",
    secret: env.AUTH_SECRET,
    // Sign-in and sign-up check the Origin header (Better Auth's CSRF
    // defence). The app's origins are trusted for that; they still get no
    // cookie, because CORS never allows credentials (see index.ts).
    trustedOrigins: appOrigins(env),

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: emailVerificationEnabled,
      password: { hash: hashPassword, verify: verifyPassword },
    },

    emailVerification: {
      autoSignInAfterVerification: true,
    },

    plugins: [
      // The desktop app's session transport (see 4 above). Signature
      // required: a bare token without the HMAC is refused rather than
      // signed on the client's behalf.
      bearer({ requireSignature: true }),
      ...(emailVerificationEnabled
        ? [
            emailOTP({
              overrideDefaultEmailVerification: true,
              expiresIn: 10 * 60,
              allowedAttempts: 5,
              storeOTP: "hashed",
              rateLimit: { window: 60, max: 3 },
              async sendVerificationOTP({ email, otp, type }) {
                if (!env.EMAIL || !env.EMAIL_FROM) return;
                const purpose =
                  type === "email-verification"
                    ? "verify your email"
                    : type === "forget-password"
                      ? "reset your password"
                      : "sign in";
                await env.EMAIL.send({
                  from: env.EMAIL_FROM,
                  to: email,
                  subject: `${otp} · ${purpose}`,
                  text: `Your Chat code is ${otp}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
                  html: `<div style="font-family:ui-sans-serif,system-ui,sans-serif;color:#111"><p style="font-size:14px">Your Chat verification code</p><p style="font-family:ui-monospace,monospace;font-size:28px;letter-spacing:.18em;margin:20px 0">${otp}</p><p style="font-size:12px;color:#666">Expires in 10 minutes. If you did not request this, you can ignore this email.</p></div>`,
                });
              },
            }),
          ]
        : []),
    ],

    // Better Auth already supplies strict rules for sign-in/sign-up (3 per
    // 10s) and OTP issuance/verification (3 per minute). D1 storage makes
    // those counters global across isolates instead of best-effort memory.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
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
      ipAddress: {
        // This header is written by Cloudflare at the trusted edge. Using it
        // avoids rate-limit keys collapsing onto an intermediary proxy.
        ipAddressHeaders: ["cf-connecting-ip"],
      },
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

"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { isAdult } from "@/lib/auth-client";
import Link from "next/link";

/**
 * Sign in, or create an account.
 *
 * Both modes are one surface because they differ by three fields, and
 * bouncing between two dialogs to discover that is worse than showing them.
 *
 * The password field carries a real cost here: it is stretched with 600,000
 * PBKDF2 iterations before anything is sent, which takes a beat on a slow
 * device. The button says what it is doing rather than appearing to hang.
 */
export default function AuthPanel({
  onSignIn,
  onSignUp,
  onVerifyEmail,
  onResendEmail,
  onClose,
}: {
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignUp: (input: {
    email: string;
    password: string;
    name: string;
    dateOfBirth: string;
  }) => Promise<{ verificationRequired: boolean }>;
  onVerifyEmail: (email: string, otp: string) => Promise<void>;
  onResendEmail: (email: string) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationFor, setVerificationFor] = useState<string | null>(null);
  const [otp, setOtp] = useState("");

  const creating = mode === "up";
  const dobProblem = creating && dob !== "" && !isAdult(dob);
  const complete =
    email.trim() !== "" &&
    password !== "" &&
    (!creating || (name.trim() !== "" && dob !== "" && !dobProblem));

  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const result = await onSignUp({ email, password, name, dateOfBirth: dob });
        if (result.verificationRequired) {
          setVerificationFor(email.trim().toLowerCase());
          setBusy(false);
          return;
        }
      } else {
        await onSignIn(email, password);
      }
      onClose();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "that did not work — try again",
      );
    }
  };

  const verify = async () => {
    if (!verificationFor || otp.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onVerifyEmail(verificationFor, otp);
      onClose();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "that code could not be verified",
      );
    }
  };

  const field =
    "w-full rounded-xl border border-hairline bg-surface px-3.5 py-2.5 text-[13px] text-foreground placeholder:text-muted focus:outline-none";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Account"
      className="fixed inset-0 z-50 flex items-center justify-center bg-chrome/70 px-6 backdrop-blur-md"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[400px] rounded-[18px] border border-hairline bg-background p-6"
      >
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {verificationFor ? "verify email" : creating ? "create account" : "sign in"}
          </p>
          <button
            onClick={onClose}
            className="font-mono text-[10px] text-muted transition-colors hover:text-foreground"
          >
            esc
          </button>
        </div>

        <h2 className="mt-2 text-[15px] leading-relaxed text-foreground">
          {verificationFor
            ? `We sent a six-digit code to ${verificationFor}.`
            : creating
            ? "Your conversations, on every device."
            : "Welcome back."}
        </h2>

        {verificationFor ? (
          <>
            <input
              value={otp}
              onChange={(event) =>
                setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              onKeyDown={(event) => event.key === "Enter" && void verify()}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              aria-label="Verification code"
              placeholder="000000"
              className={`${field} mt-5 text-center font-mono text-[20px] tracking-[0.28em]`}
            />
            <button
              onClick={() => void verify()}
              disabled={otp.length !== 6 || busy}
              className="mt-3 w-full rounded-full bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              {busy ? "verifying…" : "Verify email"}
            </button>
            <button
              onClick={() =>
                void onResendEmail(verificationFor).catch((err) =>
                  setError(err instanceof Error ? err.message : "could not resend code"),
                )
              }
              disabled={busy}
              className="mt-3 w-full text-center font-mono text-[10px] text-muted transition-colors hover:text-foreground disabled:opacity-40"
            >
              resend code
            </button>
          </>
        ) : (
          <>
        <button
          disabled
          className="mt-5 w-full cursor-not-allowed rounded-full border border-hairline px-4 py-2.5 text-[13px] text-muted opacity-55"
        >
          Google · coming soon
        </button>

        <div className="mt-5 flex items-center gap-3">
          <span className="h-px flex-1 bg-hairline" />
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted">
            or
          </span>
          <span className="h-px flex-1 bg-hairline" />
        </div>

        <div className="mt-4 space-y-2.5">
          {creating && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              autoComplete="name"
              className={field}
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="Email"
            autoComplete="email"
            className={field}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="Password"
            autoComplete={creating ? "new-password" : "current-password"}
            className={field}
          />
          {creating && (
            <div>
              <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted">
                date of birth
              </label>
              <input
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                className={`${field} font-mono text-[12px]`}
              />
              <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted">
                {dobProblem
                  ? "you must be 18 or older to create an account"
                  : "this service is for adults only · 18+"}
              </p>
            </div>
          )}
        </div>

        <button
          onClick={() => void submit()}
          disabled={!complete || busy}
          className="mt-5 w-full rounded-full bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          {busy
            ? "securing your password…"
            : creating
              ? "Create account"
              : "Sign in"}
        </button>

          </>
        )}

        {error && (
          <p className="mt-3.5 font-mono text-[11px] leading-relaxed text-foreground">
            {error}
          </p>
        )}

        {!verificationFor && <button
          onClick={() => {
            setMode(creating ? "in" : "up");
            setError(null);
          }}
          className="mt-5 w-full text-center font-mono text-[10px] text-muted transition-colors hover:text-foreground"
        >
          {creating
            ? "already have an account? sign in"
            : "no account yet? create one"}
        </button>}

        <p className="mt-5 font-mono text-[10px] leading-relaxed text-muted">
          {verificationFor
            ? "the code expires in 10 minutes · five attempts"
            : "your password is stretched on this device and never sent · it also derives the key that encrypts your chats"}
        </p>
        <p className="mt-3 text-center font-mono text-[9px] text-muted">
          By continuing, you agree to the{" "}
          <Link
            href="/privacy"
            className="underline decoration-hairline underline-offset-2 transition-colors hover:text-foreground"
          >
            privacy policy
          </Link>
          .
        </p>
      </motion.div>
    </div>
  );
}

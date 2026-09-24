"use client";

import { useState } from "react";
import Link from "next/link";
import { isAdult } from "@/lib/auth-client";
import Button from "@/components/ui/Button";
import { GateCard } from "./FrontDoor";

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
  /**
   * Absent when this is the front door rather than a panel.
   *
   * Signing in used to be two clicks deep behind the account button, because
   * the app worked perfectly well without an account. It does not any more —
   * there is no local store to fall back on — so this is the first thing an
   * unauthenticated visitor sees, and a front door with a dismiss button
   * would dismiss to nothing.
   */
  onClose?: () => void;
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
      onClose?.();
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
      onClose?.();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "that code could not be verified",
      );
    }
  };

  const gate = onClose === undefined;

  const card = (
    <GateCard>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-[-0.02em] text-foreground">
            {verificationFor
              ? "Check your email"
              : creating
                ? "Create your account"
                : "Welcome back"}
          </h1>
          <p className="mt-1 text-[13px] leading-relaxed text-secondary">
            {verificationFor
              ? `We sent a six-digit code to ${verificationFor}.`
              : creating
                ? "Your conversations, encrypted, on every device."
                : "Sign in to pick up where you left off."}
          </p>
        </div>
        {!gate && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="dial-kbd shrink-0 transition-colors hover:text-foreground"
          >
            esc
          </button>
        )}
      </div>

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
            className="dial-input mt-6 h-12! text-center font-mono text-[20px]! tracking-[0.32em]"
          />
          <Button
            variant="primary"
            size="md"
            onClick={() => void verify()}
            disabled={otp.length !== 6 || busy}
            className="mt-3 w-full"
          >
            {busy ? "Verifying…" : "Verify email"}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            onClick={() =>
              void onResendEmail(verificationFor).catch((err) =>
                setError(err instanceof Error ? err.message : "could not resend code"),
              )
            }
            disabled={busy}
            className="mt-2 w-full"
          >
            Resend code
          </Button>
        </>
      ) : (
        <>
          <form
            className="mt-6 space-y-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {creating && (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                aria-label="Name"
                autoComplete="name"
                className="dial-input"
              />
            )}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              aria-label="Email"
              autoComplete="email"
              className="dial-input"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              aria-label="Password"
              autoComplete={creating ? "new-password" : "current-password"}
              className="dial-input"
            />
            {creating && (
              <div className="pt-1">
                <label
                  htmlFor="auth-dob"
                  className="mb-1.5 block text-[12px] font-medium text-secondary"
                >
                  Date of birth
                </label>
                <input
                  id="auth-dob"
                  type="date"
                  value={dob}
                  onChange={(e) => setDob(e.target.value)}
                  className="dial-input font-mono text-[12.5px]!"
                />
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
                  {dobProblem
                    ? "You must be 18 or older to create an account."
                    : "This service is for adults only (18+)."}
                </p>
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={!complete || busy}
              className="mt-4! w-full"
            >
              {busy ? (
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-3 rounded-full border-[1.5px] border-current border-t-transparent"
                    style={{ animation: "dial-spin 700ms linear infinite" }}
                  />
                  Securing your password…
                </span>
              ) : creating ? (
                "Create account"
              ) : (
                "Sign in"
              )}
            </Button>
          </form>

          <div className="mt-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="text-[11px] text-muted">or</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <Button
            variant="secondary"
            size="md"
            disabled
            className="mt-5 w-full"
            title="Google sign-in is not available yet"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden fill="currentColor">
              <path d="M15.2 8.2c0-.5 0-1-.1-1.5H8v2.9h4a3.4 3.4 0 0 1-1.5 2.2v1.8h2.4c1.4-1.3 2.3-3.2 2.3-5.4Z" />
              <path d="M8 15.4c2 0 3.7-.7 4.9-1.8l-2.4-1.8c-.7.4-1.5.7-2.5.7a4.3 4.3 0 0 1-4-3H1.5v1.9A7.4 7.4 0 0 0 8 15.4Z" opacity=".7" />
              <path d="M4 9.5a4.4 4.4 0 0 1 0-2.9V4.7H1.5a7.4 7.4 0 0 0 0 6.7L4 9.5Z" opacity=".5" />
              <path d="M8 3.6c1.1 0 2.1.4 2.9 1.1L13 2.6A7.2 7.2 0 0 0 8 .6a7.4 7.4 0 0 0-6.5 4.1L4 6.6a4.3 4.3 0 0 1 4-3Z" opacity=".85" />
            </svg>
            Continue with Google
            <span className="font-normal text-muted">· soon</span>
          </Button>
        </>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-control bg-hover px-3 py-2 text-[12.5px] leading-relaxed text-foreground"
          style={{ animation: "dial-fade-up 200ms cubic-bezier(0.23,1,0.32,1) both" }}
        >
          {error}
        </p>
      )}

      {!verificationFor && (
        <p className="mt-6 text-center text-[12.5px] text-secondary">
          {creating ? "Already have an account? " : "New here? "}
          <button
            type="button"
            onClick={() => {
              setMode(creating ? "in" : "up");
              setError(null);
            }}
            className="font-medium text-foreground"
          >
            <span className="dial-underline">
              {creating ? "Sign in" : "Create an account"}
            </span>
          </button>
        </p>
      )}

      <p className="mt-5 border-t border-line pt-4 text-[11.5px] leading-relaxed text-muted">
        {verificationFor
          ? "The code expires in 10 minutes. You have five attempts."
          : "Your password is stretched on this device and never sent. It also derives the key that encrypts your chats."}{" "}
        {!verificationFor && (
          <>
            By continuing you agree to the{" "}
            <Link href="/privacy" className="text-secondary transition-colors hover:text-foreground">
              <span className="dial-underline">privacy policy</span>
            </Link>
            .
          </>
        )}
      </p>
    </GateCard>
  );

  if (gate) return card;

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Account"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="contents">
        {card}
      </div>
    </div>
  );
}

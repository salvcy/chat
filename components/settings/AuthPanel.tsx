"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { isAdult } from "@/lib/auth-client";

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
  onGoogle,
  onClose,
}: {
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignUp: (input: {
    email: string;
    password: string;
    name: string;
    dateOfBirth: string;
  }) => Promise<void>;
  onGoogle: () => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        await onSignUp({ email, password, name, dateOfBirth: dob });
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

  const google = async () => {
    setBusy(true);
    setError(null);
    try {
      await onGoogle();
      // Navigates away on success; reaching here means it did not.
      setBusy(false);
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "Google sign-in is unavailable",
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
            {creating ? "create account" : "sign in"}
          </p>
          <button
            onClick={onClose}
            className="font-mono text-[10px] text-muted transition-colors hover:text-foreground"
          >
            esc
          </button>
        </div>

        <h2 className="mt-2 text-[15px] leading-relaxed text-foreground">
          {creating
            ? "Your conversations, on every device."
            : "Welcome back."}
        </h2>

        <button
          onClick={() => void google()}
          disabled={busy}
          className="mt-5 w-full rounded-full border border-hairline px-4 py-2.5 text-[13px] text-secondary transition-colors hover:border-hairline-strong hover:text-foreground disabled:opacity-40"
        >
          Continue with Google
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

        {error && (
          <p className="mt-3.5 font-mono text-[11px] leading-relaxed text-foreground">
            {error}
          </p>
        )}

        <button
          onClick={() => {
            setMode(creating ? "in" : "up");
            setError(null);
          }}
          className="mt-5 w-full text-center font-mono text-[10px] text-muted transition-colors hover:text-foreground"
        >
          {creating
            ? "already have an account? sign in"
            : "no account yet? create one"}
        </button>

        <p className="mt-5 font-mono text-[10px] leading-relaxed text-muted">
          your password is stretched on this device and never sent · it also
          derives the key that encrypts your chats
        </p>
      </motion.div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import type { SessionUser } from "@/lib/auth-client";
import { keyFingerprint, looksLikeKey } from "@/lib/credentials";
import {
  DENSITIES,
  FONTS,
  INSTRUCTIONS_MAX,
  TEXT_SIZES,
  THEMES,
  WIDTHS,
  type UserSettings,
} from "@/lib/settings";
import type { SyncStatus } from "@/lib/session";
import type { AccountUsage } from "@/lib/settings";

/**
 * Account and preferences.
 *
 * Every control writes immediately — there is no Save button, because a
 * preference panel that can be left in an unsaved state is a preference
 * panel that loses work. Appearance changes land on the document as CSS
 * custom properties before the network is involved, so they feel instant
 * regardless of connection.
 *
 * State is shown by fill, never colour: the selected segment is a lifted
 * thumb that slides between peers.
 */

export type Section = "account" | "instructions" | "keys" | "appearance";

const SECTIONS: Section[] = ["account", "instructions", "keys", "appearance"];

/** A few starting points — cheaper than staring at an empty box. */
const PRESETS: Array<{ label: string; text: string }> = [
  {
    label: "Terse",
    text: "Answer in as few words as the question allows. No preamble, no summary of what you just said, no offers of further help.",
  },
  {
    label: "Socratic",
    text: "Before answering, state the strongest objection to the premise of the question. Then answer. Flag where you are uncertain rather than smoothing over it.",
  },
  {
    label: "Engineer",
    text: "You are a senior engineer reviewing code. Prefer correctness over agreement. Point out failure modes, edge cases and simpler alternatives. Show code, not prose about code.",
  },
];

/**
 * Standing instructions — the system prompt for every conversation.
 *
 * Typing writes a local draft; it reaches the account 600ms after the last
 * keystroke, on blur, and when the panel closes. Writing on every keystroke
 * would re-seal and upload the whole settings blob per character, and an
 * explicit Save would break this panel's one rule: nothing in it can be left
 * unsaved.
 */
function Instructions({
  value,
  onSave,
}: {
  value: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const savedRef = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (draftRef.current === savedRef.current) return;
    savedRef.current = draftRef.current;
    onSave(draftRef.current);
  };
  // Closing the panel mid-sentence still saves the sentence.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => flushRef.current(), []);

  const change = (next: string) => {
    const clipped = next.slice(0, INSTRUCTIONS_MAX);
    setDraft(clipped);
    draftRef.current = clipped;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };

  return (
    <>
      <textarea
        value={draft}
        maxLength={INSTRUCTIONS_MAX}
        onChange={(e) => change(e.target.value)}
        onBlur={flush}
        aria-label="Instructions"
        placeholder="How should models answer you? Tone, format, what to assume about you…"
        className="dial-input dial-scroll block h-44! w-full resize-none py-2.5! text-[13.5px]! leading-relaxed"
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => change(preset.text)}
            className="h-6 rounded-full bg-hover px-2.5 text-[12px] text-secondary transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-foreground active:scale-[0.97]"
          >
            {preset.label}
          </button>
        ))}
        {draft && (
          <button
            type="button"
            onClick={() => change("")}
            className="ml-auto h-6 rounded-full px-2 text-[12px] text-muted transition-colors hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
    </>
  );
}

/* ------------------------------- primitives ---------------------------- */

/** Bytes, at the precision a person actually reads. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

/**
 * A usage bar.
 *
 * Monochrome like everything else: the fill is the foreground colour, and a
 * bar that is nearly full says so in words rather than by turning red. There
 * is no colour vocabulary in this interface to borrow for it, and inventing
 * one here would be the first exception.
 */
function Meter({
  used,
  total,
  label,
  detail,
}: {
  used: number;
  total: number;
  label: string;
  detail: string;
}) {
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const full = ratio >= 0.9;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] font-medium text-foreground">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-secondary">{detail}</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-label={label}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-hover-2"
      >
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(ratio * 100, used > 0 ? 1.5 : 0)}%` }}
        />
      </div>
      {full && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
          Nearly full — deleting a conversation also deletes its images and
          attachments.
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-4">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {hint && (
          <span className="font-mono text-[11px] text-muted">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/* -------------------------------- panel -------------------------------- */

export default function SettingsPanel({
  user,
  settings,
  status,
  encrypted,
  deviceKeyStored,
  onUpdate,
  onSignOut,
  onDestroy,
  onSync,
  usage,
  onRefreshUsage,
  onClose,
  onSignInRequested,
  initialSection = "account",
}: {
  user: SessionUser | null;
  settings: UserSettings;
  status: SyncStatus;
  encrypted: boolean;
  deviceKeyStored: boolean;
  onUpdate: (patch: Partial<UserSettings>) => void;
  onSignOut: () => Promise<void>;
  onDestroy: () => Promise<void>;
  onSync: () => Promise<void>;
  usage: AccountUsage | null;
  onRefreshUsage: () => Promise<void>;
  onClose: () => void;
  onSignInRequested: () => void;
  initialSection?: Section;
}) {
  const [section, setSection] = useState<Section>(initialSection);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  // Read once on open, and again after a sync settles — storage only moves
  // when something was uploaded or deleted, so polling it would be noise.
  const settled = status.state === "idle";
  useEffect(() => {
    if (!user) return;
    void onRefreshUsage();
  }, [user, settled, onRefreshUsage]);

  const saveKey = () => {
    const value = keyDraft.trim();
    if (!looksLikeKey(value)) {
      setKeyError("that does not look like an OpenRouter key (sk-or-v1-…)");
      return;
    }
    onUpdate({ openrouterKey: value });
    setKeyDraft("");
    setKeyError(null);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-[2px]"
      onClick={onClose}
      style={{ animation: "dial-fade-in 150ms ease-out both" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86vh] w-full max-w-[480px] flex-col overflow-hidden rounded-window bg-panel shadow-overlay"
        style={{ animation: "dial-pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        {/* header */}
        <div className="shrink-0 border-b border-line px-5 pb-4 pt-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
              Settings
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="flex size-7 items-center justify-center rounded-control text-muted transition-colors hover:bg-hover-2 hover:text-foreground"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>

          <div className="mt-3.5">
            <Segmented
              label="Settings section"
              value={section}
              options={SECTIONS}
              onChange={setSection}
              labels={{
                account: "Account",
                instructions: "Instructions",
                keys: "Keys",
                appearance: "Appearance",
              }}
            />
          </div>
        </div>

        {/* body */}
        <div className="dial-scroll-none min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {section === "account" && (
            <div className="divide-y divide-line">
              {user ? (
                <>
                  <div className="flex items-center gap-3 py-4">
                    <span
                      aria-hidden
                      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-[15px] font-semibold text-background"
                    >
                      {(user.name || user.email).trim().charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-medium text-foreground">{user.name}</p>
                      <p className="mt-0.5 truncate font-mono text-[11.5px] text-muted">
                        {user.email}
                      </p>
                    </div>
                  </div>

                  {usage && (
                    <Row label="Storage">
                      <div className="space-y-3.5">
                        <Meter
                          label="Files"
                          used={usage.blobBytes}
                          total={usage.blobQuota}
                          detail={`${formatBytes(usage.blobBytes)} of ${formatBytes(usage.blobQuota)}`}
                        />
                        <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] text-muted">
                          <span>
                            {usage.blobCount === 1
                              ? "1 image or attachment"
                              : `${usage.blobCount} images and attachments`}
                          </span>
                          <span>
                            {usage.threads === 1
                              ? "1 conversation"
                              : `${usage.threads} conversations`}
                            {" · "}
                            {usage.messages === 1
                              ? "1 message"
                              : `${usage.messages} messages`}
                          </span>
                        </div>
                      </div>
                    </Row>
                  )}

                  <Row label="Chat history">
                    <p className="text-[12.5px] leading-relaxed text-secondary">
                      {encrypted
                        ? "End-to-end encrypted. Your password derives the key, so the server stores ciphertext it cannot read."
                        : "Stored in your account. This sign-in method supplies no key, so the server can read it."}
                    </p>
                    <div className="mt-2.5 flex items-center gap-2">
                      <Button
                        size="xs"
                        onClick={() => void onSync()}
                        disabled={status.state === "syncing"}
                      >
                        {status.state === "syncing" ? "Syncing…" : "Sync now"}
                      </Button>
                      <span className="font-mono text-[11px] text-muted">
                        {status.state === "error"
                          ? status.message
                          : status.state === "idle" && status.at
                            ? "up to date"
                            : ""}
                      </span>
                    </div>
                  </Row>

                  {encrypted && (
                    <Row
                      label="Device unlock"
                      hint={deviceKeyStored ? "saved here" : "session only"}
                    >
                      <p className="mb-2.5 text-[12.5px] leading-relaxed text-secondary">
                        {settings.rememberDeviceKey
                          ? "This browser keeps a non-exportable unlock key, so refreshes do not ask for your password."
                          : "The unlock key stays in memory only. Closing or refreshing the app requires your password again."}
                      </p>
                      <Segmented
                        label="Device unlock"
                        value={settings.rememberDeviceKey ? "remember" : "lock"}
                        options={["remember", "lock"] as const}
                        onChange={(next) =>
                          onUpdate({ rememberDeviceKey: next === "remember" })
                        }
                        labels={{ remember: "Remember browser", lock: "Lock on exit" }}
                      />
                      <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
                        A synced preference — the key itself never leaves this browser.
                      </p>
                    </Row>
                  )}

                  <Row label="Session">
                    <Button size="xs" onClick={() => void onSignOut().then(onClose)}>
                      Sign out
                    </Button>
                    <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
                      Removes this browser&apos;s unlock key. Your history stays in
                      your account.
                    </p>
                  </Row>

                  <div className="pt-4">
                    {confirmDestroy ? (
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[12px] leading-relaxed text-secondary">
                          Deletes your account and every conversation. There is
                          no recovery.
                        </p>
                        <div className="flex shrink-0 gap-1.5">
                          <Button size="xs" variant="quiet" onClick={() => setConfirmDestroy(false)}>
                            Cancel
                          </Button>
                          <Button size="xs" variant="primary" onClick={() => void onDestroy().then(onClose)}>
                            Delete forever
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <Link
                          href="/privacy"
                          className="text-[12px] text-muted transition-colors hover:text-foreground"
                        >
                          <span className="dial-underline">Privacy policy</span>
                        </Link>
                        <button
                          type="button"
                          onClick={() => setConfirmDestroy(true)}
                          className="shrink-0 text-[12px] text-muted transition-colors hover:text-foreground"
                        >
                          <span className="dial-underline">Delete account</span>
                        </button>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="py-4">
                  <p className="text-[13px] leading-relaxed text-secondary">
                    Sign in is required because conversations live in the
                    encrypted cloud store, not in this browser.
                  </p>
                  <button
                    onClick={onSignInRequested}
                    className="mt-4 w-full rounded-full bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
                  >
                    Sign in or create an account
                  </button>
                  <p className="mt-3 font-mono text-[10px] leading-relaxed text-muted">
                    account settings carry your key and preferences between
                    devices
                  </p>
                </div>
              )}
            </div>
          )}

          {section === "instructions" && (
            <div className="divide-y divide-line">
              <Row
                label="Instructions"
                hint={
                  settings.instructions
                    ? `${settings.instructions.length}/${INSTRUCTIONS_MAX}`
                    : "none"
                }
              >
                <p className="mb-3 text-[12.5px] leading-relaxed text-secondary">
                  Sent as the system prompt in every conversation, on every
                  model.{" "}
                  {encrypted
                    ? "Encrypted with the rest of your settings; OpenRouter and the model provider see them with each message."
                    : "OpenRouter and the model provider see them with each message."}
                </p>
                <Instructions
                  value={settings.instructions}
                  onSave={(instructions) => onUpdate({ instructions })}
                />
              </Row>
              <Row label="Web search" hint="automatic">
                <p className="text-[12.5px] leading-relaxed text-secondary">
                  Every model that can search the web is given the tool, and
                  decides for itself when a question needs it. Searches are
                  billed to your OpenRouter key and appear in each
                  answer&apos;s activity.
                </p>
              </Row>
            </div>
          )}

          {section === "keys" && (
            <div className="divide-y divide-line">
              <Row
                label="OpenRouter key"
                hint={
                  settings.openrouterKey
                    ? keyFingerprint(settings.openrouterKey)
                    : "not set"
                }
              >
                <p className="mb-3 text-[12.5px] leading-relaxed text-secondary">
                  Requests go from your browser straight to OpenRouter, so the
                  key is only ever used here.
                  {user
                    ? encrypted
                      ? " It is encrypted with your password before it is saved to your account."
                      : " It is saved to your account so it follows you between devices."
                    : " Sign in to carry it to other devices."}
                </p>

                {settings.openrouterKey ? (
                  <div className="flex items-center gap-2">
                    <code className="flex h-[30px] flex-1 items-center truncate rounded-control bg-field px-3 font-mono text-[12px] text-secondary shadow-hairline">
                      sk-or-v1-{"…"}
                      {settings.openrouterKey.slice(-6)}
                    </code>
                    <Button onClick={() => onUpdate({ openrouterKey: null })}>
                      Remove
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={keyDraft}
                      onChange={(e) => {
                        setKeyDraft(e.target.value);
                        setKeyError(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && saveKey()}
                      placeholder="sk-or-v1-…"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="OpenRouter API key"
                      className="dial-input h-[34px]! min-w-0 flex-1 font-mono text-[12.5px]!"
                    />
                    <Button variant="primary" onClick={saveKey} disabled={!keyDraft.trim()} className="h-[34px]!">
                      Save
                    </Button>
                  </div>
                )}
                {keyError && (
                  <p className="mt-2 text-[12px] text-foreground">{keyError}</p>
                )}
              </Row>
            </div>
          )}

          {section === "appearance" && (
            <div className="divide-y divide-line">
              <Row label="Theme">
                <Segmented
                  label="Theme"
                  value={settings.theme}
                  options={THEMES}
                  onChange={(theme) => onUpdate({ theme })}
                />
              </Row>
              <Row label="Typeface" hint="system uses no webfont">
                <Segmented
                  value={settings.font}
                  options={FONTS}
                  onChange={(font) => onUpdate({ font })}
                />
              </Row>
              <Row label="Text size">
                <Segmented
                  value={settings.textSize}
                  options={TEXT_SIZES}
                  onChange={(textSize) => onUpdate({ textSize })}
                />
              </Row>
              <Row label="Column width">
                <Segmented
                  value={settings.width}
                  options={WIDTHS}
                  onChange={(width) => onUpdate({ width })}
                />
              </Row>
              <Row label="Density">
                <Segmented
                  value={settings.density}
                  options={DENSITIES}
                  onChange={(density) => onUpdate({ density })}
                  labels={{ comfortable: "roomy", compact: "compact" }}
                />
              </Row>
            </div>
          )}
          {/* Signed in, the link lives beside "delete account". Signed out
              there is no such row, and dropping the only route to the policy
              from this panel would be a regression. */}
          {!user && (
            <div className="mt-5 border-t border-hairline pt-4">
              <Link
                href="/privacy"
                className="font-mono text-[10px] text-muted underline decoration-hairline underline-offset-2 transition-colors hover:text-foreground"
              >
                privacy policy
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

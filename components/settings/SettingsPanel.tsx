"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import type { SessionUser } from "@/lib/auth-client";
import { keyFingerprint, looksLikeKey } from "@/lib/credentials";
import {
  DENSITIES,
  FONTS,
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
 * State is shown by inversion, never colour: the selected segment is a
 * filled block with the contrast swapped, which is the same language the
 * model switcher and the send button already speak.
 */

type Section = "account" | "keys" | "appearance";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "account", label: "account" },
  { id: "keys", label: "keys" },
  { id: "appearance", label: "appearance" },
];

/* ------------------------------- primitives ---------------------------- */

function Segmented<T extends string>({
  value,
  options,
  onChange,
  labels,
}: {
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
  labels?: Partial<Record<T, string>>;
}) {
  return (
    <div className="flex gap-1 rounded-full border border-hairline p-1">
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            onClick={() => onChange(option)}
            className={`flex-1 rounded-full px-2.5 py-1 font-mono text-[10px] transition-colors ${
              active
                ? "bg-invert-fill text-invert-text"
                : "text-muted hover:text-foreground"
            }`}
          >
            {labels?.[option] ?? option}
          </button>
        );
      })}
    </div>
  );
}

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
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {label}
        </span>
        <span className="font-mono text-[10px] text-secondary">{detail}</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-label={label}
        className="mt-2 h-1 w-full overflow-hidden rounded-full bg-hairline"
      >
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(ratio * 100, used > 0 ? 1.5 : 0)}%` }}
        />
      </div>
      {full && (
        <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-muted">
          nearly full — deleting a conversation also deletes its images and
          attachments
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
    <div className="py-3.5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {label}
        </span>
        {hint && (
          <span className="font-mono text-[9px] text-muted opacity-70">
            {hint}
          </span>
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
  onUpdate,
  onSignOut,
  onDestroy,
  onSync,
  usage,
  onRefreshUsage,
  onClose,
  onSignInRequested,
}: {
  user: SessionUser | null;
  settings: UserSettings;
  status: SyncStatus;
  encrypted: boolean;
  onUpdate: (patch: Partial<UserSettings>) => void;
  onSignOut: (wipeDevice: boolean) => Promise<void>;
  onDestroy: () => Promise<void>;
  onSync: () => Promise<void>;
  usage: AccountUsage | null;
  onRefreshUsage: () => Promise<void>;
  onClose: () => void;
  onSignInRequested: () => void;
}) {
  const [section, setSection] = useState<Section>("account");
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-chrome/70 px-6 backdrop-blur-md"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[18px] border border-hairline bg-background"
      >
        {/* header */}
        <div className="shrink-0 px-6 pt-5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
              settings
            </p>
            <button
              onClick={onClose}
              className="font-mono text-[10px] text-muted transition-colors hover:text-foreground"
            >
              esc
            </button>
          </div>

          <div className="mt-4 flex gap-1 border-b border-hairline">
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                onClick={() => setSection(entry.id)}
                className={`-mb-px border-b px-2.5 pb-2.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                  section === entry.id
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted hover:text-secondary"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        {/* body */}
        <div className="dial-scroll-none min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {section === "account" && (
            <div className="divide-y divide-hairline">
              {user ? (
                <>
                  <div className="py-4">
                    <p className="text-[14px] text-foreground">{user.name}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-muted">
                      {user.email}
                    </p>
                  </div>

                  {usage && (
                    <Row label="storage">
                      <div className="space-y-3.5">
                        <Meter
                          label="files"
                          used={usage.blobBytes}
                          total={usage.blobQuota}
                          detail={`${formatBytes(usage.blobBytes)} of ${formatBytes(usage.blobQuota)}`}
                        />
                        <div className="flex items-baseline justify-between gap-3 font-mono text-[10px] text-muted">
                          <span>
                            {usage.blobCount === 1
                              ? "1 image or attachment"
                              : `${usage.blobCount} images and attachments`}
                          </span>
                          <span>
                            {usage.records === 1
                              ? "1 synced record"
                              : `${usage.records} synced records`}
                          </span>
                        </div>
                      </div>
                    </Row>
                  )}

                  <Row label="chat history">
                    <p className="text-[12px] leading-relaxed text-secondary">
                      {encrypted
                        ? "End-to-end encrypted. Your password derives the key, so the server stores ciphertext it cannot read."
                        : "Stored in your account. This sign-in method supplies no key, so the server can read it."}
                    </p>
                    <div className="mt-2.5 flex items-center gap-2">
                      <button
                        onClick={() => void onSync()}
                        disabled={status.state === "syncing"}
                        className="rounded-full border border-hairline px-3 py-1.5 font-mono text-[10px] text-secondary transition-colors hover:border-hairline-strong hover:text-foreground disabled:opacity-40"
                      >
                        {status.state === "syncing" ? "syncing…" : "sync now"}
                      </button>
                      <span className="font-mono text-[10px] text-muted">
                        {status.state === "error"
                          ? status.message
                          : status.state === "idle" && status.at
                            ? "up to date"
                            : ""}
                      </span>
                    </div>
                  </Row>

                  <Row label="session">
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void onSignOut(true).then(onClose)}
                        className="rounded-full border border-hairline px-3 py-1.5 font-mono text-[10px] text-secondary transition-colors hover:border-hairline-strong hover:text-foreground"
                      >
                        sign out
                      </button>
                      <button
                        onClick={() => void onSignOut(false).then(onClose)}
                        className="rounded-full border border-hairline px-3 py-1.5 font-mono text-[10px] text-muted transition-colors hover:text-foreground"
                      >
                        sign out, keep local copy
                      </button>
                    </div>
                    <p className="mt-2 font-mono text-[10px] leading-relaxed text-muted">
                      signing out clears this device by default — your history
                      stays in your account
                    </p>
                  </Row>

                  <div className="pt-4">
                    {confirmDestroy ? (
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-mono text-[10px] leading-relaxed text-muted">
                          deletes your account and every conversation. no
                          recovery.
                        </p>
                        <div className="flex shrink-0 gap-2">
                          <button
                            onClick={() => setConfirmDestroy(false)}
                            className="rounded-full border border-hairline px-3 py-1.5 font-mono text-[10px] text-secondary"
                          >
                            cancel
                          </button>
                          <button
                            onClick={() => void onDestroy().then(onClose)}
                            className="rounded-full bg-foreground px-3 py-1.5 font-mono text-[10px] text-background"
                          >
                            delete
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <Link
                          href="/privacy"
                          className="font-mono text-[10px] text-muted underline decoration-hairline underline-offset-2 transition-colors hover:text-foreground"
                        >
                          privacy policy
                        </Link>
                        <button
                          onClick={() => setConfirmDestroy(true)}
                          className="shrink-0 font-mono text-[10px] text-muted underline decoration-hairline underline-offset-2 transition-colors hover:text-foreground"
                        >
                          delete account
                        </button>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="py-4">
                  <p className="text-[13px] leading-relaxed text-secondary">
                    You are not signed in. Conversations stay on this device
                    only, and are lost if you clear the browser.
                  </p>
                  <button
                    onClick={onSignInRequested}
                    className="mt-4 w-full rounded-full bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
                  >
                    Sign in or create an account
                  </button>
                  <p className="mt-3 font-mono text-[10px] leading-relaxed text-muted">
                    your key and appearance below are saved on this device
                    either way — an account carries them everywhere
                  </p>
                </div>
              )}
            </div>
          )}

          {section === "keys" && (
            <div className="divide-y divide-hairline">
              <Row
                label="openrouter key"
                hint={
                  settings.openrouterKey
                    ? keyFingerprint(settings.openrouterKey)
                    : "not set"
                }
              >
                <p className="mb-2.5 text-[12px] leading-relaxed text-secondary">
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
                    <code className="flex-1 truncate rounded-full border border-hairline bg-surface px-3 py-1.5 font-mono text-[11px] text-secondary">
                      sk-or-v1-{"…"}
                      {settings.openrouterKey.slice(-6)}
                    </code>
                    <button
                      onClick={() => onUpdate({ openrouterKey: null })}
                      className="shrink-0 rounded-full border border-hairline px-3 py-1.5 font-mono text-[10px] text-muted transition-colors hover:text-foreground"
                    >
                      remove
                    </button>
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
                      className="min-w-0 flex-1 rounded-full border border-hairline bg-surface px-3.5 py-2 font-mono text-xs text-foreground placeholder:text-muted focus:outline-none"
                    />
                    <button
                      onClick={saveKey}
                      disabled={!keyDraft.trim()}
                      className="shrink-0 rounded-full border border-hairline px-3.5 py-2 font-mono text-[10px] text-secondary transition-colors hover:border-hairline-strong hover:text-foreground disabled:opacity-40"
                    >
                      save
                    </button>
                  </div>
                )}
                {keyError && (
                  <p className="mt-2 font-mono text-[10px] text-foreground">
                    {keyError}
                  </p>
                )}
              </Row>
            </div>
          )}

          {section === "appearance" && (
            <div className="divide-y divide-hairline">
              <Row label="theme">
                <Segmented
                  value={settings.theme}
                  options={THEMES}
                  onChange={(theme) => onUpdate({ theme })}
                />
              </Row>
              <Row label="typeface" hint="system uses no webfont">
                <Segmented
                  value={settings.font}
                  options={FONTS}
                  onChange={(font) => onUpdate({ font })}
                />
              </Row>
              <Row label="text size">
                <Segmented
                  value={settings.textSize}
                  options={TEXT_SIZES}
                  onChange={(textSize) => onUpdate({ textSize })}
                />
              </Row>
              <Row label="column width">
                <Segmented
                  value={settings.width}
                  options={WIDTHS}
                  onChange={(width) => onUpdate({ width })}
                />
              </Row>
              <Row label="density">
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
      </motion.div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";
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
 * State is shown by fill, never colour: the selected segment is a lifted
 * thumb that slides between peers.
 */

type Section = "account" | "keys" | "appearance";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "account", label: "account" },
  { id: "keys", label: "keys" },
  { id: "appearance", label: "appearance" },
];

/* ------------------------------- primitives ---------------------------- */

/**
 * Equal-width segments with a thumb that slides to the selection — Beautiful
 * UI's SegmentedControl (beautifului.dev, MIT). The thumb is a lifted
 * surface, not an inversion: this is a choice among peers, and a filled block
 * would read as "on".
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  labels,
  label,
}: {
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
  labels?: Partial<Record<T, string>>;
  label?: string;
}) {
  const index = Math.max(0, options.indexOf(value));
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="relative grid h-8 select-none rounded-full bg-hover-2 p-0.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-full bg-panel shadow-btn transition-transform duration-200 ease-out-strong"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option)}
            className={`relative z-10 truncate rounded-full px-2 text-[12.5px] font-medium capitalize transition-colors duration-150 ${
              active ? "text-foreground" : "text-muted hover:text-secondary"
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
              options={SECTIONS.map((entry) => entry.id)}
              onChange={setSection}
              labels={{ account: "Account", keys: "Keys", appearance: "Appearance" }}
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

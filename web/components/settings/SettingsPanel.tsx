"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";
import Ocean from "@/components/ui/Ocean";
import Segmented from "@/components/ui/Segmented";
import StepSlider from "@/components/ui/StepSlider";
import Switch from "@/components/ui/Switch";
import StorageBrowser, { formatBytes } from "./StorageBrowser";
import type { SessionUser } from "@/lib/auth-client";
import { keyFingerprint, looksLikeKey } from "@/lib/credentials";
import {
  FONT_STACKS,
  FONTS,
  GLASS_LEVELS,
  INSTRUCTIONS_MAX,
  OCEAN_PLACES,
  OCEAN_SPEED_FACTOR,
  OCEAN_SPEEDS,
  TEXT_SIZES,
  THEMES,
  WIDTHS,
  type Font,
  type OceanPlace,
  type Theme,
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
 * Four tabs, each about one thing (October 2026, after the user called the
 * old panel a mess): **Account** is who you are and what you pay with — the
 * OpenRouter key lives here now, not on a tab of its own; **Instructions**;
 * **Privacy** is what is kept and how — encryption, this device's unlock,
 * and the files themselves, browsable and decrypted in place;
 * **Appearance** is a page of different controls for different kinds of
 * choice — pictures for theme and typeface, sliders for scales, switches
 * for on/off — instead of the same segmented bar five times, the
 * composer's glass, and the ASCII ocean, its speed and its places.
 */

export type Section = "account" | "instructions" | "privacy" | "appearance";

const SECTIONS: Section[] = ["account", "instructions", "privacy", "appearance"];

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

const OCEAN_LABEL: Record<OceanPlace, { title: string; detail: string }> = {
  newchat: { title: "New chat", detail: "Behind the greeting, until the first message." },
  chat: { title: "In conversations", detail: "In the margins around a chat, clear of the text." },
  signin: { title: "Sign in", detail: "The front door, before you sign in." },
  unlock: { title: "Unlock", detail: "When this device asks for your password." },
  connect: { title: "Connect a key", detail: "While OpenRouter is being connected." },
};

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
            className="dial-squircle h-6 bg-hover px-2.5 text-[12px] text-secondary transition-[background-color,color,transform] duration-150 [--sq:7px] hover:bg-hover-2 hover:text-foreground active:scale-[0.97]"
          >
            {preset.label}
          </button>
        ))}
        {draft && (
          <button
            type="button"
            onClick={() => change("")}
            className="ml-auto h-6 px-2 text-[12px] text-muted transition-colors hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
    </>
  );
}

/* ------------------------------- primitives ---------------------------- */

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
        className="dial-squircle mt-2 h-1.5 w-full overflow-hidden bg-hover-2 [--sq:3px]"
      >
        <div
          className="dial-squircle h-full bg-foreground transition-[width] duration-300 ease-out [--sq:3px]"
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
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="py-4">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {hint && <span className="font-mono text-[11px] text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** A label and a sentence on the left, a switch on the right. */
function SwitchRow({
  title,
  detail,
  checked,
  onChange,
  disabled = false,
}: {
  title: string;
  detail: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-4 py-2 ${
        disabled ? "opacity-45" : "cursor-pointer"
      }`}
    >
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-foreground">{title}</span>
        <span className="block text-[11.5px] leading-relaxed text-muted">{detail}</span>
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={title} />
    </label>
  );
}

/* ----------------------------- appearance parts ------------------------- */

const MINI: Record<"light" | "dark", { chrome: string; window: string; line: string; ink: string; faint: string }> = {
  light: { chrome: "#f1f1f1", window: "#fcfcfc", line: "#e2e2e2", ink: "#111111", faint: "#d4d4d4" },
  dark: { chrome: "#0e0e0e", window: "#161616", line: "#272727", ink: "#f2f2f2", faint: "#3a3a3a" },
};

/** A thumbnail of the app in one palette: rail, window, a few lines, the composer. */
function MiniWindow({ tone }: { tone: "light" | "dark" }) {
  const p = MINI[tone];
  return (
    <div className="absolute inset-0" style={{ background: p.chrome }}>
      <div className="absolute bottom-2 left-2 top-2 flex w-[22%] flex-col gap-[5px] pt-1">
        {[0.9, 0.7, 0.8].map((w, i) => (
          <span key={i} className="block h-[3px] rounded-[1px]" style={{ width: `${w * 100}%`, background: p.faint }} />
        ))}
      </div>
      <div
        className="absolute bottom-2 left-[30%] right-2 top-2 rounded-[5px]"
        style={{ background: p.window, boxShadow: `0 0 0 1px ${p.line}` }}
      >
        <span className="absolute left-2 top-2.5 block h-[3px] w-[46%] rounded-[1px]" style={{ background: p.ink, opacity: 0.75 }} />
        <span className="absolute left-2 top-[18px] block h-[3px] w-[62%] rounded-[1px]" style={{ background: p.faint }} />
        <span
          className="absolute bottom-1.5 left-2 right-2 h-[9px] rounded-[3px]"
          style={{ background: p.window, boxShadow: `0 0 0 1px ${p.line}` }}
        />
      </div>
    </div>
  );
}

function ThemeCards({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2.5">
      {THEMES.map((theme) => {
        const selected = theme === value;
        return (
          <button
            key={theme}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(theme)}
            className="group/theme flex flex-col gap-1.5 text-left"
          >
            <span
              className={`dial-squircle relative block aspect-[16/10] w-full overflow-hidden transition-[box-shadow,transform] duration-200 ease-out-strong [--sq:10px] group-active/theme:scale-[0.98] ${
                selected
                  ? "shadow-[0_0_0_1.5px_var(--foreground)]"
                  : "shadow-hairline group-hover/theme:shadow-[0_0_0_1px_var(--line-strong)]"
              }`}
            >
              {theme === "system" ? (
                <>
                  <MiniWindow tone="light" />
                  <span className="absolute inset-0" style={{ clipPath: "polygon(58% 0, 100% 0, 100% 100%, 42% 100%)" }}>
                    <MiniWindow tone="dark" />
                  </span>
                </>
              ) : (
                <MiniWindow tone={theme} />
              )}
            </span>
            <span className="flex items-center gap-1.5 px-0.5 text-[12px] font-medium">
              <span className={selected ? "text-foreground" : "text-secondary"}>
                {theme === "system" ? "System" : theme === "light" ? "Light" : "Dark"}
              </span>
              {selected && (
                <svg viewBox="0 0 16 16" className="h-3 w-3 text-foreground" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m3.5 8.5 3 3 6-6.5" />
                </svg>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const FONT_LABEL: Record<Font, string> = { geist: "Geist", system: "System", serif: "Serif" };

function TypefaceTiles({ value, onChange }: { value: Font; onChange: (font: Font) => void }) {
  return (
    <div role="radiogroup" aria-label="Typeface" className="grid grid-cols-3 gap-2.5">
      {FONTS.map((font) => {
        const selected = font === value;
        return (
          <button
            key={font}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(font)}
            className={`dial-squircle flex h-[68px] flex-col items-start justify-between px-3 py-2.5 text-left transition-[background-color,box-shadow,transform] duration-200 ease-out-strong [--sq:10px] active:scale-[0.98] ${
              selected
                ? "bg-hover-2 shadow-[0_0_0_1.5px_var(--foreground)]"
                : "bg-hover shadow-hairline hover:bg-hover-2"
            }`}
          >
            <span
              className={`text-[22px] leading-none tracking-[-0.02em] ${selected ? "text-foreground" : "text-secondary"}`}
              style={{ fontFamily: FONT_STACKS[font] }}
            >
              Aa
            </span>
            <span className="text-[11.5px] font-medium text-muted">{FONT_LABEL[font]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A slider with a small glyph at each end, for the reading scales. */
function ScaleRow({
  title,
  value,
  children,
  low,
  high,
}: {
  title: string;
  value: string;
  children: ReactNode;
  low: ReactNode;
  high: ReactNode;
}) {
  return (
    <div className="py-2">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] font-medium text-foreground">{title}</span>
        <span className="font-mono text-[11px] text-muted">{value}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex w-4 shrink-0 justify-center text-muted" aria-hidden>
          {low}
        </span>
        <div className="min-w-0 flex-1">{children}</div>
        <span className="flex w-4 shrink-0 justify-center text-muted" aria-hidden>
          {high}
        </span>
      </div>
    </div>
  );
}

/** Frosted is a filled pane, clear an empty one. */
const GlassGlyph = ({ clear }: { clear: boolean }) => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
    <rect x="2.5" y="2.5" width="11" height="11" rx="3.5" fill={clear ? "none" : "currentColor"} fillOpacity={clear ? undefined : 0.35} />
    {clear && <path d="m5.5 10.5 5-5" strokeLinecap="round" opacity="0.6" />}
  </svg>
);

/** One chevron for slow water, two for fast. */
const SpeedGlyph = ({ fast }: { fast: boolean }) => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {fast ? <path d="m4 4.5 3.5 3.5L4 11.5M8.5 4.5 12 8l-3.5 3.5" /> : <path d="m6.5 4.5 3.5 3.5-3.5 3.5" />}
  </svg>
);

/** "0.5" → "½×": the ocean's speed as a multiplier, the way a player shows it. */
function speedText(factor: number): string {
  const whole = Math.floor(factor);
  const part = factor - whole;
  const fraction = part === 0.25 ? "¼" : part === 0.5 ? "½" : part === 0.75 ? "¾" : "";
  return `${whole > 0 || !fraction ? whole : ""}${fraction}×`;
}

/**
 * The composer's glass over the end of a conversation, so the transparency
 * slider shows what it does here rather than only under the composer behind
 * this dialog. It is the real material (`.dial-glass`), reading the same
 * root variables the slider writes.
 */
function GlassPreview() {
  return (
    <div
      aria-hidden
      className="dial-squircle relative mb-2 h-[100px] overflow-hidden bg-background shadow-hairline [--sq:11px]"
    >
      <p className="px-3.5 pt-3 text-[12.5px] leading-[1.6] text-foreground/85">
        Sharks hunt the edges of a school, where the stragglers swim. A dense
        school confuses them, so the fish at its centre are safer than the
        ones that wander off alone — and the whole school bolts when only its
        edge has seen the shark.
      </p>
      <div className="dial-glass absolute inset-x-2.5 bottom-2.5 flex h-[38px] items-center justify-between rounded-[14px] pl-3.5 pr-[5px]">
        <span className="text-[12.5px] text-muted">Ask anything…</span>
        <span className="dial-squircle flex size-7 items-center justify-center bg-foreground text-background [--sq:9px]">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.25 8h9.5M8.75 4l4 4-4 4" />
          </svg>
        </span>
      </div>
    </div>
  );
}

const WidthGlyph = ({ wide }: { wide: boolean }) => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
    {wide ? <path d="M2 5h12M2 8h12M2 11h9" /> : <path d="M5 5h6M5 8h6M5 11h4" />}
  </svg>
);

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
  titles = {},
  onOpenConversation,
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
  /** Conversation titles by thread id, for the storage browser. */
  titles?: Record<string, string>;
  /** Close settings and open this conversation. */
  onOpenConversation?: (threadId: string) => void;
  initialSection?: Section;
}) {
  const [section, setSection] = useState<Section>(initialSection);
  const [browsing, setBrowsing] = useState(false);
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

  const togglePlace = (place: OceanPlace, on: boolean) => {
    const next = new Set(settings.oceanPlaces);
    if (on) next.add(place);
    else next.delete(place);
    onUpdate({ oceanPlaces: OCEAN_PLACES.filter((p) => next.has(p)) });
  };

  const changeSection = (next: Section) => {
    setSection(next);
    setBrowsing(false);
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
        className="dial-squircle flex max-h-[86vh] w-full max-w-[500px] flex-col overflow-hidden bg-panel shadow-overlay [--sq:16px]"
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
              className="dial-squircle flex size-7 items-center justify-center text-muted transition-colors [--sq:8px] hover:bg-hover-2 hover:text-foreground"
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
              onChange={changeSection}
              labels={{
                account: "Account",
                instructions: "Instructions",
                privacy: "Privacy",
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
                      className="dial-squircle flex size-10 shrink-0 items-center justify-center bg-foreground text-[15px] font-semibold text-background [--sq:11px]"
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

                  <Row
                    label="OpenRouter key"
                    hint={
                      settings.openrouterKey
                        ? keyFingerprint(settings.openrouterKey)
                        : "not set"
                    }
                  >
                    <p className="mb-3 text-[12.5px] leading-relaxed text-secondary">
                      Requests go from this device straight to OpenRouter, so
                      the key is only ever used here.
                      {encrypted
                        ? " It is encrypted with your password before it is saved to your account."
                        : " It is saved to your account so it follows you between devices."}
                    </p>
                    {settings.openrouterKey ? (
                      <div className="flex items-center gap-2">
                        <code className="dial-squircle flex h-[30px] flex-1 items-center truncate bg-field px-3 font-mono text-[12px] text-secondary shadow-hairline [--sq:8px]">
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

                  <Row label="Session">
                    <Button size="xs" onClick={() => void onSignOut().then(onClose)}>
                      Sign out
                    </Button>
                    <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
                      Removes this device&apos;s unlock key. Your history stays in
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
                    className="dial-squircle mt-4 w-full bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-opacity [--sq:10px] hover:opacity-90"
                  >
                    Sign in or create an account
                  </button>
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

          {section === "privacy" &&
            (browsing ? (
              <div>
                <div className="sticky top-0 z-20 -mx-5 flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setBrowsing(false)}
                    aria-label="Back to privacy"
                    className="dial-squircle flex size-8 items-center justify-center text-muted transition-colors [--sq:9px] hover:bg-hover hover:text-foreground"
                  >
                    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M7.5 2.75 4.25 6l3.25 3.25" />
                    </svg>
                  </button>
                  <span className="text-[13px] font-medium text-foreground">Files</span>
                  <span className="ml-auto font-mono text-[10.5px] text-muted">
                    {encrypted ? "decrypted on this device" : "stored in your account"}
                  </span>
                </div>
                <StorageBrowser titles={titles} onOpenConversation={onOpenConversation} />
              </div>
            ) : (
              <div className="divide-y divide-line">
                {!user ? (
                  <p className="py-4 text-[13px] leading-relaxed text-secondary">
                    Sign in to see what your account keeps.
                  </p>
                ) : (
                  <>
                    <Row label="Chat history" hint={encrypted ? "end-to-end encrypted" : undefined}>
                      <p className="text-[12.5px] leading-relaxed text-secondary">
                        {encrypted
                          ? "Your password derives the key, so the server stores ciphertext it cannot read — messages, settings, images and attachments alike."
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
                            ? "This device keeps a non-exportable unlock key, so refreshes do not ask for your password."
                            : "The unlock key stays in memory only. Closing or refreshing the app asks for your password again."}
                        </p>
                        <Segmented
                          label="Device unlock"
                          value={settings.rememberDeviceKey ? "remember" : "lock"}
                          options={["remember", "lock"] as const}
                          onChange={(next) =>
                            onUpdate({ rememberDeviceKey: next === "remember" })
                          }
                          labels={{ remember: "Remember this device", lock: "Lock on exit" }}
                        />
                        <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
                          A synced preference — the key itself never leaves this device.
                        </p>
                      </Row>
                    )}

                    <Row label="Storage">
                      {usage ? (
                        <div className="space-y-3.5">
                          <Meter
                            label="Files"
                            used={usage.blobBytes}
                            total={usage.blobQuota}
                            detail={`${formatBytes(usage.blobBytes)} of ${formatBytes(usage.blobQuota)}`}
                          />
                          <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] text-muted">
                            <span>
                              {usage.threads === 1 ? "1 conversation" : `${usage.threads} conversations`}
                              {" · "}
                              {usage.messages === 1 ? "1 message" : `${usage.messages} messages`}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <p className="font-mono text-[11px] text-muted">reading…</p>
                      )}
                      <button
                        type="button"
                        onClick={() => setBrowsing(true)}
                        className="dial-squircle group/files mt-3.5 flex w-full items-center gap-3 bg-hover px-3 py-2.5 text-left transition-colors duration-150 [--sq:10px] hover:bg-hover-2"
                      >
                        <span className="dial-squircle flex size-8 shrink-0 items-center justify-center bg-panel text-secondary shadow-hairline [--sq:9px]">
                          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <rect x="2" y="2" width="5" height="5" rx="1.3" />
                            <rect x="9" y="2" width="5" height="5" rx="1.3" />
                            <rect x="2" y="9" width="5" height="5" rx="1.3" />
                            <rect x="9" y="9" width="5" height="5" rx="1.3" />
                          </svg>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-medium text-foreground">
                            Browse files
                          </span>
                          {/* No count here: the account's object count includes
                              records spilled to R2, which are not files. */}
                          <span className="block text-[11.5px] text-muted">
                            Images and attachments{encrypted ? ", decrypted on this device" : ""}
                          </span>
                        </span>
                        <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-muted transition-transform duration-200 group-hover/files:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="m4.5 2.75 3.25 3.25-3.25 3.25" />
                        </svg>
                      </button>
                    </Row>
                  </>
                )}
              </div>
            ))}

          {section === "appearance" && (
            <div className="divide-y divide-line">
              <Row label="Theme">
                <ThemeCards value={settings.theme} onChange={(theme) => onUpdate({ theme })} />
              </Row>

              <Row label="Typeface" hint={settings.font === "system" ? "no webfont" : undefined}>
                <TypefaceTiles value={settings.font} onChange={(font) => onUpdate({ font })} />
              </Row>

              <Row label="Reading">
                <ScaleRow
                  title="Text size"
                  value={settings.textSize}
                  low={<span className="text-[10px] font-medium">A</span>}
                  high={<span className="text-[15px] font-medium">A</span>}
                >
                  <StepSlider
                    size="sm"
                    label="Text size"
                    value={settings.textSize}
                    options={TEXT_SIZES}
                    onChange={(textSize) => onUpdate({ textSize })}
                    valueText={(size) => size}
                  />
                </ScaleRow>
                <ScaleRow
                  title="Column width"
                  value={settings.width}
                  low={<WidthGlyph wide={false} />}
                  high={<WidthGlyph wide />}
                >
                  <StepSlider
                    size="sm"
                    label="Column width"
                    value={settings.width}
                    options={WIDTHS}
                    onChange={(width) => onUpdate({ width })}
                    valueText={(width) => width}
                  />
                </ScaleRow>
                <SwitchRow
                  title="Compact spacing"
                  detail="Less room between messages."
                  checked={settings.density === "compact"}
                  onChange={(compact) => onUpdate({ density: compact ? "compact" : "comfortable" })}
                />
              </Row>

              <Row label="Glass">
                <GlassPreview />
                <ScaleRow
                  title="Transparency"
                  value={settings.glass}
                  low={<GlassGlyph clear={false} />}
                  high={<GlassGlyph clear />}
                >
                  <StepSlider
                    size="sm"
                    label="Glass transparency"
                    value={settings.glass}
                    options={GLASS_LEVELS}
                    onChange={(glass) => onUpdate({ glass })}
                    valueText={(glass) => glass}
                  />
                </ScaleRow>
              </Row>

              <Row label="ASCII ocean">
                <div
                  className={`dial-squircle relative h-[104px] overflow-hidden bg-background shadow-hairline transition-opacity duration-300 [--sq:11px] ${
                    settings.ocean ? "" : "opacity-35"
                  }`}
                >
                  <Ocean
                    place="preview"
                    className="h-full w-full"
                    sharks={[
                      { kind: "classic", size: 0.5 },
                      { kind: "hammerhead", size: 0.42 },
                    ]}
                    fishCount={30}
                  />
                </div>
                <div className="mt-2.5">
                  <SwitchRow
                    title="Sharks and fish"
                    detail="Drawn in text, swimming behind the app."
                    checked={settings.ocean}
                    onChange={(ocean) => onUpdate({ ocean })}
                  />
                  <div
                    inert={!settings.ocean}
                    className={`transition-opacity duration-200 ${settings.ocean ? "" : "opacity-45"}`}
                  >
                    <ScaleRow
                      title="Swim speed"
                      value={speedText(OCEAN_SPEED_FACTOR[settings.oceanSpeed])}
                      low={<SpeedGlyph fast={false} />}
                      high={<SpeedGlyph fast />}
                    >
                      <StepSlider
                        size="sm"
                        label="Swim speed"
                        value={settings.oceanSpeed}
                        options={OCEAN_SPEEDS}
                        onChange={(oceanSpeed) => onUpdate({ oceanSpeed })}
                        valueText={(speed) => speedText(OCEAN_SPEED_FACTOR[speed])}
                      />
                    </ScaleRow>
                  </div>
                </div>
                <div
                  className={`mt-1 border-t border-line pt-1 transition-opacity duration-200 ${
                    settings.ocean ? "" : "pointer-events-none"
                  }`}
                >
                  {OCEAN_PLACES.map((place) => (
                    <SwitchRow
                      key={place}
                      title={OCEAN_LABEL[place].title}
                      detail={OCEAN_LABEL[place].detail}
                      checked={settings.oceanPlaces.includes(place)}
                      onChange={(on) => togglePlace(place, on)}
                      disabled={!settings.ocean}
                    />
                  ))}
                </div>
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

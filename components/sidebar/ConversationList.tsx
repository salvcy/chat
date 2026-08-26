"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import AccountButton from "./AccountButton";
import type { SessionUser } from "@/lib/auth-client";
import type { ConversationMeta } from "@/lib/db";
import type { SyncStatus } from "@/lib/session";
import { formatCost, groupForDate } from "@/lib/format";
import { shortModelId } from "@/lib/capabilities";

/**
 * The conversation rail.
 *
 * It sits on the *same ground* as the transcript, divided only by a hairline —
 * glass is for things that float (the composer, the palette); a rail pinned to
 * the edge should recede. Rows are quiet and the active thread is the single
 * inverted element: state by inversion, never colour.
 *
 * Density: each row is two tight lines (title, then model · cost in mono).
 * The action menu overlays the title only while it is needed, so it never
 * reserves a permanent right column or pulls metadata away from the edge.
 */
export default function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onTogglePin,
  onExport,
  account,
}: {
  conversations: ConversationMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
  onExport: (id: string) => void;
  /** Footer state, passed in so the rail itself stays free of app concerns. */
  account: {
    user: SessionUser | null;
    status: SyncStatus;
    onOpen: () => void;
  };
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      const row =
        target instanceof Element
          ? target.closest<HTMLElement>("[data-history-row]")
          : null;
      if (row?.dataset.historyRow !== menuOpen) {
        setMenuOpen(null);
        setConfirmDelete(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(null);
      setConfirmDelete(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const commitRename = (id: string) => {
    const t = draft.trim();
    if (t) onRename(id, t);
    setEditing(null);
  };

  /** Filtered, then split into pinned + date buckets, order preserved. */
  const sections = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const rows = term
      ? conversations.filter(
          (c) =>
            c.title.toLowerCase().includes(term) ||
            c.model.toLowerCase().includes(term),
        )
      : conversations;

    const out: Array<{ label: string; rows: ConversationMeta[] }> = [];
    let bucket: string | null = null;
    for (const c of rows) {
      const label = c.pinned ? "pinned" : groupForDate(c.updatedAt);
      if (label !== bucket) {
        out.push({ label, rows: [] });
        bucket = label;
      }
      out[out.length - 1].rows.push(c);
    }
    return out;
  }, [conversations, filter]);

  // The aside owns the rounded border, so it must not be the scroll container:
  // its track would run the full height and straight into the top corners,
  // reading as a bar bleeding past the header. Only the list below scrolls.
  return (
    <aside className="flex h-full w-full flex-col overflow-hidden rounded-[18px] border border-hairline bg-panel shadow-[0_14px_45px_var(--shadow)]">
      <div className="shrink-0 bg-panel px-2.5 pb-2 pt-2.5">
        <div className="flex gap-1.5">
          <button
            onClick={onNew}
            title="New chat (⌘⇧K)"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-hairline bg-surface px-3 py-2 text-left text-[12px] text-secondary transition-colors hover:border-hairline-strong hover:bg-surface-strong hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
            <span className="truncate">new chat</span>
          </button>

          <button
            type="button"
            disabled={conversations.length === 0}
            aria-label={searchOpen ? "Close conversation search" : "Search conversations"}
            aria-expanded={searchOpen}
            title="Search conversations"
            onClick={() => {
              if (searchOpen) setFilter("");
              setSearchOpen((open) => !open);
            }}
            className={`flex w-9 shrink-0 items-center justify-center rounded-xl border transition-colors disabled:cursor-default disabled:opacity-30 ${
              searchOpen
                ? "border-hairline-strong bg-surface-strong text-foreground"
                : "border-hairline bg-surface text-muted hover:border-hairline-strong hover:bg-surface-strong hover:text-foreground"
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
              <circle cx="6.75" cy="6.75" r="3.75" />
              <path d="m9.65 9.65 3.1 3.1" />
            </svg>
          </button>
        </div>

        <AnimatePresence initial={false}>
          {searchOpen && conversations.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0, y: -3 }}
              animate={{ height: "auto", opacity: 1, y: 0 }}
              exit={{ height: 0, opacity: 0, y: -3 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              className="relative overflow-hidden"
            >
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                className="pointer-events-none absolute bottom-2.5 left-2.5 h-3 w-3 text-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
              >
                <circle cx="6.75" cy="6.75" r="3.75" />
                <path d="m9.65 9.65 3.1 3.1" />
              </svg>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  setFilter("");
                  setSearchOpen(false);
                }}
                aria-label="Search conversations"
                placeholder="search chats…"
                className="mt-2 w-full rounded-xl border border-hairline bg-background/35 py-1.5 pl-7 pr-7 font-mono text-[10px] text-foreground outline-none placeholder:text-muted focus:border-hairline-strong"
              />
              {filter && (
                <button
                  type="button"
                  aria-label="Clear conversation search"
                  title="Clear search"
                  onClick={() => setFilter("")}
                  className="absolute bottom-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-md font-mono text-[12px] text-muted transition-colors hover:bg-surface-strong hover:text-foreground"
                >
                  ×
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="dial-scroll-none min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-6">
        {conversations.length === 0 && (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <span className="mb-3 flex h-8 w-8 items-center justify-center rounded-xl border border-hairline font-mono text-[11px] text-muted">
              ◫
            </span>
            <p className="text-[11px] text-muted">Your conversations will appear here.</p>
          </div>
        )}
        {conversations.length > 0 && sections.length === 0 && (
          <p className="px-2 py-6 text-center font-mono text-[10px] text-muted">
            nothing matches
          </p>
        )}

        {sections.map((section) => (
          <div key={section.label}>
            <p className="truncate px-2.5 pb-1 pt-3.5 font-mono text-[8px] uppercase tracking-[0.16em] text-muted/60">
              {section.label}
            </p>

            {section.rows.map((c) => {
              const active = c.id === activeId;
              return (
                <motion.div
                  key={c.id}
                  data-history-row={c.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className={`group relative ${menuOpen === c.id ? "z-20" : ""}`}
                >
                  {editing === c.id ? (
                    <input
                      className="w-full rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12px] text-foreground outline-none"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(c.id);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <div
                        className={`relative overflow-hidden rounded-xl border transition-colors ${
                          active || menuOpen === c.id
                            ? "border-hairline-strong bg-surface"
                            : "border-transparent group-hover:border-hairline group-hover:bg-surface"
                        }`}
                      >
                        <button
                          className={`min-w-0 w-full px-2.5 py-2 text-left transition-colors ${
                            active ? "text-foreground" : "text-secondary group-hover:text-foreground"
                          }`}
                          onClick={() => onSelect(c.id)}
                          title={c.title}
                        >
                          <span
                            className={`flex items-center gap-1.5 transition-[padding] ${
                              menuOpen === c.id ? "pr-7" : "group-hover:pr-7"
                            }`}
                          >
                            {c.pinned && (
                              <span className="shrink-0 text-[7px] leading-none opacity-50">
                                ●
                              </span>
                            )}
                            <span className="block truncate text-[12px] leading-snug">
                              {c.title}
                            </span>
                          </span>
                          <span className="flex min-w-0 items-baseline gap-1 font-mono text-[9px] leading-tight text-muted">
                            <span className="min-w-0 truncate">
                              {shortModelId(c.model)}
                            </span>
                            {c.totalCostUsd ? (
                              <span className="ml-auto shrink-0 tabular-nums">
                                {formatCost(c.totalCostUsd)}
                              </span>
                            ) : null}
                          </span>
                        </button>

                        <button
                          type="button"
                          aria-label={`Actions for ${c.title}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen === c.id}
                          aria-controls={`history-actions-${c.id}`}
                          onClick={() => {
                            setConfirmDelete(null);
                            setMenuOpen((current) =>
                              current === c.id ? null : c.id,
                            );
                          }}
                          className={`absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-all hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-80 ${
                            menuOpen === c.id
                              ? "pointer-events-auto opacity-100"
                              : "pointer-events-none opacity-0"
                          }`}
                        >
                          <svg
                            viewBox="0 0 16 16"
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          >
                            <circle cx="3.25" cy="8" r="1" fill="currentColor" />
                            <circle cx="8" cy="8" r="1" fill="currentColor" />
                            <circle cx="12.75" cy="8" r="1" fill="currentColor" />
                          </svg>
                        </button>
                      </div>

                      {menuOpen === c.id && (
                        <motion.div
                          id={`history-actions-${c.id}`}
                          role="menu"
                          aria-label={`Actions for ${c.title}`}
                          initial={{ opacity: 0, y: -3, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          transition={{ duration: 0.12, ease: "easeOut" }}
                          className="absolute right-0 top-[calc(100%-2px)] z-30 w-36 rounded-xl border border-hairline-strong bg-panel p-1 shadow-[0_14px_40px_var(--shadow)]"
                        >
                          <HistoryAction
                            label={c.pinned ? "unpin" : "pin"}
                            onClick={() => {
                              onTogglePin(c.id);
                              setMenuOpen(null);
                            }}
                          />
                          <HistoryAction
                            label="export"
                            onClick={() => {
                              onExport(c.id);
                              setMenuOpen(null);
                            }}
                          />
                          <HistoryAction
                            label="rename"
                            onClick={() => {
                              setDraft(c.title);
                              setEditing(c.id);
                              setMenuOpen(null);
                            }}
                          />
                          <HistoryAction
                            label={confirmDelete === c.id ? "delete?" : "delete"}
                            danger={confirmDelete === c.id}
                            onClick={() => {
                              if (confirmDelete !== c.id) {
                                setConfirmDelete(c.id);
                                return;
                              }
                              onDelete(c.id);
                              setConfirmDelete(null);
                              setMenuOpen(null);
                            }}
                          />
                        </motion.div>
                      )}
                    </>
                  )}
                </motion.div>
              );
            })}
          </div>
        ))}
      </div>

      <AccountButton
        user={account.user}
        status={account.status}
        onOpen={account.onOpen}
      />
    </aside>
  );
}

function HistoryAction({
  label,
  danger = false,
  onClick,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left font-mono text-[10px] transition-colors ${
        danger
          ? "bg-invert-fill text-invert-text"
          : "text-muted hover:bg-surface-strong hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import AccountButton from "./AccountButton";
import GlideMenu from "@/components/ui/GlideMenu";
import BrandMark from "@/components/ui/BrandMark";
import type { SessionUser } from "@/lib/auth-client";
import type { ConversationMeta } from "@/lib/store";
import type { SyncStatus } from "@/lib/session";
import { formatCost, groupForDate } from "@/lib/format";
import { shortModelId } from "@/lib/capabilities";

/**
 * The conversation rail.
 *
 * Structure follows Beautiful UI's SidebarNav (beautifului.dev, MIT): a brand
 * row, primary actions, then a "Chats" header whose search control grows
 * right-to-left into a field. It sits directly on the page — no card, no
 * border — so it recedes behind the chat window, which is the one lifted
 * surface.
 *
 * Rows are one line. They used to be two (title, then model · cost in mono),
 * which doubled the rail's height for numbers that are one hover away in the
 * row's tooltip and always visible for the open thread in the status strip.
 * A single highlight glides between rows on hover rather than each row
 * painting its own; the open thread keeps a quiet fill of its own. State by
 * fill, never colour.
 */

const SEARCH_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const SECTION_LABEL: Record<string, string> = {
  pinned: "Pinned",
  today: "Today",
  yesterday: "Yesterday",
  "this week": "This week",
  "this month": "This month",
};

function sectionLabel(label: string): string {
  return SECTION_LABEL[label] ?? label.charAt(0).toUpperCase() + label.slice(1);
}

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
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  const openSearch = () => {
    setSearchOpen(true);
    // Focus after the field has started to grow, so the caret lands in it
    // rather than on a zero-width input.
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setFilter("");
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

  // Fade an edge of the list only where there is more beyond it
  // (`.dial-scroll-edges`): rows slip under the header and the footer
  // instead of being cut off at a line.
  const edges = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    list.toggleAttribute("data-above", list.scrollTop > 1);
    list.toggleAttribute(
      "data-below",
      list.scrollTop + list.clientHeight < list.scrollHeight - 1,
    );
  }, []);

  useLayoutEffect(() => edges(), [sections, edges]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(edges);
    observer.observe(list);
    return () => observer.disconnect();
  }, [edges]);

  return (
    <aside className="flex h-full w-full flex-col pr-1">
      {/* The first row: the mark, then New chat. It is as tall as the chat
          window's top strip and starts as far down, so the two share one
          centre line. The desktop app has no mark: its traffic lights sit
          on that line in its place (globals.css, "the desktop app's
          window"). */}
      <div className="flex h-12 shrink-0 items-center gap-2">
        <BrandMark withName={false} className="dial-rail-brand shrink-0 pl-2.5" />
        <GlideMenu
          className="dial-rail-new @container min-w-0 flex-1"
          highlightClassName="inset-x-0 rounded-control bg-hover-2"
        >
          <button
            data-glide-row
            type="button"
            onClick={onNew}
            title="New chat (⌘⇧K)"
            className="group/new relative z-10 flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-[13.5px] font-medium text-secondary transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.99]"
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <Glyph>
                <path d="M11.2 2.8a1.7 1.7 0 0 1 2.4 2.4L7.4 11.4l-3.1.8.8-3.1Z" />
                <path d="M13 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3.5" />
              </Glyph>
            </span>
            <span className="flex-1 truncate">New chat</span>
            {/* Only where the row has room for it: after the mark, or the
                desktop app's traffic lights, a narrow rail needs the space
                for the label. */}
            <span className="hidden font-mono text-[10.5px] text-muted opacity-0 transition-opacity group-hover/new:opacity-100 lg:@min-[9.5rem]:inline">
              ⌘⇧K
            </span>
          </button>
        </GlideMenu>
      </div>

      {/* chats header — label, and a search control that grows into a field */}
      <div className="relative mx-0 mb-1 mt-2 h-8 shrink-0">
        <div
          aria-hidden={searchOpen}
          className={`absolute inset-0 flex items-center px-2 text-[12px] font-medium text-muted transition-[opacity,transform] duration-200 ${
            searchOpen ? "pointer-events-none -translate-x-1 opacity-0" : "opacity-100"
          }`}
        >
          Chats
          {conversations.length > 0 && (
            <span className="ml-1.5 font-mono text-[10.5px] tabular-nums opacity-60">
              {conversations.length}
            </span>
          )}
        </div>

        <button
          type="button"
          aria-label="Search conversations"
          aria-expanded={searchOpen}
          disabled={conversations.length === 0}
          onClick={openSearch}
          className={`absolute right-0 top-0 z-10 flex size-8 items-center justify-center rounded-control text-muted transition-[opacity,background-color,color,transform] duration-200 hover:bg-hover-2 hover:text-foreground active:scale-[0.96] disabled:opacity-30 ${
            searchOpen ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          <Glyph>
            <circle cx="7" cy="7" r="4.25" />
            <path d="m10.25 10.25 3.25 3.25" />
          </Glyph>
        </button>

        <div
          className={`absolute right-0 top-0 z-20 flex h-8 items-center overflow-hidden rounded-control bg-field text-muted shadow-hairline transition-[width,opacity] focus-within:text-secondary ${
            searchOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
          }`}
          style={{
            width: searchOpen ? "100%" : 32,
            transitionDuration: "200ms",
            transitionTimingFunction: SEARCH_EASE,
          }}
        >
          <span className="ml-2 flex shrink-0">
            <Glyph>
              <circle cx="7" cy="7" r="4.25" />
              <path d="m10.25 10.25 3.25 3.25" />
            </Glyph>
          </span>
          <input
            ref={searchRef}
            value={filter}
            tabIndex={searchOpen ? 0 : -1}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
            }}
            placeholder="Search chats"
            aria-label="Search conversations"
            className="ml-1.5 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted"
          />
          <button
            type="button"
            aria-label="Close search"
            tabIndex={searchOpen ? 0 : -1}
            onClick={closeSearch}
            className="flex size-8 shrink-0 items-center justify-center rounded-control transition-colors hover:bg-hover-2 hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>

      {/* the list */}
      <div
        ref={listRef}
        onScroll={edges}
        className="dial-scroll-none dial-scroll-edges min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-6"
      >
        {conversations.length === 0 && (
          <p className="px-2 py-3 text-[12.5px] leading-relaxed text-muted">
            Your conversations will appear here.
          </p>
        )}
        {conversations.length > 0 && sections.length === 0 && (
          <p className="px-2 py-3 text-[12.5px] text-muted">
            Nothing matches “{filter.trim()}”.
          </p>
        )}

        <GlideMenu highlightClassName="inset-x-0 rounded-control bg-hover">
          {sections.map((section, sectionIndex) => (
            <div key={section.label}>
              <p
                className={`truncate px-2 pb-1 text-[11.5px] font-medium text-muted/80 ${
                  sectionIndex === 0 ? "pt-1" : "pt-4"
                }`}
              >
                {sectionLabel(section.label)}
              </p>

              {section.rows.map((c) => {
                const active = c.id === activeId;
                const menu = menuOpen === c.id;
                const tooltip = [
                  c.title,
                  shortModelId(c.model),
                  c.totalCostUsd ? formatCost(c.totalCostUsd) : null,
                ]
                  .filter(Boolean)
                  .join(" · ");

                if (editing === c.id) {
                  return (
                    <div key={c.id} className="py-px">
                      <input
                        className="dial-input h-8! px-2! text-[13.5px]!"
                        value={draft}
                        aria-label="Conversation title"
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitRename(c.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(c.id);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        autoFocus
                      />
                    </div>
                  );
                }

                return (
                  <div
                    key={c.id}
                    data-history-row={c.id}
                    className={`group relative ${menu ? "z-20" : ""}`}
                  >
                    <button
                      data-glide-row
                      onClick={() => onSelect(c.id)}
                      title={tooltip}
                      aria-current={active ? "page" : undefined}
                      className={`relative z-10 flex h-8 w-full items-center rounded-control px-2 text-left text-[13.5px] transition-[color,background-color] duration-150 ${
                        active
                          ? "bg-hover-2 font-medium text-foreground"
                          : "text-secondary hover:text-foreground"
                      }`}
                    >
                      <span
                        className={`min-w-0 flex-1 truncate transition-[padding] duration-150 ${
                          menu ? "pr-6" : "group-hover:pr-6"
                        }`}
                      >
                        {c.title}
                      </span>
                    </button>

                    <button
                      type="button"
                      aria-label={`Actions for ${c.title}`}
                      aria-haspopup="menu"
                      aria-expanded={menu}
                      aria-controls={`history-actions-${c.id}`}
                      onClick={() => {
                        setConfirmDelete(null);
                        setMenuOpen((current) => (current === c.id ? null : c.id));
                      }}
                      className={`absolute right-1 top-1 z-20 flex size-6 items-center justify-center rounded-chip text-muted transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 ${
                        menu
                          ? "pointer-events-auto bg-hover-2 text-foreground opacity-100"
                          : "pointer-events-none opacity-0"
                      }`}
                    >
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
                        <circle cx="3.25" cy="8" r="1.1" fill="currentColor" />
                        <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                        <circle cx="12.75" cy="8" r="1.1" fill="currentColor" />
                      </svg>
                    </button>

                    {menu && (
                      <div
                        id={`history-actions-${c.id}`}
                        role="menu"
                        aria-label={`Actions for ${c.title}`}
                        className="absolute right-0 top-[calc(100%+4px)] z-30 w-44 origin-top-right rounded-card bg-panel p-1 shadow-overlay"
                        style={{ animation: "dial-pop-in 160ms cubic-bezier(0.23,1,0.32,1) both" }}
                      >
                        <GlideMenu highlightClassName="inset-x-0 rounded-chip bg-hover-2">
                          <HistoryAction
                            label={c.pinned ? "Unpin" : "Pin to top"}
                            icon={
                              <path d="M6 2.5h4M6.75 2.5v3.75L4.5 9h7L9.25 6.25V2.5M8 9v4.5" />
                            }
                            onClick={() => {
                              onTogglePin(c.id);
                              setMenuOpen(null);
                            }}
                          />
                          <HistoryAction
                            label="Rename"
                            icon={<path d="M11.2 2.8a1.7 1.7 0 0 1 2.4 2.4L6 12.8l-3.2.8.8-3.2Z" />}
                            onClick={() => {
                              setDraft(c.title);
                              setEditing(c.id);
                              setMenuOpen(null);
                            }}
                          />
                          <HistoryAction
                            label="Export Markdown"
                            icon={<path d="M8 2.5v8M4.75 7.5 8 10.75l3.25-3.25M3 13.5h10" />}
                            onClick={() => {
                              onExport(c.id);
                              setMenuOpen(null);
                            }}
                          />
                          <div className="mx-1 my-1 h-px bg-line" />
                          <HistoryAction
                            label={confirmDelete === c.id ? "Click again to delete" : "Delete"}
                            danger={confirmDelete === c.id}
                            icon={
                              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" />
                            }
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
                        </GlideMenu>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </GlideMenu>
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
  icon,
  danger = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-glide-row
      onClick={onClick}
      className={`relative z-10 flex h-8 w-full items-center gap-2 rounded-chip px-2 text-left text-[13px] transition-colors ${
        danger ? "bg-invert-fill text-invert-text" : "text-foreground"
      }`}
    >
      <span className={danger ? "" : "text-muted"}>
        <Glyph>{icon}</Glyph>
      </span>
      {label}
    </button>
  );
}

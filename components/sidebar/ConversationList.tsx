"use client";

import type { ConversationMeta } from "@/lib/db";
import { motion } from "motion/react";
import { useState } from "react";

/**
 * Conversation rail — glass, cohesive with the composer. The brand sits at
 * the top, "+ new chat" is a hairline capsule, threads are quiet rows with
 * the active one inverted. Monochrome glyph controls on hover.
 */
export default function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  conversations: ConversationMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const commitRename = (id: string) => {
    const t = draft.trim();
    if (t) onRename(id, t);
    setEditing(null);
  };

  return (
    <aside className="dial-scroll flex h-full w-full flex-col overflow-y-auto bg-surface backdrop-blur-[20px]">
      <div className="sticky top-0 z-10 bg-surface/60 px-4 pb-2 pt-5 backdrop-blur-[20px]">
        <div className="flex items-center justify-between">
          <span className="font-mono text-sm tracking-tight text-foreground">
            dial
          </span>
          <button
            onClick={onNew}
            title="New chat"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-hairline text-muted transition-colors hover:bg-background/50 hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 px-2 pb-4 pt-1">
        {conversations.length === 0 && (
          <p className="px-3 py-8 text-center font-mono text-[11px] leading-relaxed text-muted">
            no conversations yet
          </p>
        )}
        {conversations.map((c) => {
          const active = c.id === activeId;
          return (
            <motion.div
              key={c.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="group relative mt-0.5"
            >
              {editing === c.id ? (
                <input
                  className="w-full rounded-lg bg-background px-3 py-2 font-mono text-[13px] text-foreground outline-none ring-1 ring-hairline"
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
                <button
                  className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
                    active
                      ? "bg-invert-fill text-invert-text"
                      : "text-foreground hover:bg-background/40"
                  }`}
                  onClick={() => onSelect(c.id)}
                >
                  <span className="block truncate text-[13px] leading-snug">
                    {c.title}
                  </span>
                  <span
                    className={`mt-0.5 block truncate font-mono text-[10px] ${
                      active ? "opacity-60" : "text-muted"
                    }`}
                  >
                    {c.model.split("/")[1] ?? c.model}
                  </span>
                </button>
              )}

              {editing !== c.id && !active && (
                <div className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex">
                  {confirmDelete === c.id ? (
                    <button
                      className="rounded-md bg-invert-fill px-1.5 py-0.5 font-mono text-[10px] text-invert-text"
                      onClick={() => {
                        onDelete(c.id);
                        setConfirmDelete(null);
                      }}
                      onMouseLeave={() => setConfirmDelete(null)}
                    >
                      del?
                    </button>
                  ) : (
                    <>
                      <button
                        className="rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-foreground"
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDraft(c.title);
                          setEditing(c.id);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-foreground"
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(c.id);
                        }}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </aside>
  );
}

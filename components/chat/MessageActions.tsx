"use client";

import CopyButton from "@/components/ui/CopyButton";

/**
 * Per-message controls — copy, regenerate, edit, branch. These were listed
 * as v1 core features and never shipped; without them the only way to fix a
 * bad turn was to retype it.
 *
 * They stay invisible until the message is hovered so the transcript reads
 * as prose, not as a toolbar grid.
 */

function Action({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground"
    >
      {children}
    </button>
  );
}

export default function MessageActions({
  text,
  onRegenerate,
  onEdit,
  onBranch,
  align = "left",
}: {
  text: string;
  onRegenerate?: () => void;
  onEdit?: () => void;
  onBranch?: () => void;
  align?: "left" | "right";
}) {
  return (
    <div
      className={`message-actions flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 ${
        align === "right" ? "justify-end" : ""
      }`}
    >
      <CopyButton text={text} label="Copy message" />

      {onEdit && (
        <Action onClick={onEdit} title="Edit and resend">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11.2 2.8a1.7 1.7 0 0 1 2.4 2.4L6 12.8l-3.2.8.8-3.2Z" />
          </svg>
        </Action>
      )}

      {onRegenerate && (
        <Action onClick={onRegenerate} title="Regenerate">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" />
            <path d="M13.5 2.5V6H10" />
          </svg>
        </Action>
      )}

      {onBranch && (
        <Action onClick={onBranch} title="Branch into a new conversation">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="4.5" cy="3.5" r="1.75" />
            <circle cx="4.5" cy="12.5" r="1.75" />
            <circle cx="11.5" cy="8" r="1.75" />
            <path d="M4.5 5.25v5.5M6.25 3.9c2.5.4 3.4 1.6 3.6 3.4M6.25 12.1c2.5-.4 3.4-1.6 3.6-3.4" />
          </svg>
        </Action>
      )}
    </div>
  );
}

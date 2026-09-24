"use client";

import Image from "next/image";
import FileGlyph from "./FileGlyph";
import type { FileUIPart } from "ai";
import { useEffect, useRef, useState } from "react";
import Dropdown from "@/components/ui/Dropdown";
import {
  capabilitiesFor,
  effortOptions,
  modelFor,
  shortModelId,
  unavailableReason,
} from "@/lib/capabilities";
import type {
  ChatSettings,
  OpenRouterModel,
  ReasoningEffort,
} from "@/lib/types";

/**
 * The bottom instrument.
 *
 * The selected model already lives in the context bar, so repeating it here
 * only made the composer noisy. This surface owns the things that affect the
 * next turn: files, explicit tools, thinking effort, web access, and
 * conversation guidance.
 */
export default function Composer({
  input,
  setInput,
  onSend,
  onStop,
  busy,
  imageMode,
  imageModel,
  imageModelIsFallback,
  onSelectImageTool,
  onRemoveImageTool,
  settings,
  onSettingsChange,
  models,
  onOpenSystemPrompt,
  attachments,
  attachmentError,
  onAttachFiles,
  onRemoveAttachment,
  onHeightSettled,
  focusToken = 0,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  imageMode: boolean;
  imageModel: string;
  /** True when the chat model can't emit images, so @image uses a stand-in. */
  imageModelIsFallback: boolean;
  onSelectImageTool: () => void;
  onRemoveImageTool: () => void;
  settings: ChatSettings;
  onSettingsChange: (patch: Partial<ChatSettings>) => void;
  models: OpenRouterModel[];
  onOpenSystemPrompt: () => void;
  attachments: FileUIPart[];
  attachmentError: string | null;
  onAttachFiles: (files: FileList) => void;
  onRemoveAttachment: (index: number) => void;
  /** Re-anchor the transcript after textarea auto-sizing has finished. */
  onHeightSettled?: () => void;
  /** Bumped by the parent to put the caret at the end of the field. */
  focusToken?: number;
}) {
  const canSend =
    !busy &&
    (imageMode
      ? input.trim().length > 0
      : input.trim().length > 0 || attachments.length > 0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "0px";
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
      onHeightSettled?.();
    };
    fit();
    const raf = requestAnimationFrame(fit);
    void document.fonts?.ready.then(fit).catch(() => {});
    return () => cancelAnimationFrame(raf);
  }, [input, onHeightSettled]);

  useEffect(() => {
    if (!focusToken) return;
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusToken]);

  const caps = capabilitiesFor(settings.model, models);
  const entry = modelFor(settings.model, models);
  const efforts = effortOptions(caps);
  const searchReason = unavailableReason("search", caps);
  const hasSystem = settings.system.trim().length > 0;
  // Always available now: a PDF can go to any model, because OpenRouter
  // converts it for the ones that cannot read files. Whether *images* are
  // accepted is enforced per file at intake, not by hiding the control.
  const canAttach = true;
  const toolMention = imageMode ? null : input.match(/^@([a-z]*)$/i)?.[1];
  const showImageSuggestion =
    toolMention !== null &&
    toolMention !== undefined &&
    "image".startsWith(toolMention.toLowerCase());
  const imageModelLabel = shortModelId(imageModel);
  // Naming a model the user never picked reads as "the tool forces this one".
  // Say *why*: image generation needs image output, which most models — even
  // vision models, which only read images — simply don't have.
  const imageModelNote = imageModelIsFallback
    ? `${shortModelId(settings.model)} can't create images · using ${imageModelLabel}`
    : `Generate with ${imageModelLabel}`;
  const activateImageTool = () => {
    onSelectImageTool();
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const pill = (on: boolean) =>
    `flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-35 ${
      on
        ? "bg-foreground text-background"
        : "text-secondary hover:bg-hover-2 hover:text-foreground"
    }`;

  return (
    <div className="px-3 pb-3 pt-2 sm:px-5">
      <div
        className={`composer-surface relative rounded-[20px] ${
          dragging ? "bg-field" : ""
        }`}
        onDragEnter={(e) => {
          e.preventDefault();
          if (canAttach) setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (canAttach && e.dataTransfer.files.length > 0) {
            onAttachFiles(e.dataTransfer.files);
          }
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-1.5 z-10 flex items-center justify-center rounded-[15px] border border-dashed border-line-strong bg-panel/90 text-[13px] font-medium text-secondary backdrop-blur-sm">
            Drop images or PDFs
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {attachments.map((file, index) => (
              <div
                key={`${file.url.slice(0, 40)}-${index}`}
                title={file.filename ?? undefined}
                className="group/file relative h-16 w-16 shrink-0 overflow-hidden rounded-card bg-field shadow-hairline"
                style={{ animation: "dial-pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}
              >
                {file.mediaType.startsWith("image/") ? (
                  <Image
                    unoptimized
                    src={file.url}
                    alt={file.filename ?? `Attachment ${index + 1}`}
                    width={64}
                    height={64}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <FileGlyph
                    kind={file.mediaType}
                    className="h-full w-full text-muted"
                  />
                )}
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(index)}
                  aria-label={`Remove ${file.filename ?? "attachment"}`}
                  className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-panel/95 text-foreground opacity-0 shadow-btn transition-opacity group-hover/file:opacity-100 focus-visible:opacity-100"
                >
                  <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="m4 4 8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          className="dial-scroll block max-h-[220px] min-h-[54px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15.5px] leading-relaxed text-foreground outline-none placeholder:text-muted sm:px-[18px]"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            if (canAttach && e.clipboardData.files.length > 0) {
              e.preventDefault();
              onAttachFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (showImageSuggestion) {
                activateImageTool();
                return;
              }
              onSend();
            }
          }}
          placeholder={
            busy
              ? imageMode
                ? "Rendering — Esc to stop"
                : "Generating — Esc to stop"
              : imageMode
                ? "Describe an image…"
                : "Ask anything…"
          }
          aria-label="Message"
          rows={1}
        />

        {showImageSuggestion && (
          <div className="px-2 pb-1">
            <button
              type="button"
              onClick={activateImageTool}
              className="flex w-full items-center justify-between gap-4 rounded-card bg-hover px-2.5 py-2 text-left transition-colors hover:bg-hover-2"
              style={{ animation: "dial-fade-up 200ms cubic-bezier(0.23,1,0.32,1) both" }}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-foreground text-background">
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2.5" y="3" width="11" height="10" rx="2" />
                    <circle cx="10.5" cy="6" r="1" />
                    <path d="m4.5 11 2.6-2.6 1.7 1.7 1-1 1.7 1.9" />
                  </svg>
                </span>
                <span className="min-w-0">
                  <span className="block font-mono text-[12px] text-foreground">
                    @image
                  </span>
                  <span className="block truncate text-[12px] text-muted">
                    {imageModelNote}
                  </span>
                </span>
              </span>
              <span className="dial-kbd">⏎</span>
            </button>
          </div>
        )}

        {attachmentError && (
          <p className="px-4 pb-1 text-[12px] text-secondary sm:px-[18px]">
            {attachmentError}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <input
              ref={fileRef}
              type="file"
              accept={caps.vision ? "image/*,application/pdf" : "application/pdf"}
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) onAttachFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={!canAttach || busy}
              onClick={() => fileRef.current?.click()}
              title={
                imageMode
                  ? "Add reference images"
                  : caps.vision
                    ? "Attach images or PDFs"
                    : "Attach PDFs — this model does not accept images"
              }
              aria-label="Attach files"
              className="flex size-8 items-center justify-center rounded-full text-muted transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-foreground active:scale-[0.94] disabled:opacity-30"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>

            {imageMode ? (
              <button
                type="button"
                onClick={onRemoveImageTool}
                disabled={busy}
                title="Leave image generation"
                aria-label="Remove image tool"
                className={pill(true)}
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="2.5" y="3" width="11" height="10" rx="2" />
                  <circle cx="10.5" cy="6" r="1" />
                  <path d="m4.5 11 2.6-2.6 1.7 1.7 1-1 1.7 1.9" />
                </svg>
                Image
                <span className="max-w-32 truncate font-mono text-[11px] opacity-60" title={imageModelNote}>
                  {imageModelLabel}
                </span>
                <svg viewBox="0 0 16 16" className="h-2.5 w-2.5 opacity-60" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg>
              </button>
            ) : caps.reasoning && efforts.length > 0 ? (
              <Dropdown
                label="Think"
                icon={
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                    <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z" />
                  </svg>
                }
                value={settings.reasoning}
                onChange={(v) => onSettingsChange({ reasoning: v as ReasoningEffort })}
                options={efforts.map((effort) => ({
                  value: effort,
                  label: effort,
                  hint: effort === caps.defaultEffort && effort !== "off" ? "default" : undefined,
                }))}
              />
            ) : null}

            {!imageMode && (
              <button
                type="button"
                disabled={searchReason !== null || busy}
                aria-pressed={settings.search}
                aria-label="Web search"
                onClick={() => onSettingsChange({ search: !settings.search })}
                title={
                  searchReason ??
                  (entry?.webSearchPrice
                    ? `Web search · $${Number(entry.webSearchPrice).toFixed(3)}/call`
                    : "Web search")
                }
                className={pill(settings.search)}
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="8" cy="8" r="5.25" />
                  <path d="M2.9 8h10.2M8 2.75c1.4 1.45 2.1 3.2 2.1 5.25S9.4 11.8 8 13.25C6.6 11.8 5.9 10.05 5.9 8S6.6 4.2 8 2.75Z" />
                </svg>
                <span className="max-sm:hidden">Search</span>
              </button>
            )}

            {!imageMode && (
              <button
                type="button"
                aria-pressed={hasSystem}
                aria-label="Conversation prompt"
                onClick={onOpenSystemPrompt}
                title={
                  hasSystem
                    ? `Conversation prompt set · ${settings.system.trim().length} characters`
                    : "Set a conversation prompt"
                }
                className={pill(hasSystem)}
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3.25 3.25h9.5v7.5h-5.5L4 13v-2.25h-.75Z" />
                  <path d="M5.5 5.75h5M5.5 8h3.25" />
                </svg>
                <span className="max-sm:hidden">Prompt</span>
              </button>
            )}
          </div>

          <button
            onClick={
              busy
                ? onStop
                : showImageSuggestion
                  ? activateImageTool
                  : onSend
            }
            disabled={!busy && !canSend}
            aria-label={
              busy
                ? "Stop generating"
                : showImageSuggestion
                  ? "Use image tool"
                  : "Send"
            }
            title={
              busy
                ? "Stop generating (Esc)"
                : showImageSuggestion
                  ? "Use image tool (Enter)"
                  : "Send (Enter)"
            }
            className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform,box-shadow] duration-200 enabled:active:scale-[0.92] ${
              busy || canSend
                ? "bg-foreground text-background shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]"
                : "bg-line-strong text-muted"
            }`}
          >
            {busy ? (
              <span className="block size-2.5 rounded-[2.5px] bg-current" />
            ) : (
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 12.75v-9.5M4 7.25l4-4 4 4" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import FileGlyph from "@/components/chat/FileGlyph";
import { listStoredFiles, readStoredFile } from "@/lib/store";
import type { StoredFile } from "@/lib/blob";

/** Bytes, at the precision a person actually reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

const THUMB = 192;
/** Files decrypted at once while thumbnails come in. */
const PARALLEL = 3;

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

type Filter = "all" | "generated" | "attachment";

/**
 * A small queue, so scrolling a long grid does not start a hundred
 * downloads and decryptions at once.
 */
function useQueue() {
  const running = useRef(0);
  const waiting = useRef<Array<() => void>>([]);
  return useMemo(
    () =>
      <T,>(task: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const run = () => {
            running.current += 1;
            task()
              .then(resolve, reject)
              .finally(() => {
                running.current -= 1;
                waiting.current.shift()?.();
              });
          };
          if (running.current < PARALLEL) run();
          else waiting.current.push(run);
        }),
    [],
  );
}

/**
 * A decrypted image, drawn down to a thumbnail and the full bytes let go.
 * Holding every file at full size to show a 96px tile is how a storage view
 * becomes the heaviest thing in the tab.
 */
async function thumbnail(bytes: Uint8Array, mediaType: string): Promise<string | null> {
  if (!mediaType.startsWith("image/")) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mediaType }));
    const scale = Math.min(1, THUMB / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.82),
    );
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

function Tile({
  file,
  title,
  queue,
  onOpen,
}: {
  file: StoredFile;
  title: string;
  queue: <T>(task: () => Promise<T>) => Promise<T>;
  onOpen: (file: StoredFile) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [thumb, setThumb] = useState<{ url: string | null; type: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let url: string | null = null;
    let gone = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        void queue(() => readStoredFile(file.id))
          .then(async ({ bytes, mediaType }) => {
            if (gone) return;
            url = await thumbnail(bytes, mediaType);
            if (gone) {
              if (url) URL.revokeObjectURL(url);
              return;
            }
            setThumb({ url, type: mediaType });
          })
          .catch(() => !gone && setFailed(true));
      },
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => {
      gone = true;
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, queue]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(file)}
      title={`${title} · ${formatBytes(file.size)}`}
      className="group/tile flex min-w-0 flex-col gap-1.5 text-left"
    >
      <span className="dial-squircle relative flex aspect-square w-full items-center justify-center overflow-hidden bg-field shadow-hairline transition-transform duration-200 ease-out-strong [--sq:10px] group-hover/tile:scale-[1.03] group-active/tile:scale-[0.98]">
        {thumb?.url ? (
          // A decrypted object URL; next/image would try to optimise it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb.url}
            alt=""
            className="h-full w-full object-cover"
            style={{ animation: "dial-fade-in 220ms ease-out both" }}
          />
        ) : thumb ? (
          <FileGlyph kind={thumb.type} className="h-9 w-9 text-muted" />
        ) : failed ? (
          <span className="px-2 text-center font-mono text-[10px] text-muted">
            can’t open
          </span>
        ) : (
          <span className="size-1.5 animate-pulse rounded-[2px] bg-foreground/20" />
        )}
        {file.kind === "generated" && (
          <span className="dial-squircle absolute left-1.5 top-1.5 bg-panel/90 px-1.5 py-px font-mono text-[9.5px] text-secondary shadow-hairline [--sq:5px]">
            made
          </span>
        )}
      </span>
      <span className="min-w-0 px-0.5">
        <span className="block truncate text-[11.5px] text-secondary">{title}</span>
        <span className="block font-mono text-[10px] tabular-nums text-muted">
          {formatBytes(file.size)}
        </span>
      </span>
    </button>
  );
}

/** One file, full size, with what can be done with it. */
function Preview({
  file,
  title,
  onClose,
  onOpenConversation,
}: {
  file: StoredFile;
  title: string;
  onClose: () => void;
  onOpenConversation?: (threadId: string) => void;
}) {
  const [shown, setShown] = useState<{ url: string; type: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let gone = false;
    readStoredFile(file.id)
      .then(({ bytes, mediaType }) => {
        if (gone) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
        setShown({ url, type: mediaType });
      })
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id]);

  const download = () => {
    if (!shown) return;
    const a = document.createElement("a");
    a.href = shown.url;
    const ext = EXTENSION[shown.type] ?? "bin";
    const stem = title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 48) || "file";
    a.download = `${stem} ${new Date(file.uploaded).toISOString().slice(0, 10)}.${ext}`;
    document.body.append(a);
    a.click();
    a.remove();
  };

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col bg-panel"
      style={{ animation: "dial-fade-in 160ms ease-out both" }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to files"
          className="dial-squircle flex size-8 items-center justify-center text-muted transition-colors [--sq:9px] hover:bg-hover hover:text-foreground"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M7.5 2.75 4.25 6l3.25 3.25" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-foreground">{title}</p>
          <p className="font-mono text-[10.5px] text-muted">
            {file.kind === "generated" ? "generated" : "uploaded"} ·{" "}
            {new Date(file.uploaded).toLocaleDateString()} · {formatBytes(file.size)}
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {shown?.type.startsWith("image/") ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shown.url}
            alt={title}
            className="dial-squircle max-h-full max-w-full object-contain shadow-card [--sq:10px]"
            style={{ animation: "dial-pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}
          />
        ) : shown ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <FileGlyph kind={shown.type} className="h-16 w-16 text-muted" />
            <p className="text-[12.5px] text-muted">
              {shown.type === "application/pdf" ? "PDF document" : "File"} — download to open it.
            </p>
          </div>
        ) : failed ? (
          <p className="text-[12.5px] text-muted">This file couldn’t be opened on this device.</p>
        ) : (
          <span className="size-2 animate-pulse rounded-[2px] bg-foreground/25" />
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-line px-3 py-2.5">
        {onOpenConversation && (
          <Button size="xs" variant="quiet" onClick={() => onOpenConversation(file.threadId)}>
            Open conversation
          </Button>
        )}
        <Button size="xs" variant="primary" disabled={!shown} onClick={download}>
          Download
        </Button>
      </div>
    </div>
  );
}

/**
 * Every image and attachment in the account, decrypted here.
 *
 * The server lists what it holds — ids, sizes, times; nothing it could not
 * already see — and this tab downloads and decrypts each file with the vault
 * key as its tile scrolls into view, a few at a time, keeping a small
 * thumbnail rather than the file. The type comes from the bytes themselves
 * (the media type is sealed inside the message). A file's conversation is
 * the first segment of its id, which is how a tile knows its title and
 * "Open conversation" knows where to go.
 */
export default function StorageBrowser({
  titles,
  onOpenConversation,
}: {
  /** Conversation titles by thread id. */
  titles: Record<string, string>;
  onOpenConversation?: (threadId: string) => void;
}) {
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<StoredFile | null>(null);
  const queue = useQueue();

  useEffect(() => {
    let gone = false;
    listStoredFiles()
      .then((list) => !gone && setFiles(list))
      .catch((e: unknown) => !gone && setError(e instanceof Error ? e.message : "could not list files"));
    return () => {
      gone = true;
    };
  }, []);

  const counts = useMemo(
    () => ({
      all: files?.length ?? 0,
      generated: files?.filter((f) => f.kind === "generated").length ?? 0,
      attachment: files?.filter((f) => f.kind === "attachment").length ?? 0,
    }),
    [files],
  );
  const visible = files?.filter((f) => filter === "all" || f.kind === filter) ?? [];
  const titleOf = (file: StoredFile) => titles[file.threadId] || "Untitled conversation";

  return (
    <div className="relative min-h-[320px]">
      <div className="flex flex-wrap items-center gap-1 py-3">
        {(["all", "generated", "attachment"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
            className={`dial-squircle flex h-7 items-center gap-1.5 px-2.5 text-[12px] font-medium transition-colors duration-150 [--sq:8px] ${
              filter === option
                ? "bg-hover-2 text-foreground shadow-hairline"
                : "text-muted hover:text-secondary"
            }`}
          >
            {option === "all" ? "All" : option === "generated" ? "Generated" : "Uploaded"}
            <span className="font-mono text-[10.5px] tabular-nums text-muted">{counts[option]}</span>
          </button>
        ))}
      </div>

      {error ? (
        <p className="py-8 text-center text-[12.5px] text-muted">{error}</p>
      ) : files === null ? (
        <div className="flex justify-center py-12">
          <span className="size-2 animate-pulse rounded-[2px] bg-foreground/25" />
        </div>
      ) : visible.length === 0 ? (
        <p className="py-10 text-center text-[12.5px] leading-relaxed text-muted">
          {files.length === 0
            ? "No images or attachments yet. Files you attach and images models make are kept here, encrypted."
            : "Nothing of this kind."}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-x-2.5 gap-y-3.5 pb-2 sm:grid-cols-4">
          {visible.map((file) => (
            <Tile
              key={file.id}
              file={file}
              title={titleOf(file)}
              queue={queue}
              onOpen={setOpen}
            />
          ))}
        </div>
      )}

      {open && (
        <Preview
          file={open}
          title={titleOf(open)}
          onClose={() => setOpen(null)}
          onOpenConversation={onOpenConversation}
        />
      )}
    </div>
  );
}

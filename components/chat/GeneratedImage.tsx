"use client";

import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import { Elapsed, PixelGrid } from "@/components/ui/Loader";
import { shortModelId } from "@/lib/capabilities";
import { formatCost, formatDuration } from "@/lib/format";
import type { GeneratedImageData } from "@/lib/types";

function extensionOf(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/svg+xml") return "svg";
  return mediaType.split("/")[1] || "png";
}

function GeneratedAsset({
  asset,
  prompt,
  index,
  count,
  onExpand,
}: {
  asset: GeneratedImageData["images"][number];
  prompt: string;
  index: number;
  count: number;
  onExpand: () => void;
}) {
  const multiple = count > 1;
  const maxWidth = multiple ? 304 : 560;
  const maxHeight = multiple ? 340 : 480;
  const [layout, setLayout] = useState({
    width: maxWidth,
    aspectRatio: "1 / 1",
  });

  if (!asset.url) {
    return (
      <div className="flex min-h-28 w-full max-w-[560px] items-center justify-center rounded-card bg-field px-5 text-center font-mono text-[11px] leading-relaxed text-muted shadow-hairline">
        image pixels are unavailable on this device
      </div>
    );
  }

  return (
    <figure
      className="group/image relative max-w-full overflow-hidden rounded-card"
      style={{ width: `min(100%, ${layout.width}px)` }}
    >
      <button
        type="button"
        onClick={onExpand}
        aria-label={`View generated image ${index + 1}`}
        className="relative block w-full overflow-hidden rounded-card"
        style={{ aspectRatio: layout.aspectRatio }}
      >
        <Image
          unoptimized
          src={asset.url}
          alt={prompt}
          fill
          sizes={multiple ? "(max-width: 760px) 50vw, 304px" : "(max-width: 760px) 92vw, 560px"}
          onLoad={(event) => {
            const width = event.currentTarget.naturalWidth;
            const height = event.currentTarget.naturalHeight;
            if (!width || !height) return;
            const scale = Math.min(1, maxWidth / width, maxHeight / height);
            setLayout({
              width: Math.max(1, Math.round(width * scale)),
              aspectRatio: `${width} / ${height}`,
            });
          }}
          className="object-contain transition-transform duration-300 ease-out group-hover/image:scale-[1.008]"
        />
      </button>

      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/image:opacity-100 focus-within:opacity-100">
        <a
          href={asset.url}
          download={`generated-${index + 1}.${extensionOf(asset.mediaType)}`}
          aria-label={`Download generated image ${index + 1}`}
          title="Download image"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white backdrop-blur-xl transition-colors hover:bg-black/75"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2.5v7M5 7.5l3 3 3-3M3 13h10" />
          </svg>
        </a>
      </div>
    </figure>
  );
}

/** A generated asset, including its quiet in-flight and failure states. */
export default function GeneratedImage({
  data,
  onRetry,
}: {
  data: GeneratedImageData;
  onRetry?: () => void;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (expandedIndex === null) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedIndex(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expandedIndex]);

  if (data.status === "generating") {
    // Compact on purpose. Reserving the finished image's footprint meant a
    // 560px empty square sat in the transcript for the whole render — a hole
    // far louder than the thing it was standing in for, and the wrong shape
    // anyway, since the result's aspect ratio isn't known until it arrives.
    return (
      <div
        role="status"
        aria-label="Generating image"
        className="mb-3 flex w-fit max-w-full items-center gap-3 rounded-card bg-panel py-2 pl-2 pr-3.5 shadow-card"
      >
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-control bg-field shadow-hairline"
        >
          <PixelGrid />
        </span>

        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="dial-shimmer text-[13px] font-medium leading-tight">
              Rendering image
            </span>
            <Elapsed />
          </span>
          <span className="truncate font-mono text-[11px] leading-tight text-muted">
            @image · {shortModelId(data.model)}
          </span>
        </span>
      </div>
    );
  }

  if (data.status === "error") {
    return (
      <div className="mb-3 max-w-[560px] rounded-card bg-panel px-4 py-3.5 shadow-card">
        <p className="text-[13.5px] font-medium text-foreground">
          Image generation failed
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-secondary">
          {data.error ?? "The image model did not return an image."}
        </p>
        {onRetry && (
          <Button size="xs" onClick={onRetry} className="mt-3">
            Retry image
          </Button>
        )}
      </div>
    );
  }

  const summary = [
    data.model ? shortModelId(data.model) : null,
    data.durationMs !== null ? formatDuration(data.durationMs) : null,
    data.costUsd !== null ? formatCost(data.costUsd) : null,
  ].filter(Boolean);
  const expandedAsset =
    expandedIndex === null ? undefined : data.images[expandedIndex];

  return (
    <>
      <div
        className={`mb-3 grid max-w-[620px] items-start gap-2 ${
          data.images.length > 1
            ? "grid-cols-1 sm:grid-cols-2"
            : "grid-cols-1"
        }`}
      >
        {data.images.map((asset, index) => (
          <GeneratedAsset
            key={`${asset.url.slice(0, 48)}-${index}`}
            asset={asset}
            prompt={data.prompt}
            index={index}
            count={data.images.length}
            onExpand={() => setExpandedIndex(index)}
          />
        ))}
      </div>

      {summary.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted">
          <span>image</span>
          {summary.map((item) => (
            <span key={item} className="flex items-center gap-2">
              <span className="opacity-40">·</span>
              <span>{item}</span>
            </span>
          ))}
        </div>
      )}

      <AnimatePresence>
        {expandedAsset?.url && (
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Generated image preview"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={() => setExpandedIndex(null)}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-4 backdrop-blur-xl sm:p-8"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.985 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              onClick={(event) => event.stopPropagation()}
              className="relative h-full w-full max-w-6xl"
            >
              <Image
                unoptimized
                src={expandedAsset.url}
                alt={data.prompt}
                fill
                sizes="100vw"
                className="object-contain"
              />
              <button
                type="button"
                onClick={() => setExpandedIndex(null)}
                aria-label="Close image preview"
                className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/55 text-lg text-white backdrop-blur-xl"
              >
                ×
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

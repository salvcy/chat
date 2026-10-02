"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A window onto content that grows at the bottom — the live view of the
 * model's work.
 *
 * - `follow`: at most `max` tall and anchored to the newest content, so the
 *   window fills, then holds still while what is above it scrolls up under a
 *   fade. This is the view while the model works.
 * - `full`: as tall as the content.
 * - `none`: closed. Children unmount once the close has finished.
 *
 * Every change of height animates, and so does new content. Content is
 * anchored to the frame's bottom, so growth would otherwise shove everything
 * up by a whole line at once; instead it is offset back down by what it grew
 * and glided into place (FLIP). With the frame's own height on the same curve
 * and clock, while the frame is still growing the two cancel exactly — the
 * old lines stay put and the new one is uncovered beneath them — and once the
 * frame is full the text scrolls smoothly. Interrupted glides restart from
 * wherever the content is, so a stream of lines reads as one continuous
 * scroll.
 *
 * Geometry is written to the DOM, never React state: content grows on every
 * streamed token and must not re-render anything to be measured.
 */

export type RevealMode = "follow" | "full" | "none";

type Timing = { duration: number; easing: string };

/**
 * Growth glides on a curve that *starts* linear (initial slope 1) and only
 * eases at the end. Each new line restarts the glide from wherever the
 * content is, so a strong ease-out here — fast, then slow, then fast again
 * at the next line — turned a stream of lines into a stutter. Starting
 * linear, back-to-back glides settle into one constant scroll speed, and the
 * last one still comes to rest softly.
 */
const GROW: Timing = { duration: 300, easing: "cubic-bezier(0.3, 0.3, 0.4, 1)" };
/** Opening, closing and folding away: the app's usual strong ease-out. */
const MODE: Timing = { duration: 420, easing: "cubic-bezier(0.23, 1, 0.32, 1)" };
/** How much of the top edge fades once content passes under it. */
const FADE = 40;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function offsetOf(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
}

/**
 * A new animation waits, play-pending, until the compositor has started it,
 * and holds its first keyframe meanwhile. Restarted on every streamed line —
 * every other frame, in a fast stream — that froze the motion half the time:
 * a 30Hz judder, measured frame by frame. An explicit start time skips the
 * pending state, and pinning it to the frame already painted means the next
 * frame is one frame along — where the motion it replaces would have been.
 */
function run(element: HTMLElement, keyframes: Keyframe[], timing: Timing): Animation {
  const animation = element.animate(keyframes, timing);
  const now = document.timeline.currentTime;
  if (typeof now === "number") animation.startTime = now;
  return animation;
}

export default function Reveal({
  mode,
  max,
  className = "",
  children,
}: {
  mode: RevealMode;
  /** Height of the `follow` window, in px. */
  max: number;
  className?: string;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const geometry = useRef({
    frame: -1,
    content: -1,
    mode,
    glide: null as Animation | null,
    resize: null as Animation | null,
  });
  const applyRef = useRef<(() => void) | null>(null);

  // Children stay mounted until a close has finished animating.
  const [mounted, setMounted] = useState(mode !== "none");
  if (mode !== "none" && !mounted) setMounted(true);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content) return;
    const state = geometry.current;

    const apply = () => {
      const height = content.offsetHeight;
      const target = mode === "none" ? 0 : mode === "follow" ? Math.min(height, max) : height;
      const animate = state.frame >= 0 && !prefersReducedMotion();
      const grew = state.content >= 0 ? height - state.content : 0;
      // Frame and glide share one timing, so while both move they cancel.
      const timing = state.mode !== mode ? MODE : GROW;
      state.mode = mode;

      // Even while folding away: the last of the thinking often lands in the
      // same tick as the answer, and the fold should not jump to show it.
      if (animate && grew > 0 && (mode !== "none" || state.frame > 0)) {
        const from = grew + (state.glide?.playState === "running" ? offsetOf(content) : 0);
        state.glide?.cancel();
        state.glide = run(
          content,
          [{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }],
          timing,
        );
      }

      if (target !== state.frame) {
        const from = frame.getBoundingClientRect().height;
        state.resize?.cancel();
        state.resize = null;
        frame.style.height = `${target}px`;
        if (animate && Math.abs(from - target) >= 0.5) {
          const resize = run(frame, [{ height: `${from}px` }, { height: `${target}px` }], timing);
          if (mode === "none") resize.onfinish = () => setMounted(false);
          state.resize = resize;
        }
      }

      frame.style.transition = animate
        ? `opacity ${MODE.duration}ms ${MODE.easing}, --dial-fade ${MODE.duration}ms ${MODE.easing}`
        : "none";
      frame.style.opacity = mode === "none" ? "0" : "1";
      frame.style.setProperty(
        "--dial-fade",
        `${mode === "follow" ? Math.min(FADE, Math.max(0, height - max)) : 0}px`,
      );
      state.frame = target;
      state.content = height;
    };

    applyRef.current = apply;
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(content);
    return () => {
      observer.disconnect();
      applyRef.current = null;
    };
  }, [mode, max, mounted]);

  // After every commit, not only when the observer reports at the end of the
  // frame: in between, the content has already moved and has no glide yet,
  // and anything that reads layout in that window — a scroll follow, a
  // measurement — sees it jump. The observer still covers what React did not
  // cause, like a resize.
  useLayoutEffect(() => {
    applyRef.current?.();
  });

  return (
    <div ref={frameRef} className={`dial-reveal relative overflow-hidden ${className}`}>
      <div ref={contentRef} className="absolute inset-x-0 bottom-0">
        {mounted && children}
      </div>
    </div>
  );
}

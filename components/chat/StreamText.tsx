"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Plain text that grows at its end, with each new piece fading in.
 *
 * React does not render the text: it would replace the node on every
 * streamed token, and a fade on the newest words needs them in an element of
 * their own. The effect appends what was added since the last render as a
 * `.dial-fresh` span, and once its fade has run the span is folded back into
 * plain text — so a long thought is a few text nodes, not thousands of spans.
 * A change that is not an append (or the first render, unless `fade`) writes
 * the text whole.
 */
export default function StreamText({
  text,
  fade,
  className,
}: {
  text: string;
  /** Fade in what arrives — only while it is arriving. */
  fade: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<string | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const previous = shown.current;
    shown.current = text;
    if (previous === text) return;

    const append = previous !== null && text.startsWith(previous);
    const added = append ? text.slice(previous.length) : text;
    if (!append) element.textContent = "";
    if (fade && (append || previous === null)) {
      const piece = document.createElement("span");
      piece.className = "dial-fresh";
      piece.textContent = added;
      element.appendChild(piece);
    } else {
      element.appendChild(document.createTextNode(added));
    }
  }, [text, fade]);

  return (
    <span
      ref={ref}
      className={className}
      onAnimationEnd={(event) => {
        const piece = event.target as HTMLElement;
        if (piece.parentNode !== ref.current || !piece.classList.contains("dial-fresh")) return;
        piece.replaceWith(document.createTextNode(piece.textContent ?? ""));
        ref.current?.normalize();
      }}
    />
  );
}

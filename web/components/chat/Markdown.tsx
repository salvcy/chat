"use client";

import { AnimatePresence, motion } from "motion/react";
import ReactMarkdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import { memo, useId, useState } from "react";
import {
  normalizeLanguage,
  registerSyntaxLanguages,
  syntaxTheme,
} from "@/lib/syntax";
import CopyButton from "@/components/ui/CopyButton";

/*
 * `PrismLight`, not `Prism`.
 *
 * The full build pulls in `refractor/all` — 297 grammars, 1.87 MB raw and
 * 557 KB gzipped, in an eagerly loaded chunk that was three quarters of this
 * app's entire first-load JavaScript. Every visitor downloaded and parsed all
 * of it before hydration in order to colour the handful of languages a chat
 * answer actually contains. The curated set lives in lib/syntax.ts; a fence
 * outside it renders as plain monospace, which is what an unrecognised
 * language already did.
 */
registerSyntaxLanguages(SyntaxHighlighter.registerLanguage);

/*
 * Hoisted to module scope rather than written inline.
 *
 * react-markdown 10 memoizes nothing — it runs the whole unified pipeline
 * (remark-parse, remark-gfm, remark-rehype, then element creation) inside its
 * own render, and a fresh `components` object each time guaranteed a fresh
 * subtree on top of that. Measured at 2.4 ms for a 17 KB answer; with the
 * transcript re-rendering on every streamed token, a long thread spent tens
 * of milliseconds per token re-parsing messages nobody had touched.
 */
const MARKDOWN_COMPONENTS: ComponentProps<
  typeof ReactMarkdown
>["components"] = {
  code: MarkdownCode,
  p: ({ children }) => (
    <p className="my-2 first:mt-0 last:mb-0">{children}</p>
  ),
  h1: ({ children }) => (
    <h1 className="mb-2.5 mt-6 text-2xl font-semibold tracking-[-0.03em]">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2.5 mt-6 text-xl font-semibold tracking-[-0.025em]">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-4 text-base font-semibold">{children}</h3>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:font-mono marker:text-[0.85em] marker:text-muted">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-line-strong decoration-1 underline-offset-[3px] transition-colors hover:decoration-foreground"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-line-strong pl-4 text-secondary">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-6 border-line" />,
  table: ({ children }) => (
    <div className="dial-scroll my-4 overflow-x-auto rounded-card bg-panel shadow-card">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="whitespace-nowrap border-b border-line bg-hover px-3.5 py-2 text-left text-[12.5px] font-medium text-secondary">
      {children}
    </th>
  ),
  tr: ({ children }) => (
    <tr className="transition-colors duration-100 hover:bg-hover [&:last-child>td]:border-0">
      {children}
    </tr>
  ),
  td: ({ children }) => (
    <td className="border-b border-line px-3.5 py-2.5 align-top text-[13.5px] leading-relaxed">
      {children}
    </td>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
};

/**
 * Markdown for assistant-authored prose. Code blocks use a restrained,
 * theme-aware semantic palette (see lib/syntax.ts), plus a mono language
 * label and copy control in the same hairline header.
 *
 * Memoized on `text`, which is the whole point: it is the only prop, and a
 * message that has finished streaming never changes it again. Every render
 * driven by the *next* message's tokens now stops at this boundary instead
 * of re-parsing the entire transcript.
 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="dial-md text-[16px] leading-[1.72] tracking-[-0.008em] text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & ExtraProps;

function MarkdownCode({
  className,
  children,
  node: _node,
  ...props
}: MarkdownCodeProps) {
  void _node;
  const match = /language-(\S+)/.exec(className || "");
  const code = String(children).replace(/\n$/, "");
  const inline = !match && !code.includes("\n");

  if (inline) {
    return (
      <code
        className="rounded-[5px] bg-field px-[0.4em] py-[0.15em] font-mono text-[0.85em] shadow-hairline"
        {...props}
      >
        {code}
      </code>
    );
  }

  return (
    <CodeBlock
      code={code}
      language={normalizeLanguage(match?.[1])}
      label={match?.[1] ?? "code"}
    />
  );
}

function CodeBlock({
  code,
  language,
  label,
}: {
  code: string;
  language: string;
  label: string;
}) {
  const [open, setOpen] = useState(true);
  const contentId = useId();
  const lines = code.split("\n").length;

  return (
    <div className="my-4 overflow-hidden rounded-card bg-panel shadow-card">
      <div
        className={`flex h-10 items-center justify-between gap-2 pl-1.5 pr-1.5 transition-colors ${
          open ? "border-b border-line" : ""
        }`}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          title={open ? "Collapse code" : "Expand code"}
          onClick={() => setOpen((current) => !current)}
          className="group flex h-7 min-w-0 items-center gap-2 rounded-control px-1.5 text-muted transition-colors hover:bg-hover-2 hover:text-foreground"
        >
          <svg
            viewBox="0 0 12 12"
            className={`h-2.5 w-2.5 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
          </svg>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3" />
          </svg>
          <span className="truncate font-mono text-[12px] text-secondary group-hover:text-foreground">
            {label}
          </span>
          {!open && (
            <span className="font-mono text-[11px] tabular-nums text-muted">
              {lines} {lines === 1 ? "line" : "lines"}
            </span>
          )}
        </button>
        <CopyButton text={code} label="Copy code" showLabel />
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={contentId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="dial-scroll overflow-x-auto">
              <SyntaxHighlighter
                language={language}
                style={syntaxTheme}
                customStyle={{
                  margin: 0,
                  padding: "14px 16px 16px",
                  background: "transparent",
                  fontSize: "13px",
                  lineHeight: 1.65,
                }}
                codeTagProps={{ style: { background: "transparent" } }}
                PreTag="div"
              >
                {code}
              </SyntaxHighlighter>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

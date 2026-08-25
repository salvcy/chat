"use client";

import { AnimatePresence, motion } from "motion/react";
import ReactMarkdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import type { ComponentPropsWithoutRef } from "react";
import { useId, useState } from "react";
import { normalizeLanguage, syntaxTheme } from "@/lib/syntax";
import CopyButton from "@/components/ui/CopyButton";

/**
 * Markdown for assistant-authored prose. Code blocks use a restrained,
 * theme-aware semantic palette (see lib/syntax.ts), plus a mono language
 * label and copy control in the same hairline header.
 */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="dial-md text-[16px] leading-[1.72] tracking-[-0.008em] text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
              className="underline decoration-hairline underline-offset-2 transition-colors hover:decoration-foreground"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l border-hairline pl-4 text-muted">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-5 border-hairline" />,
          table: ({ children }) => (
            <div className="dial-scroll my-3 overflow-x-auto rounded-xl border border-hairline">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-hairline bg-surface px-3 py-2 text-left text-[13px] font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-hairline px-3 py-2 text-[13px] last:border-0">
              {children}
            </td>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

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
        className="rounded-md border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[0.85em]"
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

  return (
    <div className="my-4 overflow-hidden rounded-2xl border border-hairline-strong bg-panel">
      <div
        className={`flex items-center justify-between bg-surface py-1.5 pl-2 pr-2 transition-colors ${
          open ? "border-b border-hairline" : ""
        }`}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          title={open ? "Hide code" : "Show code"}
          onClick={() => setOpen((current) => !current)}
          className="group flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:bg-surface-strong hover:text-foreground"
        >
          <motion.svg
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            viewBox="0 0 12 12"
            className="h-2.5 w-2.5 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
          </motion.svg>
          <span className="truncate">{label}</span>
          <span className="normal-case tracking-normal opacity-45">
            {open ? "hide" : "show"}
          </span>
        </button>
        <CopyButton text={code} label="Copy code" />
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={contentId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="dial-scroll overflow-x-auto bg-background">
              <SyntaxHighlighter
                language={language}
                style={syntaxTheme}
                customStyle={{
                  margin: 0,
                  padding: "15px 16px",
                  background: "transparent",
                  fontSize: "13px",
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

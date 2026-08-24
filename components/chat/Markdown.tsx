"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

/**
 * Markdown for assistant-authored prose. Monochrome, quiet, readable —
 * code blocks get a hairline-framed block with the model's mono voice;
 * everything else stays in the neutral palette.
 */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="dial-md text-[15px] leading-[1.7] text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
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
              <div className="my-3 overflow-hidden rounded-xl border border-hairline">
                <div className="border-b border-hairline bg-surface px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">
                  {match?.[1] ?? "code"}
                </div>
                <SyntaxHighlighter
                  language={match?.[1] ?? "text"}
                  style={oneDark}
                  customStyle={{
                    margin: 0,
                    background: "var(--background)",
                    fontSize: "13px",
                  }}
                  PreTag="div"
                >
                  {code}
                </SyntaxHighlighter>
              </div>
            );
          },
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mt-4 mb-2 text-xl font-semibold">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-4 mb-2 text-lg font-semibold">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-3 mb-1.5 text-base font-semibold">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
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
          hr: () => <hr className="my-4 border-hairline" />,
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-hairline bg-surface px-3 py-1.5 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-hairline px-3 py-1.5">{children}</td>
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

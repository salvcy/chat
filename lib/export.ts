import type { UIMessage } from "ai";
import type { ConversationMeta } from "./store";
import { textOf } from "./store";
import { formatCost, formatTokens } from "./format";
import type { DialDataParts, DialMetadata } from "./types";

/**
 * Conversation export. Markdown for reading and pasting elsewhere, JSON for
 * anything that needs the parts and telemetry intact.
 */

function stamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

export function toMarkdown(
  meta: ConversationMeta,
  messages: UIMessage<DialMetadata, DialDataParts>[],
): string {
  const lines: string[] = [
    `# ${meta.title}`,
    "",
    `- model: \`${meta.model}\``,
    `- exported: ${stamp(Date.now())}`,
  ];
  if (meta.reasoning !== "off") lines.push(`- reasoning: ${meta.reasoning}`);
  if (meta.totalCostUsd) lines.push(`- cost: ${formatCost(meta.totalCostUsd)}`);
  if (meta.totalTokens) lines.push(`- tokens: ${formatTokens(meta.totalTokens)}`);
  lines.push("", "---", "");

  for (const m of messages) {
    const body = textOf(m);
    const images = m.parts.filter((part) => part.type === "data-image");
    const requestStatus = m.parts.find(
      (part) => part.type === "data-requestStatus",
    );
    if (!body && images.length === 0 && !requestStatus) continue;
    if (m.role === "user") {
      lines.push(`### ⟶ You`, "", body, "");
    } else if (m.role === "assistant") {
      const via = m.metadata?.model ?? meta.model;
      lines.push(`### ⟵ ${via}`, "", body, "");
      const sources = m.parts.filter((p) => p.type === "source-url");
      if (sources.length > 0) {
        lines.push("**Sources**", "");
        sources.forEach((s, i) => {
          if (s.type !== "source-url") return;
          lines.push(`${i + 1}. [${s.title ?? s.url}](${s.url})`);
        });
        lines.push("");
      }
      images.forEach((part) => {
        if (part.type !== "data-image") return;
        const state =
          part.data.status === "complete"
            ? "generated image"
            : part.data.status === "error"
              ? "image generation failed"
              : "image generation pending";
        lines.push(
          `> ${state}: ${part.data.prompt}`,
          `> model: \`${part.data.model}\``,
          "",
        );
      });
      if (requestStatus?.type === "data-requestStatus") {
        lines.push(
          requestStatus.data.kind === "interrupted"
            ? "_Request was interrupted by the user._"
            : "_No response was returned._",
          "",
        );
      }
    }
  }
  return lines.join("\n");
}

export function toJSON(
  meta: ConversationMeta,
  messages: UIMessage<DialMetadata, DialDataParts>[],
): string {
  return JSON.stringify(
    { conversation: meta, messages, exportedAt: Date.now() },
    null,
    2,
  );
}

/** Filesystem-safe slug from a conversation title. */
function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "conversation"
  );
}

/** Trigger a download in the browser. */
export function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — Safari cancels the download otherwise.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportConversation(
  meta: ConversationMeta,
  messages: UIMessage<DialMetadata, DialDataParts>[],
  format: "md" | "json",
) {
  const name = `${slug(meta.title)}.${format}`;
  if (format === "md") {
    download(name, toMarkdown(meta, messages), "text/markdown;charset=utf-8");
  } else {
    download(name, toJSON(meta, messages), "application/json;charset=utf-8");
  }
}

import type { CSSProperties } from "react";

/**
 * A restrained, theme-aware Prism palette.
 *
 * Code is the one intentional exception to the monochrome interface: semantic
 * color makes dense source materially faster to scan. The palette stays low
 * chroma so it reads as part of the app rather than a pasted-in editor theme.
 * Every color resolves through light/dark CSS tokens.
 */

const fg = "var(--foreground)";
const dim = "var(--muted)";
/** The quietest legible step — punctuation, operators. */
const faint = "color-mix(in oklab, var(--muted) 82%, var(--background))";
const comment = "var(--syntax-comment)";
const keyword = "var(--syntax-keyword)";
const string = "var(--syntax-string)";
const number = "var(--syntax-number)";
const fn = "var(--syntax-function)";
const type = "var(--syntax-type)";
const variable = "var(--syntax-variable)";
const operator = "var(--syntax-operator)";

const base: CSSProperties = {
  color: fg,
  background: "none",
  fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
  fontSize: "13px",
  lineHeight: 1.65,
  direction: "ltr",
  textAlign: "left",
  whiteSpace: "pre",
  wordSpacing: "normal",
  wordBreak: "normal",
  tabSize: 2,
  hyphens: "none",
};

export const syntaxTheme: Record<string, CSSProperties> = {
  'code[class*="language-"]': base,
  'pre[class*="language-"]': { ...base, overflow: "auto", margin: 0 },

  // Structure recedes; semantics carry restrained color.
  comment: { color: comment, fontStyle: "italic" },
  prolog: { color: comment },
  doctype: { color: comment },
  cdata: { color: comment },
  punctuation: { color: faint },
  operator: { color: operator },

  string: { color: string },
  char: { color: string },
  "attr-value": { color: string },
  regex: { color: string },
  number: { color: number },
  boolean: { color: number, fontWeight: 500 },
  constant: { color: number },
  symbol: { color: number },
  builtin: { color: type },
  inserted: { color: string },
  deleted: { color: "var(--syntax-deleted)", textDecoration: "line-through" },

  keyword: { color: keyword, fontWeight: 600 },
  atrule: { color: keyword, fontWeight: 600 },
  important: { color: keyword, fontWeight: 600 },
  "attr-name": { color: variable },
  property: { color: variable },
  tag: { color: keyword, fontWeight: 500 },
  selector: { color: type, fontWeight: 500 },
  function: { color: fn, fontWeight: 500 },
  "class-name": { color: type, fontWeight: 500 },
  variable: { color: variable },
  entity: { color: fg, cursor: "help" },
  url: { color: dim, textDecoration: "underline" },
  namespace: { color: dim, opacity: 0.8 },

  bold: { fontWeight: 600 },
  italic: { fontStyle: "italic" },
};

/** Prism's language ids differ from the fences people actually type. */
const ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  jsx: "jsx",
  tsx: "tsx",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  py: "python",
  rb: "ruby",
  rs: "rust",
  golang: "go",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  md: "markdown",
  dockerfile: "docker",
  htm: "html",
};

export function normalizeLanguage(lang: string | undefined): string {
  if (!lang) return "text";
  const key = lang.toLowerCase();
  return ALIASES[key] ?? key;
}

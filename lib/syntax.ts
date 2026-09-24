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

/* ----------------------------- the grammars ---------------------------- */

/**
 * Which Prism grammars are actually shipped.
 *
 * `react-syntax-highlighter`'s default `Prism` export imports `refractor/all`:
 * 297 grammars, 1.87 MB raw and 557 KB gzipped, eagerly loaded before
 * hydration. That was three quarters of this app's first-load JavaScript, and
 * it bought the ability to colour COBOL. A chat answer writes in a much
 * smaller set, so the set is enumerated here.
 *
 * Each module registers its own dependencies (`typescript` pulls `javascript`,
 * which pulls `clike` and `markup`) and declares its own aliases, so only the
 * top-level languages need naming. Anything not listed falls through
 * react-syntax-highlighter's own try/catch and renders as plain monospace —
 * the same result an unrecognised fence has always produced.
 *
 * Adding one is a single line. Adding all of them again is 550 KB.
 */
const GRAMMARS = [
  () => import("refractor/bash"),
  () => import("refractor/c"),
  () => import("refractor/cpp"),
  () => import("refractor/csharp"),
  () => import("refractor/css"),
  () => import("refractor/diff"),
  () => import("refractor/docker"),
  () => import("refractor/go"),
  () => import("refractor/graphql"),
  () => import("refractor/ini"),
  () => import("refractor/java"),
  () => import("refractor/javascript"),
  () => import("refractor/json"),
  () => import("refractor/jsx"),
  () => import("refractor/kotlin"),
  () => import("refractor/lua"),
  () => import("refractor/markdown"),
  () => import("refractor/markup"),
  () => import("refractor/php"),
  () => import("refractor/powershell"),
  () => import("refractor/python"),
  () => import("refractor/r"),
  () => import("refractor/ruby"),
  () => import("refractor/rust"),
  () => import("refractor/scss"),
  () => import("refractor/sql"),
  () => import("refractor/swift"),
  () => import("refractor/toml"),
  () => import("refractor/tsx"),
  () => import("refractor/typescript"),
  () => import("refractor/yaml"),
] as const;

let registered = false;

/**
 * Register the shipped grammars exactly once.
 *
 * Deliberately asynchronous. Highlighting is the last thing a code block
 * needs and the first thing that can wait: a grammar arriving a tick after
 * first paint costs an unstyled frame nobody sees, while importing them
 * synchronously would put every byte back in the eager bundle and undo the
 * entire saving. `PrismLight` renders plain monospace until a grammar is
 * there, so there is no failure mode — only a slightly later colour.
 */
export function registerSyntaxLanguages(
  register: (name: string, language: unknown) => void,
): void {
  if (registered || typeof window === "undefined") return;
  registered = true;
  for (const load of GRAMMARS) {
    void load()
      .then((module) => register("", module.default))
      .catch(() => {
        // One grammar failing to load must never take the transcript with it.
      });
  }
}

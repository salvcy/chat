import type { KeyboardEvent } from "react";

/**
 * Enter in a message field: alone it sends, and with any modifier it is a
 * new line. Shift+Enter already inserts one natively and is left alone. A
 * textarea ignores ⌘, Ctrl and Option with Enter, so checking only for Shift
 * let ⌘Enter fall through to "send"; those insert the line here instead.
 * Enter that confirms an IME composition is the composition's, never a send.
 */
export function enterToSend(
  e: KeyboardEvent<HTMLTextAreaElement>,
  send: () => void,
): void {
  if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
  e.preventDefault();
  if (e.metaKey || e.ctrlKey || e.altKey) insertNewline(e.currentTarget);
  else send();
}

/**
 * At the caret, replacing any selection. `insertText` keeps the browser's
 * undo stack and fires `input`, so React's `onChange` sees it as typing; the
 * fallback edits the value directly and announces it the same way.
 */
function insertNewline(field: HTMLTextAreaElement): void {
  if (document.execCommand("insertText", false, "\n")) return;
  field.setRangeText("\n", field.selectionStart, field.selectionEnd, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

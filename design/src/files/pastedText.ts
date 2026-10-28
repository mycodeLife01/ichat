import { createContext, useContext } from "react";

// Mirrors the API's `content` max_length (Pydantic counts code points).
export const MESSAGE_CHAR_LIMIT = 20_000;
// A single paste at or above either threshold becomes a text attachment.
export const PASTE_CHAR_THRESHOLD = 4_000;
export const PASTE_LINE_THRESHOLD = 80;
// The counter appears once the prompt reaches this share of the limit.
export const COUNTER_VISIBLE_RATIO = 0.8;

export const PASTED_TEXT_PREFIX = "pasted-text-";

export function countChars(text: string): number {
  return Array.from(text).length;
}

export function countLines(text: string): number {
  return text === "" ? 0 : text.split(/\r\n|\r|\n/).length;
}

export function shouldConvertPaste(text: string): boolean {
  return (
    countChars(text) >= PASTE_CHAR_THRESHOLD ||
    countLines(text) >= PASTE_LINE_THRESHOLD
  );
}

export function firstLine(text: string): string {
  return text.split(/\r\n|\r|\n/).find((line) => line.trim())?.trim() ?? "";
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

// Pasted text lives in memory for the design canvas: a File created on paste
// is adopted under its attachment id once the upload starts, so composer
// and sent-message cards can read the text without a network preview.
const pendingByFile = new WeakMap<File, string>();
const textById = new Map<string, string>();

export function createPastedTextFile(text: string, index: number): File {
  const file = new File([text], `${PASTED_TEXT_PREFIX}${index}.txt`, {
    type: "text/plain",
  });
  pendingByFile.set(file, text);
  return file;
}

export function adoptPastedText(file: File, id: string) {
  const text = pendingByFile.get(file);
  if (text !== undefined) textById.set(id, text);
}

export function registerPastedText(id: string, text: string) {
  textById.set(id, text);
}

export function pastedText(id: string | null | undefined): string | undefined {
  return id ? textById.get(id) : undefined;
}

export type PastedTextActions = {
  /** Remaining room in the prompt, used to gate "转回文本". */
  promptChars: number;
  onExpand: (clientId: string) => void;
};

// Provided only around the chat composer; other pages keep the file card.
export const PastedTextContext = createContext<PastedTextActions | null>(null);

export function usePastedTextActions() {
  return useContext(PastedTextContext);
}

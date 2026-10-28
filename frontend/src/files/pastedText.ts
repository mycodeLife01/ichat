import { createContext, useContext } from "react";

import type { DraftAttachment } from "./types";

// Mirrors the API's `content` max_length (Pydantic counts code points).
export const MESSAGE_CHAR_LIMIT = 20_000;
// A single paste at or above either threshold becomes a text attachment.
export const PASTE_CHAR_THRESHOLD = 4_000;
export const PASTE_LINE_THRESHOLD = 80;
// The counter appears once the prompt reaches this share of the limit.
export const COUNTER_VISIBLE_RATIO = 0.8;

const PASTED_TEXT_NAME = /^pasted-text-(\d+)\.txt$/;

export function countChars(text: string): number {
  return Array.from(text).length;
}

export function countLines(text: string): number {
  return text === "" ? 0 : text.split(/\r\n|\r|\n/).length;
}

export function shouldConvertPaste(text: string): boolean {
  return countChars(text) >= PASTE_CHAR_THRESHOLD || countLines(text) >= PASTE_LINE_THRESHOLD;
}

export function firstLine(text: string): string {
  return text.split(/\r\n|\r|\n/).find((line) => line.trim())?.trim() ?? "";
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Names the next paste `pasted-text-N.txt`, N increasing within the draft. */
export function createPastedTextFile(
  text: string,
  attachments: readonly DraftAttachment[],
): File {
  const used = attachments.map((attachment) =>
    Number(PASTED_TEXT_NAME.exec(attachment.name)?.[1] ?? 0),
  );
  const index = Math.max(0, ...used) + 1;
  const file = new File([text], `pasted-text-${index}.txt`, { type: "text/plain" });
  pendingByFile.set(file, text);
  return file;
}

// Pasted text stays in memory for this tab, keyed by the draft client id and,
// once processed, by the file id, so cards skip the text endpoint until a
// reload. Drafts in localStorage never hold the text itself.
const pendingByFile = new WeakMap<File, string>();
const textByHandle = new Map<string, string>();

export function adoptPastedText(file: File, clientId: string): void {
  const text = pendingByFile.get(file);
  if (text !== undefined) textByHandle.set(clientId, text);
}

export function rememberPastedText(handle: string, text: string): void {
  textByHandle.set(handle, text);
}

export function pastedText(...handles: Array<string | null | undefined>): string | undefined {
  for (const handle of handles) {
    const text = handle ? textByHandle.get(handle) : undefined;
    if (text !== undefined) return text;
  }
  return undefined;
}

/** Reads the full text by file id (owner) or share ref (public share page). */
export type PastedTextReader = (handle: string) => Promise<string>;

export const PastedTextReaderContext = createContext<PastedTextReader | null>(null);

export type PastedTextActions = {
  /** Current prompt length, used to gate "在输入框中显示". */
  promptChars: number;
  onExpand: (clientId: string, text: string) => void;
};

// Provided only around the composer; message and share cards have no actions.
export const PastedTextActionsContext = createContext<PastedTextActions | null>(null);

export function usePastedTextReader() {
  return useContext(PastedTextReaderContext);
}

export function usePastedTextActions() {
  return useContext(PastedTextActionsContext);
}

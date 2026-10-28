import { describe, expect, it } from "vitest";

import {
  countChars,
  countLines,
  createPastedTextFile,
  firstLine,
  pastedText,
  adoptPastedText,
  shouldConvertPaste,
} from "./pastedText";
import type { DraftAttachment } from "./types";

function draftNamed(name: string): DraftAttachment {
  return {
    client_id: name,
    upload_id: null,
    status: "succeeded",
    error_code: null,
    file: null,
    name,
    media_type: "text/plain",
    size_bytes: 1,
    category: "text",
  };
}

describe("pasted text helpers", () => {
  it("counts code points like the API and splits every line-break style", () => {
    expect(countChars("a😀b")).toBe(3);
    expect(countLines("")).toBe(0);
    expect(countLines("a\r\nb\rc\nd")).toBe(4);
  });

  it("converts pastes at either threshold", () => {
    expect(shouldConvertPaste("x".repeat(3_999))).toBe(false);
    expect(shouldConvertPaste("x".repeat(4_000))).toBe(true);
    expect(shouldConvertPaste("\n".repeat(78))).toBe(false);
    expect(shouldConvertPaste("\n".repeat(79))).toBe(true);
  });

  it("uses the first non-blank line as the card title", () => {
    expect(firstLine("\n   \n  ERROR boot failed  \nnext")).toBe("ERROR boot failed");
  });

  it("numbers paste files after the highest one in the draft and keeps the text", () => {
    const file = createPastedTextFile("body", [
      draftNamed("pasted-text-1.txt"),
      draftNamed("pasted-text-3.txt"),
      draftNamed("notes.txt"),
    ]);
    expect(file.name).toBe("pasted-text-4.txt");
    expect(file.type).toBe("text/plain");

    adoptPastedText(file, "client-x");
    expect(pastedText(undefined, "client-x")).toBe("body");
  });
});

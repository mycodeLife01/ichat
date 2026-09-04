import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText, startDeferredTextCopy } from "./clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

function setClipboard(value: Partial<Clipboard> | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

function setExecCommand(value: (command: string) => boolean) {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: Clipboard }).clipboard;
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else delete (document as { execCommand?: typeof document.execCommand }).execCommand;
});

describe("clipboard helpers", () => {
  it("starts a ClipboardItem write before deferred text resolves", async () => {
    let itemData: Record<string, string | Blob | PromiseLike<string | Blob>> | undefined;
    class ClipboardItemStub {
      constructor(items: Record<string, string | Blob | PromiseLike<string | Blob>>) {
        itemData = items;
      }
    }
    vi.stubGlobal("ClipboardItem", ClipboardItemStub);

    let resolveText!: (value: string) => void;
    const text = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const write = vi.fn(async () => {
      const blob = await itemData?.["text/plain"];
      expect(blob).toBeInstanceOf(Blob);
      expect((blob as Blob).type).toBe("text/plain");
    });
    setClipboard({ write } as Partial<Clipboard>);

    const result = startDeferredTextCopy(text);

    expect(write).toHaveBeenCalledTimes(1);
    resolveText("https://example.test/share/token");
    await expect(result).resolves.toBe(true);
  });

  it("falls back to a selection copy when the async Clipboard API is unavailable", async () => {
    setClipboard(undefined);
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    await expect(copyText("https://example.test/share/token")).resolves.toBe(true);

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector("textarea[data-clipboard-fallback]")).toBeNull();
    trigger.remove();
  });

  it("uses the selection fallback after writeText is rejected", async () => {
    setClipboard({
      writeText: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")),
    });
    const execCommand = vi.fn(() => true);
    setExecCommand(execCommand);

    await expect(copyText("fallback")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure when neither clipboard path can copy", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);

    await expect(copyText("unavailable")).resolves.toBe(false);
  });
});

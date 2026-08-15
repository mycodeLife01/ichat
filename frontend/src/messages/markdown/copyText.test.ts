import { describe, expect, it, vi } from "vitest";

import { copyText } from "./copyText";

describe("copyText", () => {
  it("reports a resolved Clipboard write", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyText("const answer = 42;")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
  });

  it("reports a rejected Clipboard write without throwing", async () => {
    const writeText = vi.fn().mockRejectedValue(
      new DOMException("Clipboard denied", "NotAllowedError"),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyText("const answer = 42;")).resolves.toBe(false);
    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
  });

  it("reports an unavailable Clipboard API", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });

    await expect(copyText("const answer = 42;")).resolves.toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { isNewChatHotkey } from "./hotkeys";

// jsdom reports an empty navigator.platform, so the module resolves to the
// non-mac (Ctrl) branch — these tests cover the Windows/Linux behavior.
function keydown(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", init);
}

describe("isNewChatHotkey", () => {
  it("matches Ctrl+Shift+O", () => {
    expect(isNewChatHotkey(keydown({ ctrlKey: true, shiftKey: true, key: "O" }))).toBe(true);
  });

  it("rejects browser-reserved and partial combos", () => {
    expect(isNewChatHotkey(keydown({ ctrlKey: true, key: "n" }))).toBe(false);
    expect(isNewChatHotkey(keydown({ ctrlKey: true, key: "o" }))).toBe(false);
    expect(isNewChatHotkey(keydown({ shiftKey: true, key: "O" }))).toBe(false);
    expect(
      isNewChatHotkey(keydown({ ctrlKey: true, shiftKey: true, altKey: true, key: "O" })),
    ).toBe(false);
    // Meta on a non-mac platform is not the new-chat modifier.
    expect(isNewChatHotkey(keydown({ metaKey: true, shiftKey: true, key: "O" }))).toBe(false);
  });
});

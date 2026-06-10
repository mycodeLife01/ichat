// Platform-aware hotkeys. New-chat uses Ctrl/⌘+Shift+O (the de-facto standard
// in chat apps): plain Ctrl/⌘+N is browser-reserved (new window) and never
// reaches the page, and Ctrl+Shift+N (incognito) is reserved too.

export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export const newChatHotkeyLabel = isMac ? "⌘ ⇧ O" : "Ctrl+Shift+O";

export function isNewChatHotkey(event: KeyboardEvent): boolean {
  return (
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "o"
  );
}

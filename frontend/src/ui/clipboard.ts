function copyWithSelection(text: string): boolean {
  if (typeof document.execCommand !== "function") return false;

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.dataset.clipboardFallback = "";
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    fontSize: "16px",
  });
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }
}

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Selection copy is best-effort; mobile browsers may also reject it once
      // the original user gesture has expired.
    }
  }

  return copyWithSelection(text);
}

// WebKit requires clipboard writes to begin inside the original click/touch
// gesture. The text may resolve later, so pass it to ClipboardItem as a promise
// while starting navigator.clipboard.write synchronously from the handler.
export function startDeferredTextCopy(text: Promise<string>): Promise<boolean> | null {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return null;

  const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
  // ClipboardItem consumes this promise, but attaching an explicit rejection
  // handler also prevents an unhandled rejection if construction/write throws.
  void blob.catch(() => undefined);

  try {
    return navigator.clipboard
      .write([new ClipboardItem({ "text/plain": blob })])
      .then(
        () => true,
        () => false,
      );
  } catch {
    return null;
  }
}

import { createContext } from "react";
import type { SearchTarget } from "./types";
import {
  buildVisibleSearchText,
  rangeForMatch,
  searchTextHash,
} from "./searchText";

export const SearchRevealContext = createContext<string | null>(null);

type HighlightRegistry = {
  set: (name: string, value: unknown) => void;
  delete: (name: string) => void;
};
const registry = () =>
  (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights;
const highlight = (range: Range) => {
  const Constructor = (
    window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
  ).Highlight;
  if (Constructor)
    registry()?.set("conversation-search-hit", new Constructor(range));
};

/** Paint text without replacing React-owned nodes, including syntax-highlighted code. */
export function revealSearchResult(
  scrollRoot: HTMLElement,
  target: SearchTarget,
  onMissing: () => void,
  onUserCancel?: () => void,
) {
  let cancelled = false;
  let frame = 0;
  let observer: MutationObserver | undefined = undefined;
  let resize: ResizeObserver | undefined = undefined;
  const source = [
    ...scrollRoot.querySelectorAll<HTMLElement>(
      `[data-search-field="${target.field}"]`,
    ),
  ].find((node) => node.dataset.searchMessageId === target.message_id);
  let range: Range | null = null;
  let readyAt = 0;
  let stableAt = 0;
  let previousTop = -1;
  let previousHeight = -1;
  let startedAt = 0;
  let rebuilding = false;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cleanup = () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    resize?.disconnect();
    registry()?.delete("conversation-search-hit");
    document.documentElement.style.removeProperty("--search-hit-alpha");
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
      scrollRoot.removeEventListener(event, cancelByUser);
  };
  const cancelByUser = () => { cleanup(); onUserCancel?.(); };
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
    scrollRoot.addEventListener(event, cancelByUser, { once: true });
  const missing = () => {
    cleanup();
    const top = source
      ? scrollRoot.scrollTop +
        source.getBoundingClientRect().top -
        scrollRoot.getBoundingClientRect().top -
        80
      : scrollRoot.scrollHeight;
    scrollRoot.scrollTo({
      top: Math.max(0, top),
      behavior: reduce ? "auto" : "smooth",
    });
    onMissing();
  };
  const rebuild = async () => {
    if (cancelled || rebuilding || !source) return;
    rebuilding = true;
    const projection = buildVisibleSearchText(source);
    const valid =
      target.projection_version === 1 &&
      (await searchTextHash(projection.text)) === target.projection_hash;
    rebuilding = false;
    if (cancelled) return;
    if (!valid) {
      missing();
      return;
    }
    range = rangeForMatch(projection, target.start, target.end);
    if (!range) {
      missing();
      return;
    }
    if (startedAt) highlight(range);
  };
  const position = () => {
    if (!range) return;
    const rect = range.getBoundingClientRect();
    const rootRect = scrollRoot.getBoundingClientRect();
    const top =
      scrollRoot.scrollTop +
      rect.top -
      rootRect.top -
      scrollRoot.clientHeight * 0.35;
    scrollRoot.scrollTo({
      top: Math.max(0, top),
      behavior: reduce ? "auto" : "smooth",
    });
  };
  const tick = (now: number) => {
    if (cancelled) return;
    if (range && !readyAt) {
      readyAt = now;
      position();
    }
    if (range && !startedAt) {
      const top = scrollRoot.scrollTop;
      const height = scrollRoot.scrollHeight;
      if (Math.abs(top - previousTop) > 0.5 || height !== previousHeight)
        stableAt = now;
      previousTop = top;
      previousHeight = height;
      if (now - stableAt > 160 && now - readyAt > 180) {
        startedAt = now;
        highlight(range);
      }
    }
    if (startedAt) {
      const elapsed = now - startedAt;
      if (elapsed >= (reduce ? 2000 : 3000)) {
        cleanup();
        return;
      }
      document.documentElement.style.setProperty(
        "--search-hit-alpha",
        String(0.6 * (reduce ? 1 : Math.min(1, (3000 - elapsed) / 1000))),
      );
    }
    frame = requestAnimationFrame(tick);
  };
  if (!source) {
    missing();
    return cleanup;
  }
  observer = new MutationObserver(() => {
    void rebuild();
  });
  observer.observe(source, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  resize = new ResizeObserver(() => {
    if (readyAt && !startedAt) position();
  });
  resize.observe(scrollRoot.firstElementChild ?? scrollRoot);
  void rebuild();
  frame = requestAnimationFrame(tick);
  return cleanup;
}

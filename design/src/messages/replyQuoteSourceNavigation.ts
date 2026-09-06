import type { ReplyQuoteSourceAnchor } from "../api/types";

const SOURCE_SELECTOR = "[data-reply-quote-start][data-reply-quote-end]";
const HIGHLIGHT_BACKGROUND = "rgba(255, 235, 140, 0.6)";
const HIGHLIGHT_HOLD_MS = 2_000;
const HIGHLIGHT_FADE_MS = 1_000;
const SCROLL_TIMEOUT_MS = 900;

type RevealReplyQuoteSourceInput = {
  scrollRoot: HTMLElement;
  sourceRoot: HTMLElement;
  sourceAnchor?: ReplyQuoteSourceAnchor | null;
  excerpt: string;
};

export type ReplyQuoteRevealHandle = {
  revealed: boolean;
  cancel: () => void;
};

const activeHighlights = new WeakMap<HTMLElement, ReplyQuoteRevealHandle>();

function parseAnchor(element: Element): ReplyQuoteSourceAnchor | null {
  const start = Number(element.getAttribute("data-reply-quote-start"));
  const end = Number(element.getAttribute("data-reply-quote-end"));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    return null;
  }
  return { version: 1, start, end };
}

export function captureReplyQuoteSourceAnchor(
  range: Range,
  sourceRoot: HTMLElement,
): ReplyQuoteSourceAnchor | null {
  const startElement =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const anchorElement = startElement?.closest(SOURCE_SELECTOR);
  if (!anchorElement || !sourceRoot.contains(anchorElement)) return null;
  return parseAnchor(anchorElement);
}

function exactTarget(
  sourceRoot: HTMLElement,
  anchor: ReplyQuoteSourceAnchor,
): HTMLElement | null {
  for (const candidate of sourceRoot.querySelectorAll<HTMLElement>(SOURCE_SELECTOR)) {
    const parsed = parseAnchor(candidate);
    if (parsed?.start === anchor.start && parsed.end === anchor.end) return candidate;
  }
  return null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

type NormalizedTextMap = {
  text: string;
  nodes: Node[];
};

function normalizedSelectableText(sourceRoot: HTMLElement): NormalizedTextMap {
  const walker = document.createTreeWalker(sourceRoot, NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  let text = "";
  let pendingWhitespaceNode: Node | null = null;
  let current = walker.nextNode();

  while (current) {
    const parent = current.parentElement;
    const selectableAnchor = parent?.closest(SOURCE_SELECTOR);
    const excluded = parent?.closest("button, [data-reply-quote-exclude]");
    if (selectableAnchor && sourceRoot.contains(selectableAnchor) && !excluded) {
      for (const character of current.textContent ?? "") {
        if (/\s/u.test(character)) {
          if (text && pendingWhitespaceNode === null) pendingWhitespaceNode = current;
          continue;
        }
        if (pendingWhitespaceNode !== null) {
          text += " ";
          nodes.push(pendingWhitespaceNode);
          pendingWhitespaceNode = null;
        }
        text += character;
        for (let index = 0; index < character.length; index += 1) nodes.push(current);
      }
    }
    current = walker.nextNode();
  }

  return { text, nodes };
}

function uniqueOccurrence(haystack: string, needle: string): number | null {
  if (!needle) return null;
  const first = haystack.indexOf(needle);
  if (first < 0 || haystack.indexOf(needle, first + 1) >= 0) return null;
  return first;
}

function legacyTarget(sourceRoot: HTMLElement, excerpt: string): HTMLElement | null {
  const normalizedExcerpt = collapseWhitespace(excerpt);
  const normalizedSource = normalizedSelectableText(sourceRoot);
  const matchStart = uniqueOccurrence(normalizedSource.text, normalizedExcerpt);
  const startNode = matchStart === null ? null : normalizedSource.nodes[matchStart];
  const target = startNode?.parentElement?.closest<HTMLElement>(SOURCE_SELECTOR);
  return target && sourceRoot.contains(target) ? target : null;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function setOrRemoveStyle(element: HTMLElement, name: string, value: string): void {
  if (value) element.style.setProperty(name, value);
  else element.style.removeProperty(name);
}

export function revealReplyQuoteSource({
  scrollRoot,
  sourceRoot,
  sourceAnchor,
  excerpt,
}: RevealReplyQuoteSourceInput): ReplyQuoteRevealHandle {
  const highlightTarget = sourceAnchor
    ? exactTarget(sourceRoot, sourceAnchor)
    : legacyTarget(sourceRoot, excerpt);
  const scrollTarget = highlightTarget ?? sourceRoot;
  const previous = highlightTarget ? activeHighlights.get(highlightTarget) : undefined;
  previous?.cancel();

  let scrollTimeout: number | null = null;
  let holdTimeout: number | null = null;
  let fadeTimeout: number | null = null;
  let animationFrame: number | null = null;
  let cancelled = false;
  let highlighted = false;
  const originalBackground = highlightTarget?.style.backgroundColor ?? "";
  const originalTransition = highlightTarget?.style.transition ?? "";

  const handle: ReplyQuoteRevealHandle = {
    revealed: false,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      scrollRoot.removeEventListener("scrollend", finishScroll);
      if (scrollTimeout !== null) window.clearTimeout(scrollTimeout);
      if (holdTimeout !== null) window.clearTimeout(holdTimeout);
      if (fadeTimeout !== null) window.clearTimeout(fadeTimeout);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      if (highlighted && highlightTarget) {
        setOrRemoveStyle(highlightTarget, "background-color", originalBackground);
        setOrRemoveStyle(highlightTarget, "transition", originalTransition);
      }
      if (highlightTarget && activeHighlights.get(highlightTarget) === handle) {
        activeHighlights.delete(highlightTarget);
      }
    },
  };

  const reducedMotion = prefersReducedMotion();
  const reveal = () => {
    if (cancelled || !highlightTarget) return;
    highlighted = true;
    handle.revealed = true;
    highlightTarget.style.transition = "none";
    highlightTarget.style.backgroundColor = HIGHLIGHT_BACKGROUND;
    holdTimeout = window.setTimeout(() => {
      if (cancelled) return;
      if (reducedMotion) {
        setOrRemoveStyle(highlightTarget, "background-color", originalBackground);
        setOrRemoveStyle(highlightTarget, "transition", originalTransition);
        highlighted = false;
        activeHighlights.delete(highlightTarget);
        return;
      }
      highlightTarget.style.transition = "background-color 1s";
      setOrRemoveStyle(highlightTarget, "background-color", originalBackground);
      fadeTimeout = window.setTimeout(() => {
        if (cancelled) return;
        setOrRemoveStyle(highlightTarget, "transition", originalTransition);
        setOrRemoveStyle(highlightTarget, "background-color", originalBackground);
        highlighted = false;
        activeHighlights.delete(highlightTarget);
      }, HIGHLIGHT_FADE_MS);
    }, HIGHLIGHT_HOLD_MS);
  };

  let scrollFinished = false;
  function finishScroll() {
    if (scrollFinished || cancelled) return;
    scrollFinished = true;
    scrollRoot.removeEventListener("scrollend", finishScroll);
    if (scrollTimeout !== null) window.clearTimeout(scrollTimeout);
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    reveal();
  }

  if (highlightTarget) activeHighlights.set(highlightTarget, handle);
  const scrollRootRect = scrollRoot.getBoundingClientRect();
  const targetRect = scrollTarget.getBoundingClientRect();
  const contextOffset = Math.min(200, Math.max(70, scrollRoot.clientHeight * 0.2));
  const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
  const targetScrollTop = Math.min(
    maxScrollTop,
    Math.max(
      0,
      scrollRoot.scrollTop + targetRect.top - scrollRootRect.top - contextOffset,
    ),
  );
  const alreadyAtTarget = Math.abs(scrollRoot.scrollTop - targetScrollTop) < 1;

  scrollRoot.addEventListener("scrollend", finishScroll);
  if (typeof scrollRoot.scrollTo === "function") {
    scrollRoot.scrollTo({ top: targetScrollTop, behavior: reducedMotion ? "auto" : "smooth" });
  } else {
    scrollRoot.scrollTop = targetScrollTop;
  }

  if (reducedMotion || alreadyAtTarget) {
    finishScroll();
    return handle;
  }

  let stableFrames = 0;
  let observedScrollMovement = false;
  let previousScrollTop = scrollRoot.scrollTop;
  const waitForStableScroll = () => {
    if (cancelled || scrollFinished) return;
    const movement = Math.abs(scrollRoot.scrollTop - previousScrollTop);
    if (movement >= 0.5) {
      observedScrollMovement = true;
      stableFrames = 0;
    } else if (
      observedScrollMovement ||
      Math.abs(scrollRoot.scrollTop - targetScrollTop) < 1
    ) {
      stableFrames += 1;
    }
    previousScrollTop = scrollRoot.scrollTop;
    if (stableFrames >= 3) {
      finishScroll();
      return;
    }
    animationFrame = window.requestAnimationFrame(waitForStableScroll);
  };
  animationFrame = window.requestAnimationFrame(waitForStableScroll);
  scrollTimeout = window.setTimeout(finishScroll, SCROLL_TIMEOUT_MS);

  return handle;
}

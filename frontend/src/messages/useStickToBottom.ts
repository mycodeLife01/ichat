import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type Metrics = { scrollHeight: number; scrollTop: number; clientHeight: number };

const SCROLL_TO_BOTTOM_THRESHOLD = 136;

export function distanceFromBottom(el: Metrics): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function isNearBottom(el: Metrics, threshold = 80): boolean {
  return distanceFromBottom(el) < threshold;
}

export function isScrolledFromBottom(
  el: Metrics,
  threshold = SCROLL_TO_BOTTOM_THRESHOLD,
): boolean {
  return distanceFromBottom(el) > threshold;
}

// Sticks the scroll container to the bottom on dependency change while "pinned".
// Pinning is intent-based, tracked from scroll events: scrolling up unpins
// immediately (even within the near-bottom threshold, so a reader dragging away
// mid-stream isn't fought back down), and returning near the bottom re-pins.
// When forceKey changes (entering a conversation, sending a message), scrolls
// to the bottom unconditionally and re-pins.
export function useStickToBottom<T extends HTMLElement>(
  deps: ReadonlyArray<unknown>,
  forceKey?: unknown,
) {
  const ref = useRef<T>(null);
  const lastForceKey = useRef(forceKey);
  const pinned = useRef(true);
  const scrollingToBottom = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Distinguishes user scrolls from the hook's own programmatic ones inside
  // the shared scroll handler.
  const lastSetTop = useRef(-1);
  // Previous observed position, for scroll-direction detection.
  const prevTop = useRef(0);

  const syncScrollFromBottom = useCallback((el: Metrics) => {
    const next = isScrolledFromBottom(el);
    setShowScrollToBottom((current) => (current === next ? current : next));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      if (top !== lastSetTop.current) {
        if (scrollingToBottom.current) {
          if (top < prevTop.current) {
            // An upward gesture interrupts the smooth return-to-latest motion.
            scrollingToBottom.current = false;
            pinned.current = false;
          } else if (isNearBottom(el)) {
            scrollingToBottom.current = false;
            pinned.current = true;
          }
        } else {
          // Any upward user scroll unpins, even within the near-bottom threshold;
          // scrolling down re-pins once back near the bottom.
          pinned.current = top < prevTop.current ? false : isNearBottom(el);
        }
      }
      if (scrollingToBottom.current) setShowScrollToBottom(false);
      else syncScrollFromBottom(el);
      prevTop.current = top;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
    // The ref is populated by the same commit that runs this effect; re-running
    // on every dep change re-attaches to the current element if it was swapped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, syncScrollFromBottom]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const force = forceKey !== lastForceKey.current;
    lastForceKey.current = forceKey;
    if (force) {
      pinned.current = true;
      scrollingToBottom.current = false;
    }
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
      lastSetTop.current = el.scrollTop;
      prevTop.current = el.scrollTop;
      setShowScrollToBottom(false);
    } else if (!scrollingToBottom.current) {
      // New content can cross the reveal threshold without firing a scroll
      // event while the reader remains parked above the latest response.
      syncScrollFromBottom(el);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, forceKey, syncScrollFromBottom]);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    pinned.current = true;
    setShowScrollToBottom(false);

    const top = el.scrollHeight;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    if (typeof el.scrollTo === "function") {
      scrollingToBottom.current = !reduceMotion;
      const scroll = () => {
        if (!reduceMotion && (!scrollingToBottom.current || ref.current !== el)) return;
        el.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
      };
      if (!reduceMotion && typeof window.setTimeout === "function") {
        // Chromium can cancel a native smooth-scroll transaction when the
        // clicked sticky control is still completing its 100ms exit transform.
        // Start after that transition, but abandon the request if the reader
        // has already interrupted it with an upward gesture.
        window.setTimeout(scroll, 100);
      } else {
        scroll();
      }
      if (reduceMotion) {
        lastSetTop.current = el.scrollTop;
        prevTop.current = el.scrollTop;
      }
      return;
    }

    // jsdom and older embedded browsers do not expose Element.scrollTo.
    el.scrollTop = top;
    scrollingToBottom.current = false;
    lastSetTop.current = el.scrollTop;
    prevTop.current = el.scrollTop;
  }, []);

  return { ref, showScrollToBottom, scrollToBottom };
}

import { useEffect, useRef } from "react";

type Metrics = { scrollHeight: number; scrollTop: number; clientHeight: number };

export function isNearBottom(el: Metrics, threshold = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
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
  // Distinguishes user scrolls from the hook's own programmatic ones inside
  // the shared scroll handler.
  const lastSetTop = useRef(-1);
  // Previous observed position, for scroll-direction detection.
  const prevTop = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      if (top !== lastSetTop.current) {
        // Any upward user scroll unpins, even within the near-bottom threshold;
        // scrolling down re-pins once back near the bottom.
        pinned.current = top < prevTop.current ? false : isNearBottom(el);
      }
      prevTop.current = top;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
    // The ref is populated by the same commit that runs this effect; re-running
    // on every dep change re-attaches to the current element if it was swapped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const force = forceKey !== lastForceKey.current;
    lastForceKey.current = forceKey;
    if (force) pinned.current = true;
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
      lastSetTop.current = el.scrollTop;
      prevTop.current = el.scrollTop;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, forceKey]);
  return ref;
}

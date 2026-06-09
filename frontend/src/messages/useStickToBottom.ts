import { useEffect, useRef } from "react";

type Metrics = { scrollHeight: number; scrollTop: number; clientHeight: number };

export function isNearBottom(el: Metrics, threshold = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

// Sticks the scroll container to the bottom on dependency change, but only when
// the user is already near the bottom — leaves them alone while reading history.
export function useStickToBottom<T extends HTMLElement>(deps: ReadonlyArray<unknown>) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (isNearBottom(el)) {
      el.scrollTop = el.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

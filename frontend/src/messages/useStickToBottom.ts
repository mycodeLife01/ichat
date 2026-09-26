import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type Metrics = { scrollHeight: number; scrollTop: number; clientHeight: number };

const SCROLL_TO_BOTTOM_THRESHOLD = 136;
// A new turn whose natural position already sits in the top third of the
// scrollport is left in place instead of being lifted to the top.
const ANCHOR_TRIGGER_RATIO = 1 / 3;
// Space kept visible below an oversized user message for the reply's start.
const REPLY_PEEK = 120;
// Gap above an anchored user message. Desktop tucks the previous reply's action
// bar out of view; mobile clears the floating top-right header controls, which
// overlap right-aligned user bubbles. Kept separate from the 60px .msg
// scroll-margin that search and quote navigation rely on.
const ANCHOR_GAP = 40;
const MOBILE_ANCHOR_GAP = 60;
const MOBILE_QUERY = "(max-width: 760px)";
// The lift to a new turn is a short, front-loaded ease-out so it reads as a
// snap rather than the browser's distance-scaled smooth-scroll glide.
const ANCHOR_ANIMATION_MS = 440;
const EASE_OUT_CUBIC = "cubic-bezier(0.33, 1, 0.68, 1)";

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

// bottom: follow the latest content. anchored: hold the newest user message
// near the top while its reply streams below. free: the reader is in control.
type Mode = "bottom" | "anchored" | "free";

type Anchor = {
  target: HTMLElement;
  // A turn left at its natural position keeps a fixed offset; a lifted turn
  // is re-measured so late layout (collapse, images, resize) stays aligned.
  // Either way an oversized message keeps its end and the reply start in view.
  fixedTop: number | null;
};

// Scroll-content coordinate of a viewport y value.
function toScrollY(el: HTMLElement, y: number): number {
  return y - el.getBoundingClientRect().top + el.scrollTop;
}

function stageTop(el: HTMLElement, stage: HTMLElement, shift = 0): number {
  return toScrollY(el, stage.getBoundingClientRect().top) - shift;
}

// Current translateY of an element, including a running animation.
function translateY(node: HTMLElement): number {
  const transform = getComputedStyle(node).transform;
  return !transform || transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
}

function anchorGap(): number {
  return typeof window !== "undefined" && window.matchMedia?.(MOBILE_QUERY).matches === true
    ? MOBILE_ANCHOR_GAP
    : ANCHOR_GAP;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

// Sticks the scroll container to the bottom on dependency change while in
// bottom mode. Following is intent-based, tracked from scroll events: scrolling
// up leaves bottom mode immediately (even within the near-bottom threshold, so
// a reader dragging away mid-stream isn't fought back down), and returning near
// the bottom re-enters it. When forceKey changes (entering a conversation),
// scrolls to the bottom unconditionally.
//
// anchorNextTurn() arms send-anchored scrolling: the next turnKey change lifts
// the newest user message to the top of the scrollport and reserves space
// below it (min-height on the stage) so the reply grows without moving the
// viewport. Once the reader leaves the anchor, the reserve only shrinks, so
// no blank space outlives the scroll position that needed it.
export function useStickToBottom<T extends HTMLElement>(
  deps: ReadonlyArray<unknown>,
  forceKey?: unknown,
  turnKey?: string | null,
) {
  const ref = useRef<T>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const lastForceKey = useRef(forceKey);
  const mode = useRef<Mode>("bottom");
  const anchor = useRef<Anchor | null>(null);
  const armedFrom = useRef<{ key: string | null } | null>(null);
  const reserve = useRef<number | null>(null);
  const animatingTo = useRef<number | null>(null);
  const lift = useRef<{ animation: Animation; start: number } | null>(null);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const searchPaused = useRef(false);
  const scrollingToBottom = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Distinguishes user scrolls from the hook's own programmatic ones inside
  // the shared scroll handler.
  const lastSetTop = useRef(-1);
  // Previous observed position, for scroll-direction detection.
  const prevTop = useRef(0);

  const footerHeight = () => footerRef.current?.offsetHeight ?? 0;

  // Where the real content ends: the stage's reserve and the thread's flex
  // stretch are blank space that the return control must not count.
  const contentEnd = useCallback((el: HTMLElement): number | null => {
    const inner = stageRef.current?.querySelector<HTMLElement>(".thread-inner");
    const last = inner?.lastElementChild;
    if (!inner || !last) return null;
    const padding = Number.parseFloat(getComputedStyle(inner).paddingBottom) || 0;
    return toScrollY(el, last.getBoundingClientRect().bottom) + padding;
  }, []);

  const effectiveMetrics = useCallback(
    (el: HTMLElement): Metrics => {
      const end = contentEnd(el);
      const scrollHeight =
        end === null
          ? el.scrollHeight
          : Math.min(el.scrollHeight, Math.max(el.clientHeight, end + footerHeight()));
      return { scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight };
    },
    [contentEnd],
  );

  const syncScrollFromBottom = useCallback(
    (el: HTMLElement) => {
      const next = isScrolledFromBottom(effectiveMetrics(el));
      setShowScrollToBottom((current) => (current === next ? current : next));
    },
    [effectiveMetrics],
  );

  const setReserve = (value: number | null) => {
    const stage = stageRef.current;
    reserve.current = value;
    if (stage) stage.style.minHeight = value === null ? "" : `${value}px`;
  };

  // Shrink-only: keep just enough reserve for the current scroll position.
  const releaseReserve = useCallback(
    (el: HTMLElement) => {
      const stage = stageRef.current;
      if (reserve.current === null || !stage) return;
      const top = stageTop(el, stage);
      const needed = el.scrollTop + el.clientHeight - footerHeight() - top;
      const next = Math.min(reserve.current, needed);
      const end = contentEnd(el);
      setReserve(end !== null && next <= end - top + 0.5 ? null : next);
    },
    [contentEnd],
  );

  const setTop = (el: HTMLElement, top: number) => {
    el.scrollTop = top;
    lastSetTop.current = el.scrollTop;
    prevTop.current = el.scrollTop;
  };

  // Stage content measured mid-lift is displaced by the lift's translateY.
  const liftShift = (): number =>
    lift.current && stageRef.current ? translateY(stageRef.current) : 0;

  const anchorTop = (el: HTMLElement, current: Anchor, shift = 0): number => {
    const rect = current.target.getBoundingClientRect();
    const gap = anchorGap();
    const visible = el.clientHeight - footerHeight();
    return Math.max(
      0,
      current.fixedTop ?? toScrollY(el, rect.top) - shift - gap,
      toScrollY(el, rect.bottom) - shift - (visible - REPLY_PEEK),
    );
  };

  // Stage height that lets the viewport rest at `top`.
  const reserveFor = (el: HTMLElement, stage: HTMLElement, top: number, shift = 0): number =>
    Math.max(0, top + el.clientHeight - footerHeight() - stageTop(el, stage, shift));

  // The lift jumps scrollTop to its target once and eases the stage in with a
  // compositor-driven transform. Per-frame scrollTop writes stutter on phones:
  // they compete with streaming renders on the main thread and snap to device
  // pixels, which shakes the text above the new turn.
  const startLift = (el: HTMLElement, from: number, to: number, duration: number) => {
    const stage = stageRef.current!;
    lift.current?.animation.cancel();
    animatingTo.current = to;
    setTop(el, to);
    const animation = stage.animate(
      [{ transform: `translateY(${to - from}px)` }, { transform: "translateY(0)" }],
      { duration, easing: EASE_OUT_CUBIC },
    );
    lift.current = { animation, start: performance.now() };
    animation.onfinish = () => {
      if (lift.current?.animation !== animation) return;
      lift.current = null;
      animatingTo.current = null;
      // Trim the in-flight reserve to exactly what the landed anchor needs.
      if (mode.current === "anchored") holdAnchor(el);
      syncScrollFromBottom(el);
    };
  };

  // Keeps the stage tall enough for the anchor and the viewport on it.
  const holdAnchor = useCallback((el: HTMLElement) => {
    const current = anchor.current;
    const stage = stageRef.current;
    // A scrollport without layout (hidden, or jsdom) has nothing to align.
    if (!current || !stage || el.clientHeight === 0) return;
    const shift = liftShift();
    const onScreen = el.scrollTop - shift;
    const top = anchorTop(el, current, shift);
    setReserve(reserveFor(el, stage, top, shift));
    const running = lift.current;
    if (running && animatingTo.current !== null) {
      // Late layout moved the target mid-lift: continue from what is on
      // screen now toward the new target over the remaining time.
      if (Math.abs(animatingTo.current - top) >= 1) {
        const elapsed = performance.now() - running.start;
        startLift(el, onScreen, top, Math.max(1, ANCHOR_ANIMATION_MS - elapsed));
      }
    } else if (Math.abs(el.scrollTop - top) >= 1) {
      setTop(el, top);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ends a running lift. With a scrollport, whatever is on screen becomes the
  // real scroll position so an interrupting gesture continues from there.
  const stopAnimation = (el?: HTMLElement) => {
    const running = lift.current;
    if (running) {
      const shift = liftShift();
      lift.current = null;
      running.animation.cancel();
      if (el && Math.abs(shift) >= 0.5) setTop(el, el.scrollTop - shift);
    }
    animatingTo.current = null;
  };

  const clearAnchor = (el?: HTMLElement) => {
    stopAnimation(el);
    const target = anchor.current?.target;
    if (target) resizeObserver.current?.unobserve(target);
    anchor.current = null;
  };

  const leaveAnchor = (next: Mode, el: HTMLElement) => {
    if (mode.current === "anchored") clearAnchor(el);
    mode.current = next;
    if (next !== "anchored") releaseReserve(el);
  };

  const anchorNewestTurn = (el: HTMLElement) => {
    const stage = stageRef.current;
    const users = stage?.querySelectorAll<HTMLElement>(".msg.user");
    const target = users?.[users.length - 1];
    if (!stage || !target) {
      leaveAnchor("bottom", el);
      return;
    }
    // The previous turn's reserve stays until the new one replaces it: dropping
    // it first would clamp scrollTop back into earlier content, and the lift
    // would then replay that content instead of just pushing this turn up.
    clearAnchor(el);
    mode.current = "anchored";
    scrollingToBottom.current = false;
    setShowScrollToBottom(false);
    if (el.clientHeight === 0) {
      setReserve(null);
      return;
    }
    const naturalTop = Math.max(0, effectiveMetrics(el).scrollHeight - el.clientHeight);
    const offset = toScrollY(el, target.getBoundingClientRect().top) - naturalTop;
    anchor.current = {
      target,
      fixedTop: offset <= el.clientHeight * ANCHOR_TRIGGER_RATIO ? naturalTop : null,
    };
    resizeObserver.current?.observe(target);
    const top = anchorTop(el, anchor.current);
    setReserve(reserveFor(el, stage, top));
    if (
      !prefersReducedMotion() &&
      typeof stage.animate === "function" &&
      Math.abs(el.scrollTop - top) >= 1
    ) {
      startLift(el, el.scrollTop, top, ANCHOR_ANIMATION_MS);
    } else {
      setTop(el, top);
    }
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      // Scrolls during the lift are its own frames; gestures cancel it below.
      if (animatingTo.current === null && !searchPaused.current && top !== lastSetTop.current) {
        const metrics = effectiveMetrics(el);
        if (scrollingToBottom.current) {
          if (top < prevTop.current) {
            // An upward gesture interrupts the smooth return-to-latest motion.
            scrollingToBottom.current = false;
            leaveAnchor("free", el);
          } else if (isNearBottom(metrics)) {
            scrollingToBottom.current = false;
            leaveAnchor("bottom", el);
          }
        } else {
          // Any upward user scroll leaves following, even within the
          // near-bottom threshold; scrolling down re-follows once back near
          // the real end of the content.
          leaveAnchor(top < prevTop.current || !isNearBottom(metrics) ? "free" : "bottom", el);
        }
      }
      if (mode.current !== "anchored" && animatingTo.current === null) releaseReserve(el);
      if (scrollingToBottom.current || animatingTo.current !== null) setShowScrollToBottom(false);
      else syncScrollFromBottom(el);
      prevTop.current = top;
    };
    const onUserIntent = () => { searchPaused.current = false; };
    // A deliberate gesture takes over from an in-flight anchor animation.
    const onGesture = () => {
      onUserIntent();
      if (animatingTo.current === null) return;
      stopAnimation(el);
      leaveAnchor("free", el);
    };
    el.addEventListener("scroll", onScroll);
    el.addEventListener("keydown", onUserIntent);
    for (const name of ["wheel", "touchstart", "pointerdown"]) el.addEventListener(name, onGesture);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("keydown", onUserIntent);
      for (const name of ["wheel", "touchstart", "pointerdown"]) el.removeEventListener(name, onGesture);
    };
    // The ref is populated by the same commit that runs this effect; re-running
    // on every dep change re-attaches to the current element if it was swapped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, syncScrollFromBottom, effectiveMetrics, releaseReserve]);

  // The scroll listener re-attaches on every dependency change, so only an
  // unmount may cancel an in-flight lift.
  useEffect(
    () => () => {
      animatingTo.current = null;
      lift.current?.animation.cancel();
      lift.current = null;
    },
    [],
  );

  // Late layout inside an anchored turn (message collapse, image decode,
  // keyboard, Composer growth) must re-measure the anchor without waiting for
  // a React update of the thread.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (mode.current === "anchored") holdAnchor(el);
    });
    observer.observe(el);
    if (footerRef.current) observer.observe(footerRef.current);
    if (anchor.current) observer.observe(anchor.current.target);
    resizeObserver.current = observer;
    return () => {
      observer.disconnect();
      resizeObserver.current = null;
    };
  }, [holdAnchor]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previousForceKey = lastForceKey.current;
    const force = forceKey !== previousForceKey;
    lastForceKey.current = forceKey;
    // A draft conversation's first send creates the conversation: that is the
    // same turn, not a navigation, so it must not undo the anchor.
    if (force && !(previousForceKey == null && mode.current === "anchored")) {
      armedFrom.current = null;
      clearAnchor();
      setReserve(null);
      if (!searchPaused.current) {
        mode.current = "bottom";
        scrollingToBottom.current = false;
      } else if (mode.current === "anchored") {
        mode.current = "free";
      }
    }
    const turn = turnKey ?? null;
    if (armedFrom.current && turn !== null && turn !== armedFrom.current.key) {
      armedFrom.current = null;
      if (!searchPaused.current) anchorNewestTurn(el);
    }
    if (mode.current === "anchored") {
      holdAnchor(el);
      if (animatingTo.current === null) syncScrollFromBottom(el);
    } else if (mode.current === "bottom") {
      setTop(el, effectiveMetrics(el).scrollHeight);
      releaseReserve(el);
      setShowScrollToBottom(false);
    } else if (!scrollingToBottom.current) {
      // New content can cross the reveal threshold without firing a scroll
      // event while the reader remains parked above the latest response.
      syncScrollFromBottom(el);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, forceKey, turnKey, syncScrollFromBottom]);

  // Arms send-anchored scrolling for the turn the caller is about to start.
  const anchorNextTurn = useCallback(() => {
    armedFrom.current = { key: turnKey ?? null };
  }, [turnKey]);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    searchPaused.current = false;
    if (mode.current === "anchored") clearAnchor();
    mode.current = "bottom";
    setShowScrollToBottom(false);

    const top = effectiveMetrics(el).scrollHeight;
    const reduceMotion = prefersReducedMotion();

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
        releaseReserve(el);
      }
      return;
    }

    // jsdom and older embedded browsers do not expose Element.scrollTo.
    el.scrollTop = top;
    scrollingToBottom.current = false;
    lastSetTop.current = el.scrollTop;
    prevTop.current = el.scrollTop;
    releaseReserve(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveMetrics, releaseReserve]);

  const pauseFollowing = useCallback((paused: boolean) => {
    searchPaused.current = paused;
    if (!paused) return;
    scrollingToBottom.current = false;
    if (mode.current === "anchored") clearAnchor();
    mode.current = "free";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    ref,
    stageRef,
    footerRef,
    showScrollToBottom,
    scrollToBottom,
    pauseFollowing,
    anchorNextTurn,
  };
}

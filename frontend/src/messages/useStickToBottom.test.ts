import { useLayoutEffect } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  isNearBottom,
  isScrolledFromBottom,
  useStickToBottom,
} from "./useStickToBottom";

describe("isNearBottom", () => {
  it("is true when within threshold of the bottom", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 930, clientHeight: 100 })).toBe(true);
  });

  it("is false when scrolled up to read history", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 100 })).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 100 }, 250)).toBe(true);
  });
});

describe("isScrolledFromBottom", () => {
  it("reveals the return control only after the ChatGPT reference distance", () => {
    expect(
      isScrolledFromBottom({ scrollHeight: 1000, scrollTop: 764, clientHeight: 100 }),
    ).toBe(false);
    expect(
      isScrolledFromBottom({ scrollHeight: 1000, scrollTop: 763, clientHeight: 100 }),
    ).toBe(true);
  });
});

describe("useStickToBottom", () => {
  // jsdom has no layout, so drive the hook with a fake element exposing the
  // scroll metrics plus a scroll-event seam to simulate user scrolling.
  function fakeEl(scrollTop: number) {
    const listeners = new Map<string, () => void>();
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      el.scrollTop = Number(options.top ?? el.scrollTop);
      listeners.get("scroll")?.();
    });
    const el = {
      scrollHeight: 1000,
      scrollTop,
      clientHeight: 100,
      scrollTo,
      addEventListener(type: string, handler: () => void) {
        listeners.set(type, handler);
      },
      removeEventListener(type: string) {
        listeners.delete(type);
      },
    };
    // A user scroll: move the bar, then fire the scroll event.
    const userScroll = (top: number) => {
      el.scrollTop = top;
      listeners.get("scroll")?.();
    };
    return { el: el as unknown as HTMLElement, scrollTo, userScroll };
  }

  function setup() {
    const hook = renderHook(
      ({ deps, key }) => useStickToBottom<HTMLElement>(deps, key),
      { initialProps: { deps: [1] as unknown[], key: undefined as number | undefined } },
    );
    const { el, scrollTo, userScroll } = fakeEl(900);
    hook.result.current.ref.current = el;
    // First effect after the element exists: attaches the listener and, with
    // the pin engaged by default, sticks to the bottom.
    hook.rerender({ deps: [2], key: undefined });
    expect(el.scrollTop).toBe(1000);
    return { ...hook, el, scrollTo, userScroll };
  }

  it("follows deltas while pinned to the bottom", () => {
    const { el, rerender } = setup();
    rerender({ deps: [3], key: undefined });
    expect(el.scrollTop).toBe(1000);
  });

  it("sticks before the updated thread can paint", () => {
    const observedDuringLayout: number[] = [];
    const hook = renderHook(
      ({ deps }) => {
        const { ref } = useStickToBottom<HTMLElement>(deps);
        useLayoutEffect(() => {
          if (ref.current) observedDuringLayout.push(ref.current.scrollTop);
        }, [deps, ref]);
        return ref;
      },
      { initialProps: { deps: [1] as unknown[] } },
    );
    const { el } = fakeEl(900);
    hook.result.current.current = el;

    hook.rerender({ deps: [2] });

    expect(observedDuringLayout.at(-1)).toBe(1000);
  });

  it("unpins as soon as the user scrolls up, even within the near-bottom threshold", () => {
    const { el, userScroll, rerender } = setup();
    // Barely above the bottom — still inside the 80px threshold. The old
    // position-based check would yank the reader back on the next delta.
    act(() => userScroll(940));
    rerender({ deps: [3], key: undefined });
    expect(el.scrollTop).toBe(940);
  });

  it("stays unpinned while the user reads history", () => {
    const { el, userScroll, rerender } = setup();
    act(() => userScroll(200));
    rerender({ deps: [3], key: undefined });
    rerender({ deps: [4], key: undefined });
    expect(el.scrollTop).toBe(200);
  });

  it("re-pins when the user scrolls back to the bottom", () => {
    const { el, userScroll, rerender } = setup();
    act(() => {
      userScroll(200);
      userScroll(950); // back within the near-bottom threshold
    });
    rerender({ deps: [3], key: undefined });
    expect(el.scrollTop).toBe(1000);
  });

  it("force-scrolls and re-pins when the force key changes, even when scrolled up", () => {
    const { el, userScroll, rerender } = setup();
    act(() => userScroll(200));
    // Entering a conversation / sending a message: the force key advances.
    rerender({ deps: [3], key: 7 });
    expect(el.scrollTop).toBe(1000);
    // Re-pinned: subsequent deltas follow again.
    rerender({ deps: [4], key: 7 });
    expect(el.scrollTop).toBe(1000);
  });

  it("does not force-scroll again while the key stays the same", () => {
    const { el, userScroll, rerender } = setup();
    rerender({ deps: [3], key: 7 });
    act(() => userScroll(200));
    rerender({ deps: [4], key: 7 });
    expect(el.scrollTop).toBe(200);
  });

  it("reveals after scrolling far enough up and smoothly returns to the latest", async () => {
    const { result, scrollTo, userScroll } = setup();

    act(() => userScroll(700));
    expect(result.current.showScrollToBottom).toBe(true);

    act(() => result.current.scrollToBottom());
    expect(result.current.showScrollToBottom).toBe(false);
    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" }),
    );
  });

  it("abandons the delayed return when the reader scrolls farther up", () => {
    vi.useFakeTimers();
    try {
      const { result, scrollTo, userScroll } = setup();

      act(() => userScroll(700));
      act(() => result.current.scrollToBottom());
      act(() => userScroll(600));
      act(() => vi.advanceTimersByTime(100));

      expect(scrollTo).not.toHaveBeenCalled();
      expect(result.current.showScrollToBottom).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

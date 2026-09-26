import { useLayoutEffect } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  describe("send-anchored turns", () => {
    const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
    // jsdom has no matchMedia; each test declares which queries match.
    function mediaMatches(...queries: string[]) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({ matches: queries.includes(query), media: query }) as MediaQueryList,
      });
    }
    // Instant lifts keep the geometry assertions synchronous.
    beforeEach(() => mediaMatches(REDUCED_MOTION));
    afterEach(() => {
      delete (window as { matchMedia?: unknown }).matchMedia;
      vi.unstubAllGlobals();
      document.body.replaceChildren();
    });

    // A minimal layout model for jsdom: the stage holds the thread content
    // (natural height `content`) and grows to its inline min-height; the
    // sticky footer follows it in flow. Rects are derived from scrollTop.
    function layout({
      content,
      userTop,
      userHeight = 40,
      clientHeight = 800,
      footer = 100,
    }: {
      content: number;
      userTop: number;
      userHeight?: number;
      clientHeight?: number;
      footer?: number;
    }) {
      const geometry = { content, userTop, userHeight, scrollTop: 0 };
      const region = document.createElement("div");
      const stage = document.createElement("div");
      const inner = document.createElement("div");
      inner.className = "thread-inner";
      const userMessage = document.createElement("div");
      userMessage.className = "msg user";
      const reply = document.createElement("div");
      inner.append(userMessage, reply);
      stage.append(inner);
      const footerEl = document.createElement("div");
      region.append(stage, footerEl);
      const stageHeight = () =>
        Math.max(geometry.content, Number.parseFloat(stage.style.minHeight) || 0);
      const scrollHeight = () => Math.max(clientHeight, stageHeight() + footer);
      const rect = (top: number, bottom: number) =>
        ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top }) as DOMRect;
      Object.defineProperties(region, {
        clientHeight: { get: () => clientHeight },
        scrollHeight: { get: scrollHeight },
        scrollTop: {
          get: () => geometry.scrollTop,
          set: (value: number) => {
            geometry.scrollTop = Math.max(0, Math.min(value, scrollHeight() - clientHeight));
          },
        },
      });
      region.getBoundingClientRect = () => rect(0, clientHeight);
      region.scrollTo = ((options: ScrollToOptions) => {
        region.scrollTop = Number(options.top ?? region.scrollTop);
        region.dispatchEvent(new Event("scroll"));
      }) as HTMLElement["scrollTo"];
      stage.getBoundingClientRect = () => rect(-geometry.scrollTop, stageHeight() - geometry.scrollTop);
      userMessage.getBoundingClientRect = () =>
        rect(
          geometry.userTop - geometry.scrollTop,
          geometry.userTop + geometry.userHeight - geometry.scrollTop,
        );
      reply.getBoundingClientRect = () =>
        rect(geometry.userTop + geometry.userHeight, geometry.content - geometry.scrollTop);
      Object.defineProperty(footerEl, "offsetHeight", { get: () => footer });
      const userScroll = (top: number) => {
        region.scrollTop = top;
        region.dispatchEvent(new Event("scroll"));
      };
      return { geometry, region, stage, footerEl, userScroll, scrollHeight };
    }

    function mount(model: ReturnType<typeof layout>, forceKey: string | null = "c1") {
      const hook = renderHook(
        ({ deps, force, turn }) => useStickToBottom<HTMLElement>(deps, force, turn),
        {
          initialProps: {
            deps: [1] as unknown[],
            force: forceKey as string | null,
            turn: "run-1" as string | null,
          },
        },
      );
      hook.result.current.ref.current = model.region;
      hook.result.current.stageRef.current = model.stage as HTMLDivElement;
      hook.result.current.footerRef.current = model.footerEl as HTMLDivElement;
      hook.rerender({ deps: [2], force: forceKey, turn: "run-1" });
      return hook;
    }

    it("lifts the newest user message to the top and holds it while the reply grows", () => {
      const model = layout({ content: 2000, userTop: 1900 });
      const hook = mount(model);
      expect(model.region.scrollTop).toBe(1300);

      act(() => hook.result.current.anchorNextTurn());
      model.geometry.content = 2020;
      hook.rerender({ deps: [3], force: "c1", turn: "pending-1" });

      expect(model.region.scrollTop).toBe(1900 - 40);
      expect(model.stage.style.minHeight).toBe("2560px");
      expect(hook.result.current.showScrollToBottom).toBe(false);

      // Streaming deltas within the reserve move neither the viewport nor the
      // scroll height; the materialized Run does not re-anchor.
      const heightBefore = model.scrollHeight();
      model.geometry.content = 2400;
      hook.rerender({ deps: [4], force: "c1", turn: "run-2" });
      expect(model.region.scrollTop).toBe(1900 - 40);
      expect(model.scrollHeight()).toBe(heightBefore);

      // Past the reserve, the reply continues below the fold without following.
      model.geometry.content = 3200;
      hook.rerender({ deps: [5], force: "c1", turn: "run-2" });
      expect(model.region.scrollTop).toBe(1900 - 40);
      expect(hook.result.current.showScrollToBottom).toBe(true);
    });

    it("leaves a larger gap on mobile to clear the floating header controls", () => {
      mediaMatches(REDUCED_MOTION, "(max-width: 760px)");
      const model = layout({ content: 2000, userTop: 1900 });
      const hook = mount(model);
      act(() => hook.result.current.anchorNextTurn());
      hook.rerender({ deps: [3], force: "c1", turn: "pending-1" });
      expect(model.region.scrollTop).toBe(1900 - 60);
    });

    // jsdom has no Web Animations: a fake lift that the test finishes by hand.
    function stubLift(stage: HTMLElement) {
      const lifts: { keyframes: Keyframe[]; duration: number; animation: Animation }[] = [];
      stage.animate = ((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
        const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
        lifts.push({ keyframes, duration: Number(options.duration), animation });
        return animation;
      }) as HTMLElement["animate"];
      const finish = () => act(() => {
        const animation = lifts[lifts.length - 1]!.animation;
        animation.onfinish?.call(animation, {} as AnimationPlaybackEvent);
      });
      return { lifts, finish };
    }

    it("lifts with one scroll write and a transform that eases the stage in", () => {
      mediaMatches();
      const model = layout({ content: 2000, userTop: 1900 });
      const { lifts, finish } = stubLift(model.stage);
      const hook = mount(model);
      act(() => hook.result.current.anchorNextTurn());
      model.geometry.content = 2020;
      hook.rerender({ deps: [3], force: "c1", turn: "pending-1" });

      // The scrollport lands at once; the stage starts where the old view was.
      expect(model.region.scrollTop).toBe(1900 - 40);
      expect(lifts).toHaveLength(1);
      expect(lifts[0]!.keyframes).toEqual([
        { transform: "translateY(560px)" },
        { transform: "translateY(0)" },
      ]);
      expect(lifts[0]!.duration).toBe(440);
      expect(model.stage.style.minHeight).toBe("2560px");

      // The return control stays hidden until the lift lands.
      model.geometry.content = 3200;
      hook.rerender({ deps: [4], force: "c1", turn: "pending-1" });
      expect(hook.result.current.showScrollToBottom).toBe(false);
      finish();
      expect(model.region.scrollTop).toBe(1900 - 40);
      expect(hook.result.current.showScrollToBottom).toBe(true);
    });

    it("hands the on-screen position to a gesture during the lift", () => {
      mediaMatches();
      vi.stubGlobal(
        "DOMMatrixReadOnly",
        class {
          m42: number;
          constructor(transform: string) {
            this.m42 = Number(/translateY\((-?[\d.]+)px\)/.exec(transform)?.[1] ?? 0);
          }
        },
      );
      const model = layout({ content: 2000, userTop: 1900 });
      // Computed styles need a connected tree.
      document.body.append(model.region);
      const { lifts } = stubLift(model.stage);
      const hook = mount(model);
      act(() => hook.result.current.anchorNextTurn());
      hook.rerender({ deps: [3], force: "c1", turn: "pending-1" });

      // Mid-lift the stage still sits 200px below its landed position.
      model.stage.style.transform = "translateY(200px)";
      act(() => {
        model.region.dispatchEvent(new Event("wheel"));
      });
      model.stage.style.transform = "";
      expect(lifts[0]!.animation.cancel).toHaveBeenCalled();
      expect(model.region.scrollTop).toBe(1900 - 40 - 200);

      model.geometry.content = 3200;
      hook.rerender({ deps: [4], force: "c1", turn: "pending-1" });
      expect(model.region.scrollTop).toBe(1900 - 40 - 200);
    });

    it("keeps a turn that already sits in the upper third at its natural position", () => {
      const model = layout({ content: 300, userTop: 200 });
      const hook = mount(model);

      act(() => hook.result.current.anchorNextTurn());
      hook.rerender({ deps: [3], force: "c1", turn: "pending-1" });

      expect(model.region.scrollTop).toBe(0);
      model.geometry.content = 1500;
      hook.rerender({ deps: [4], force: "c1", turn: "pending-1" });
      expect(model.region.scrollTop).toBe(0);
    });

    it("keeps the end of an oversized message and the reply start in view", () => {
      const model = layout({ content: 2700, userTop: 1900, userHeight: 800 });
      const hook = mount(model);

      act(() => hook.result.current.anchorNextTurn());
      hook.rerender({ deps: [3], force: "c1", turn: "pending-1" });

      // Visible reading area is 700px; the message bottom sits 120px above it.
      expect(model.region.scrollTop).toBe(2700 - (700 - 120));
    });

    it("releases the reserve only as the reader scrolls away from it", () => {
      const model = layout({ content: 2000, userTop: 1900 });
      const hook = mount(model);
      act(() => hook.result.current.anchorNextTurn());
      model.geometry.content = 2100;
      hook.rerender({ deps: [3], force: "c1", turn: "pending-1" });
      expect(model.region.scrollTop).toBe(1900 - 40);

      // The Run finishing changes nothing on its own.
      hook.rerender({ deps: [4], force: "c1", turn: "run-2" });
      expect(model.stage.style.minHeight).toBe("2560px");

      act(() => model.userScroll(1700));
      expect(model.stage.style.minHeight).toBe("2400px");
      act(() => model.userScroll(1000));
      expect(model.stage.style.minHeight).toBe("");
      act(() => model.userScroll(5000));
      expect(model.region.scrollTop).toBe(2100 + 100 - 800);
    });

    it("drops the anchor and reserve when entering another conversation", () => {
      const model = layout({ content: 2000, userTop: 1900 });
      const hook = mount(model);
      act(() => hook.result.current.anchorNextTurn());
      hook.rerender({ deps: [3], force: "c1", turn: "pending-1" });
      expect(model.stage.style.minHeight).toBe("2560px");

      hook.rerender({ deps: [4], force: "c2", turn: null });
      expect(model.stage.style.minHeight).toBe("");
      expect(model.region.scrollTop).toBe(1300);
    });

    it("keeps the anchor when a draft conversation is created by its first send", () => {
      const model = layout({ content: 2000, userTop: 1900 });
      const hook = mount(model, null);
      act(() => hook.result.current.anchorNextTurn());
      hook.rerender({ deps: [3], force: null, turn: "pending-1" });
      expect(model.region.scrollTop).toBe(1900 - 40);

      hook.rerender({ deps: [4], force: "c-new", turn: "run-2" });
      expect(model.region.scrollTop).toBe(1900 - 40);
      expect(model.stage.style.minHeight).toBe("2560px");
    });

    it("returns to the real end of the content rather than the reserve", () => {
      const model = layout({ content: 2000, userTop: 1900 });
      const hook = mount(model);
      act(() => hook.result.current.anchorNextTurn());
      model.geometry.content = 3200;
      hook.rerender({ deps: [3], force: "c1", turn: "pending-1" });

      act(() => hook.result.current.scrollToBottom());
      return waitFor(() => expect(model.region.scrollTop).toBe(3200 + 100 - 800));
    });
  });
});

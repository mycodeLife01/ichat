import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureReplyQuoteSourceAnchor,
  revealReplyQuoteSource,
} from "./replyQuoteSourceNavigation";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("replyQuoteSourceNavigation", () => {
  it("captures the Markdown semantic node containing the Range start", () => {
    const sourceRoot = document.createElement("div");
    sourceRoot.innerHTML =
      '<p data-reply-quote-start="0" data-reply-quote-end="30">前缀 <strong data-reply-quote-start="3" data-reply-quote-end="27">good enough to trust</strong> 后缀</p>';
    document.body.append(sourceRoot);
    const text = sourceRoot.querySelector("strong")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, 11);

    expect(captureReplyQuoteSourceAnchor(range, sourceRoot)).toEqual({
      version: 1,
      start: 3,
      end: 27,
    });
  });

  it("captures the first paragraph for a partial selection spanning blocks", () => {
    const sourceRoot = document.createElement("div");
    sourceRoot.innerHTML = [
      '<p data-reply-quote-start="0" data-reply-quote-end="8">第一段文本</p>',
      '<p data-reply-quote-start="10" data-reply-quote-end="18">第二段文本</p>',
    ].join("");
    document.body.append(sourceRoot);
    const paragraphs = sourceRoot.querySelectorAll("p");
    const range = document.createRange();
    range.setStart(paragraphs[0].firstChild!, 2);
    range.setEnd(paragraphs[1].firstChild!, 2);

    expect(captureReplyQuoteSourceAnchor(range, sourceRoot)).toEqual({
      version: 1,
      start: 0,
      end: 8,
    });
  });

  it("scrolls to the exact anchored duplicate, then marks and clears it", () => {
    vi.useFakeTimers();
    const scrollRoot = document.createElement("div");
    const sourceRoot = document.createElement("div");
    sourceRoot.innerHTML = [
      '<strong data-reply-quote-start="10" data-reply-quote-end="34">good enough to trust</strong>',
      '<strong data-reply-quote-start="80" data-reply-quote-end="104">good enough to trust</strong>',
    ].join("");
    scrollRoot.append(sourceRoot);
    const quoteButton = document.createElement("button");
    document.body.append(scrollRoot, quoteButton);
    quoteButton.focus();

    Object.defineProperties(scrollRoot, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 2_000 },
      scrollTop: { value: 300, writable: true },
      scrollTo: {
        value: vi.fn(({ top }: ScrollToOptions) => {
          scrollRoot.scrollTop = Number(top);
        }),
      },
    });
    vi.spyOn(scrollRoot, "getBoundingClientRect").mockReturnValue({
      top: 100,
      right: 800,
      bottom: 600,
      left: 0,
      width: 800,
      height: 500,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    const targets = sourceRoot.querySelectorAll<HTMLElement>("strong");
    vi.spyOn(targets[1], "getBoundingClientRect").mockReturnValue({
      top: 500,
      right: 300,
      bottom: 526,
      left: 100,
      width: 200,
      height: 26,
      x: 100,
      y: 500,
      toJSON: () => ({}),
    });
    const href = window.location.href;

    const handle = revealReplyQuoteSource({
      scrollRoot,
      sourceRoot,
      sourceAnchor: { version: 1, start: 80, end: 104 },
      excerpt: "good enough to trust",
    });

    expect(scrollRoot.scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "smooth" });
    scrollRoot.dispatchEvent(new Event("scrollend"));
    expect(handle.revealed).toBe(true);
    expect(targets[0].style.backgroundColor).toBe("");
    expect(targets[1].style.backgroundColor).toBe("rgba(255, 235, 140, 0.6)");
    expect(document.activeElement).toBe(quoteButton);
    expect(window.location.href).toBe(href);

    vi.advanceTimersByTime(2_000);
    expect(targets[1].style.transition).toBe("background-color 1s");
    vi.advanceTimersByTime(1_000);
    expect(targets[1].style.backgroundColor).toBe("");
    expect(targets[1].style.transition).toBe("");
  });

  it("prefers the outer semantic node when nested nodes share one range", () => {
    const scrollRoot = document.createElement("div");
    const sourceRoot = document.createElement("div");
    sourceRoot.innerHTML =
      '<p data-reply-quote-start="0" data-reply-quote-end="24"><strong data-reply-quote-start="0" data-reply-quote-end="24">good enough to trust</strong></p>';
    scrollRoot.append(sourceRoot);
    document.body.append(scrollRoot);
    Object.defineProperties(scrollRoot, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 500 },
      scrollTop: { value: 0, writable: true },
      scrollTo: { value: vi.fn() },
    });

    const handle = revealReplyQuoteSource({
      scrollRoot,
      sourceRoot,
      sourceAnchor: { version: 1, start: 0, end: 24 },
      excerpt: "good enough to trust",
    });

    expect(handle.revealed).toBe(true);
    expect(sourceRoot.querySelector<HTMLElement>("p")?.style.backgroundColor).toBe(
      "rgba(255, 235, 140, 0.6)",
    );
    expect(sourceRoot.querySelector<HTMLElement>("strong")?.style.backgroundColor).toBe("");
    handle.cancel();
  });

  it("maps a unique legacy excerpt to the semantic node containing its start", () => {
    const scrollRoot = document.createElement("div");
    const sourceRoot = document.createElement("div");
    sourceRoot.innerHTML =
      '<p data-reply-quote-start="0" data-reply-quote-end="34">前缀 <strong data-reply-quote-start="3" data-reply-quote-end="27">good enough to trust</strong> 后缀</p>';
    scrollRoot.append(sourceRoot);
    document.body.append(scrollRoot);
    Object.defineProperties(scrollRoot, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 500 },
      scrollTop: { value: 0, writable: true },
      scrollTo: { value: vi.fn() },
    });

    const handle = revealReplyQuoteSource({
      scrollRoot,
      sourceRoot,
      sourceAnchor: null,
      excerpt: "enough to",
    });

    expect(handle.revealed).toBe(true);
    expect(sourceRoot.querySelector<HTMLElement>("p")?.style.backgroundColor).toBe("");
    expect(sourceRoot.querySelector<HTMLElement>("strong")?.style.backgroundColor).toBe(
      "rgba(255, 235, 140, 0.6)",
    );
    handle.cancel();
  });

  it("waits for delayed smooth-scroll movement before highlighting", () => {
    vi.useFakeTimers();
    const scrollRoot = document.createElement("div");
    const sourceRoot = document.createElement("div");
    sourceRoot.innerHTML =
      '<p data-reply-quote-start="0" data-reply-quote-end="6">来源文本</p>';
    scrollRoot.append(sourceRoot);
    document.body.append(scrollRoot);
    Object.defineProperties(scrollRoot, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 2_000 },
      scrollTop: { value: 0, writable: true },
      scrollTo: { value: vi.fn() },
    });
    vi.spyOn(scrollRoot, "getBoundingClientRect").mockReturnValue({
      top: 0,
      right: 800,
      bottom: 400,
      left: 0,
      width: 800,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const target = sourceRoot.querySelector<HTMLElement>("p")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 800,
      right: 400,
      bottom: 830,
      left: 0,
      width: 400,
      height: 30,
      x: 0,
      y: 800,
      toJSON: () => ({}),
    });

    const handle = revealReplyQuoteSource({
      scrollRoot,
      sourceRoot,
      sourceAnchor: { version: 1, start: 0, end: 6 },
      excerpt: "来源文本",
    });

    vi.advanceTimersByTime(80);
    expect(handle.revealed).toBe(false);
    expect(target.style.backgroundColor).toBe("");

    scrollRoot.scrollTop = 400;
    vi.advanceTimersByTime(16);
    scrollRoot.scrollTop = 720;
    vi.advanceTimersByTime(64);

    expect(handle.revealed).toBe(true);
    expect(target.style.backgroundColor).toBe("rgba(255, 235, 140, 0.6)");
    handle.cancel();
  });

  it("uses the timeout fallback when a smooth scroll never starts", () => {
    vi.useFakeTimers();
    const scrollRoot = document.createElement("div");
    const sourceRoot = document.createElement("div");
    sourceRoot.innerHTML =
      '<p data-reply-quote-start="0" data-reply-quote-end="6">来源文本</p>';
    scrollRoot.append(sourceRoot);
    document.body.append(scrollRoot);
    Object.defineProperties(scrollRoot, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 2_000 },
      scrollTop: { value: 0, writable: true },
      scrollTo: { value: vi.fn() },
    });
    vi.spyOn(scrollRoot, "getBoundingClientRect").mockReturnValue({
      top: 0,
      right: 800,
      bottom: 400,
      left: 0,
      width: 800,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const target = sourceRoot.querySelector<HTMLElement>("p")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 800,
      right: 400,
      bottom: 830,
      left: 0,
      width: 400,
      height: 30,
      x: 0,
      y: 800,
      toJSON: () => ({}),
    });

    const handle = revealReplyQuoteSource({
      scrollRoot,
      sourceRoot,
      sourceAnchor: { version: 1, start: 0, end: 6 },
      excerpt: "来源文本",
    });

    vi.advanceTimersByTime(899);
    expect(handle.revealed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(handle.revealed).toBe(true);
    handle.cancel();
  });

  it("uses immediate auto scroll without a fade for reduced motion", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia,
    );
    const scrollRoot = document.createElement("div");
    const sourceRoot = document.createElement("div");
    sourceRoot.innerHTML =
      '<p data-reply-quote-start="0" data-reply-quote-end="6">来源文本</p>';
    scrollRoot.append(sourceRoot);
    document.body.append(scrollRoot);
    const scrollTo = vi.fn();
    Object.defineProperties(scrollRoot, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 400 },
      scrollTop: { value: 0, writable: true },
      scrollTo: { value: scrollTo },
    });
    const target = sourceRoot.querySelector<HTMLElement>("p")!;
    target.style.backgroundColor = "rgb(1, 2, 3)";
    target.style.transition = "opacity 5s";

    const handle = revealReplyQuoteSource({
      scrollRoot,
      sourceRoot,
      sourceAnchor: { version: 1, start: 0, end: 6 },
      excerpt: "来源文本",
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    expect(handle.revealed).toBe(true);
    expect(target.style.backgroundColor).toBe("rgba(255, 235, 140, 0.6)");
    vi.advanceTimersByTime(2_000);
    expect(target.style.backgroundColor).toBe("rgb(1, 2, 3)");
    expect(target.style.transition).toBe("opacity 5s");
  });

  it("does not guess between repeated legacy excerpts", () => {
    vi.useFakeTimers();
    const scrollRoot = document.createElement("div");
    const sourceRoot = document.createElement("div");
    sourceRoot.innerHTML = [
      '<p data-reply-quote-start="0" data-reply-quote-end="6">重复文本</p>',
      '<p data-reply-quote-start="8" data-reply-quote-end="14">重复文本</p>',
    ].join("");
    scrollRoot.append(sourceRoot);
    document.body.append(scrollRoot);
    Object.defineProperties(scrollRoot, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 500 },
      scrollTop: { value: 0, writable: true },
      scrollTo: { value: vi.fn() },
    });
    vi.spyOn(scrollRoot, "getBoundingClientRect").mockReturnValue({
      top: 0,
      right: 500,
      bottom: 500,
      left: 0,
      width: 500,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(sourceRoot, "getBoundingClientRect").mockReturnValue({
      top: 100,
      right: 500,
      bottom: 200,
      left: 0,
      width: 500,
      height: 100,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });

    const handle = revealReplyQuoteSource({
      scrollRoot,
      sourceRoot,
      sourceAnchor: null,
      excerpt: "重复文本",
    });
    scrollRoot.dispatchEvent(new Event("scrollend"));

    expect(handle.revealed).toBe(false);
    expect(sourceRoot.querySelector("[style]")).toBeNull();
  });
});

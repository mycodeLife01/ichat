import { describe, expect, it } from "vitest";

import { isNearBottom } from "./useStickToBottom";

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

import { describe, expect, it } from "vitest";

import { formatDuration } from "./formatDuration";

describe("formatDuration", () => {
  it.each([
    [0, "不到 1 秒"],
    [999, "不到 1 秒"],
    [1000, "1 秒"],
    [1499, "1 秒"],
    [12_345, "12 秒"],
    [59_499, "59 秒"],
    [59_600, "1 分钟"],
    [60_000, "1 分钟"],
    [83_000, "1 分 23 秒"],
    [120_000, "2 分钟"],
    [3_723_000, "62 分 3 秒"],
  ])("formats %i ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

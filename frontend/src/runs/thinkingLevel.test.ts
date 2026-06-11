import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { thinkingLevelStore, toRunOptions } from "./thinkingLevel";

describe("thinkingLevelStore", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("defaults to fast when nothing stored", () => {
    expect(thinkingLevelStore.read()).toBe("fast");
  });

  it("round-trips a saved level", () => {
    thinkingLevelStore.save("max");
    expect(thinkingLevelStore.read()).toBe("max");
  });

  it("falls back to fast on an unknown stored value", () => {
    localStorage.setItem("ichat.thinkingLevel", "turbo");
    expect(thinkingLevelStore.read()).toBe("fast");
  });
});

describe("toRunOptions", () => {
  it("maps fast to thinking disabled without effort", () => {
    expect(toRunOptions("fast")).toEqual({ thinking_enabled: false });
  });

  it("maps high and max to thinking enabled with effort", () => {
    expect(toRunOptions("high")).toEqual({
      thinking_enabled: true,
      reasoning_effort: "high",
    });
    expect(toRunOptions("max")).toEqual({
      thinking_enabled: true,
      reasoning_effort: "max",
    });
  });
});

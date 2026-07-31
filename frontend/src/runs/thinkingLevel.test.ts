import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clampThinkingLevel,
  thinkingLevelStore,
  toRunOptions,
} from "./thinkingLevel";

describe("thinkingLevelStore", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("defaults to low when nothing stored", () => {
    expect(thinkingLevelStore.read()).toBe("low");
  });

  it("round-trips a saved level", () => {
    thinkingLevelStore.save("xhigh");
    expect(thinkingLevelStore.read()).toBe("xhigh");
  });

  it("migrates the legacy fast level to low", () => {
    localStorage.setItem("ichat.thinkingLevel", "fast");
    expect(thinkingLevelStore.read()).toBe("low");
  });

  it("falls back to low on an unknown stored value", () => {
    localStorage.setItem("ichat.thinkingLevel", "turbo");
    expect(thinkingLevelStore.read()).toBe("low");
  });
});

describe("clampThinkingLevel", () => {
  it("keeps a level the model offers", () => {
    expect(clampThinkingLevel("max", ["low", "high", "max"])).toBe("max");
  });

  it("snaps an unavailable level to high when offered", () => {
    expect(clampThinkingLevel("medium", ["high", "max"])).toBe("high");
    expect(clampThinkingLevel("low", ["high", "max"])).toBe("high");
  });

  it("keeps the level when the allowed list is empty", () => {
    expect(clampThinkingLevel("medium", [])).toBe("medium");
  });
});

describe("toRunOptions", () => {
  it("always enables thinking with the selected effort", () => {
    expect(toRunOptions("low")).toEqual({
      thinking_enabled: true,
      reasoning_effort: "low",
    });
    expect(toRunOptions("max")).toEqual({
      thinking_enabled: true,
      reasoning_effort: "max",
    });
  });

  it("includes web search and model when provided", () => {
    expect(toRunOptions("high", true, "openai/gpt-5.6-luna")).toEqual({
      thinking_enabled: true,
      reasoning_effort: "high",
      web_search_enabled: true,
      model: "openai/gpt-5.6-luna",
    });
  });
});

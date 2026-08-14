import { beforeEach, describe, expect, it } from "vitest";

import { modelPreferenceStore } from "./modelPreference";
import type { ChatModelCapability } from "../api/types";

const MODELS: ChatModelCapability[] = [
  {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    label: "deepseek-v4-flash",
    thinking_levels: ["low", "high", "max"],
    default: true,
    supports_image_input: false,
  },
  {
    id: "openai/gpt-5.6-luna",
    provider: "openai",
    label: "gpt-5.6-luna",
    thinking_levels: ["low", "medium", "high", "xhigh", "max"],
    default: false,
    supports_image_input: true,
  },
];

describe("modelPreferenceStore", () => {
  beforeEach(() => {
    localStorage.clear();
    modelPreferenceStore.setAvailable([]);
  });

  it("resolves to null when capabilities have not loaded", () => {
    expect(modelPreferenceStore.resolve()).toBeNull();
    expect(modelPreferenceStore.requestModel()).toBeUndefined();
  });

  it("resolves the saved model while the server still offers it", () => {
    modelPreferenceStore.setAvailable(MODELS);
    modelPreferenceStore.save("openai/gpt-5.6-luna");

    expect(modelPreferenceStore.resolve()?.id).toBe("openai/gpt-5.6-luna");
    expect(modelPreferenceStore.requestModel()).toBe("openai/gpt-5.6-luna");
  });

  it("falls back to the catalog default when the saved model disappears", () => {
    modelPreferenceStore.setAvailable(MODELS);
    modelPreferenceStore.save("gpt-legacy");

    expect(modelPreferenceStore.resolve()?.id).toBe("deepseek-v4-flash");
  });

  it("persists the selection across reads", () => {
    modelPreferenceStore.save("openai/gpt-5.6-luna");

    expect(modelPreferenceStore.read()).toBe("openai/gpt-5.6-luna");
  });

  it("prefers the recommended compatible model for a vision context", () => {
    modelPreferenceStore.setAvailable(MODELS);
    modelPreferenceStore.save("deepseek-v4-flash");

    expect(
      modelPreferenceStore.resolveForImageContext({
        state: "vision_required",
        legacy_message_id: null,
        recommended_model: "openai/gpt-5.6-luna",
      })?.id,
    ).toBe("openai/gpt-5.6-luna");
  });

  it("falls back to the first compatible model when no vision model is available", () => {
    modelPreferenceStore.setAvailable([MODELS[0]]);
    expect(
      modelPreferenceStore.resolveForImageContext({ state: "vision_required", legacy_message_id: null }),
    ).toBeNull();
  });
});

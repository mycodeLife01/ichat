import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { webSearchPreferenceStore } from "./webSearchPreference";

describe("webSearchPreferenceStore", () => {
  beforeEach(() => {
    localStorage.clear();
    webSearchPreferenceStore.setCapability(false);
  });

  afterEach(() => {
    localStorage.clear();
    webSearchPreferenceStore.setCapability(false);
  });

  it("remembers the local preference but only requests search when capability is enabled", () => {
    expect(webSearchPreferenceStore.read()).toBe(false);
    expect(webSearchPreferenceStore.requestEnabled()).toBe(false);

    webSearchPreferenceStore.save(true);
    expect(webSearchPreferenceStore.read()).toBe(true);
    expect(webSearchPreferenceStore.requestEnabled()).toBe(false);

    webSearchPreferenceStore.setCapability(true);
    expect(webSearchPreferenceStore.capabilityEnabled()).toBe(true);
    expect(webSearchPreferenceStore.requestEnabled()).toBe(true);
  });
});

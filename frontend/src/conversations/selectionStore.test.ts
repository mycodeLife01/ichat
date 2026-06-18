import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectionStore } from "./selectionStore";

describe("selectionStore", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("returns null when empty", () => {
    expect(selectionStore.read()).toBeNull();
  });

  it("saves and reads an id", () => {
    selectionStore.save("conv-42");
    expect(selectionStore.read()).toBe("conv-42");
  });

  it("clears the id", () => {
    selectionStore.save("conv-42");
    selectionStore.clear();
    expect(selectionStore.read()).toBeNull();
  });
});

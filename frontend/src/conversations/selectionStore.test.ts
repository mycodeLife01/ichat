import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectionStore } from "./selectionStore";

describe("selectionStore", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("returns null when empty", () => {
    expect(selectionStore.read()).toBeNull();
  });

  it("saves and reads an id", () => {
    selectionStore.save(42);
    expect(selectionStore.read()).toBe(42);
  });

  it("clears the id", () => {
    selectionStore.save(42);
    selectionStore.clear();
    expect(selectionStore.read()).toBeNull();
  });

  it("drops a corrupt value", () => {
    localStorage.setItem("ichat.selectedConversationId", "not-a-number");
    expect(selectionStore.read()).toBeNull();
    expect(localStorage.getItem("ichat.selectedConversationId")).toBeNull();
  });
});

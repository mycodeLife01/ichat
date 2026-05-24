import { describe, expect, it } from "vitest";

import { normalizeApiBaseUrl } from "./env";

describe("normalizeApiBaseUrl", () => {
  it("removes trailing slashes", () => {
    expect(normalizeApiBaseUrl("https://api.feslia.com/api/v1/")).toBe(
      "https://api.feslia.com/api/v1",
    );
  });

  it("throws when the value is empty", () => {
    expect(() => normalizeApiBaseUrl("")).toThrow(
      "VITE_API_BASE_URL is required",
    );
  });
});

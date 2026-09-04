import { describe, expect, it } from "vitest";

import { normalizeApiBaseUrl, resolveApiBaseUrl } from "./env";

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

describe("resolveApiBaseUrl", () => {
  it("resolves a root-relative development API against the page origin", () => {
    expect(resolveApiBaseUrl("/api/v1/", "http://192.168.1.10:5173")).toBe(
      "http://192.168.1.10:5173/api/v1",
    );
  });

  it("keeps an absolute production API URL unchanged", () => {
    expect(resolveApiBaseUrl("https://api.feslia.com/api/v1/", "http://localhost:5173")).toBe(
      "https://api.feslia.com/api/v1",
    );
  });
});

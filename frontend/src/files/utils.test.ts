import { describe, expect, it } from "vitest";

import { categoryForFileName, categoryLimit, warningLabel } from "./utils";

describe("file status labels", () => {
  it("turns parser warning codes into user-facing copy", () => {
    expect(warningLabel("partial_content_not_extracted")).not.toContain("_");
    expect(warningLabel("external_links_not_extracted")).toContain("links");
    expect(warningLabel("animated_image_first_frame_only")).toContain("first frame");
    expect(warningLabel("format_corrected")).not.toContain("_");
  });
});

describe("file categories", () => {
  it("classifies the expanded image, code, and data extensions", () => {
    expect(categoryForFileName("photo.HEIC")).toBe("image");
    expect(categoryForFileName("loop.gif")).toBe("image");
    expect(categoryForFileName("main.rs")).toBe("code");
    expect(categoryForFileName("App.tsx")).toBe("code");
    expect(categoryForFileName("pyproject.toml")).toBe("data");
  });

  it("falls back to the text limit for unlisted and extensionless names", () => {
    const limits = { text: 2, image: 30, pdf: 50, office: 30 };
    expect(categoryForFileName("Makefile")).toBe("text");
    expect(categoryLimit(limits, "Makefile")).toBe(2);
    expect(categoryLimit(limits, "notes.unknownext")).toBe(2);
    expect(categoryLimit(limits, "main.rs")).toBe(2);
    expect(categoryLimit(limits, "photo.heic")).toBe(30);
  });
});

import { describe, expect, it } from "vitest";

import { reasoningPreview } from "./reasoningPreview";

describe("reasoningPreview", () => {
  it("shows the latest complete headline, not the prose after it", () => {
    const content =
      "**Searching for match results**\n\nI need to respond in Chinese...\n\n" +
      "**Searching for live scores**\n\nI need to find targeted searches...";
    expect(reasoningPreview(content)).toBe("Searching for live scores");
  });

  it("picks up a headline glued mid-line to the previous summary part", () => {
    // OpenAI summary parts are concatenated without a separator, so a new
    // headline lands right after the previous part's final punctuation.
    const content =
      "**Solving a logical puzzle**\n\nI need to tackle a tricky puzzle here, " +
      "specific details that I need to dig into." +
      "**Navigating the constraints**\n\nI'm working on figuring out relationships.";
    expect(reasoningPreview(content)).toBe("Navigating the constraints");
  });

  it("holds the previous headline while a new one is still streaming in", () => {
    const content = "**第一步**\n\n分析中...\n\n**第二";
    expect(reasoningPreview(content)).toBe("第一步");
  });

  it("supports # heading style headlines", () => {
    expect(reasoningPreview("## 分析问题\n\n正在拆解")).toBe("分析问题");
  });

  it("does not promote numbered summary sections or their streaming prefixes", () => {
    const content =
      'The question is: "为什么宋朝会灭亡"\n\n' +
      "### 1. **军事体制的根本缺陷**\n\n分析内容。\n\n" +
      "### 2.";

    expect(reasoningPreview(content)).toBe("");
    expect(reasoningPreview("### 1. **军事体制的根本缺陷**")).toBe("");
  });

  it("keeps a dedicated headline above later numbered summary sections", () => {
    const content =
      "**Analyzing the causes**\n\nChecking the context.\n\n" +
      "### 1. **军事体制的根本缺陷**";

    expect(reasoningPreview(content)).toBe("Analyzing the causes");
  });

  it("does not promote summary prose to a headline", () => {
    expect(reasoningPreview("第一行\n\n第二行\n")).toBe("");
    expect(reasoningPreview("- 检查 `edge case`")).toBe("");
  });

  it("returns empty for empty or whitespace content", () => {
    expect(reasoningPreview("")).toBe("");
    expect(reasoningPreview("  \n\n")).toBe("");
  });
});

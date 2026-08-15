import { describe, expect, it } from "vitest";

import { resolveCodeLanguage } from "./codeLanguage";

describe("resolveCodeLanguage", () => {
  it("normalizes JavaScript aliases for the code surface", () => {
    expect(resolveCodeLanguage("language-js")).toEqual({
      label: "JavaScript",
      highlighterLanguage: "javascript",
      showHeader: true,
    });
    expect(resolveCodeLanguage("language-javascript")).toEqual({
      label: "JavaScript",
      highlighterLanguage: "javascript",
      showHeader: true,
    });
  });

  it.each([
    ["language-text", "Plaintext", "plain", false],
    ["language-diff", "Diff", "plain", true],
    ["language-html", "HTML", "markup", true],
    ["language-xml", "XML", "markup", true],
    ["language-css", "CSS", "css", true],
    ["language-jsx", "JSX", "jsx", true],
    ["language-ts", "TypeScript", "typescript", true],
    ["language-tsx", "TSX", "tsx", true],
    ["language-json", "JSON", "json", true],
    ["language-shell", "Bash", "bash", true],
    ["language-py", "Python", "python", true],
    ["language-java", "Java", "java", true],
    ["language-c", "C", "c", true],
    ["language-c++", "C++", "cpp", true],
    ["language-cs", "C#", "csharp", true],
    ["language-golang", "Go", "go", true],
    ["language-rs", "Rust", "rust", true],
    ["language-sql", "SQL", "sql", true],
    ["language-yml", "YAML", "yaml", true],
    ["language-md", "Markdown", "markdown", true],
  ])("normalizes %s to %s", (className, label, highlighterLanguage, showHeader) => {
    expect(resolveCodeLanguage(`extra ${className}`)).toEqual({
      label,
      highlighterLanguage,
      showHeader,
    });
  });

  it("preserves an unknown language label while falling back to plaintext", () => {
    expect(resolveCodeLanguage("language-not-a-language")).toEqual({
      label: "not-a-language",
      highlighterLanguage: "plain",
      showHeader: true,
    });
  });

  it("uses the generic label when a fence has no language", () => {
    expect(resolveCodeLanguage()).toEqual({
      label: "代码",
      highlighterLanguage: "plain",
      showHeader: false,
    });
  });
});

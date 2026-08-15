import { describe, expect, it } from "vitest";

import { resolveCodeLanguage } from "./codeLanguage";

describe("resolveCodeLanguage", () => {
  it("normalizes JavaScript aliases for the code surface", () => {
    expect(resolveCodeLanguage("language-js")).toEqual({
      label: "JavaScript",
      highlighterLanguage: "javascript",
    });
    expect(resolveCodeLanguage("language-javascript")).toEqual({
      label: "JavaScript",
      highlighterLanguage: "javascript",
    });
  });

  it.each([
    ["language-text", "Plaintext", "plain"],
    ["language-html", "HTML", "markup"],
    ["language-xml", "XML", "markup"],
    ["language-css", "CSS", "css"],
    ["language-jsx", "JSX", "jsx"],
    ["language-ts", "TypeScript", "typescript"],
    ["language-tsx", "TSX", "tsx"],
    ["language-json", "JSON", "json"],
    ["language-shell", "Bash", "bash"],
    ["language-py", "Python", "python"],
    ["language-java", "Java", "java"],
    ["language-c", "C", "c"],
    ["language-c++", "C++", "cpp"],
    ["language-cs", "C#", "csharp"],
    ["language-golang", "Go", "go"],
    ["language-rs", "Rust", "rust"],
    ["language-sql", "SQL", "sql"],
    ["language-yml", "YAML", "yaml"],
    ["language-md", "Markdown", "markdown"],
  ])("normalizes %s to %s", (className, label, highlighterLanguage) => {
    expect(resolveCodeLanguage(`extra ${className}`)).toEqual({
      label,
      highlighterLanguage,
    });
  });

  it("preserves an unknown language label while falling back to plaintext", () => {
    expect(resolveCodeLanguage("language-not-a-language")).toEqual({
      label: "not-a-language",
      highlighterLanguage: "plain",
    });
  });

  it("uses the generic label when a fence has no language", () => {
    expect(resolveCodeLanguage()).toEqual({
      label: "代码",
      highlighterLanguage: "plain",
    });
  });
});

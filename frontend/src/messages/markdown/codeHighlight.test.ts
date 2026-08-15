import { describe, expect, it } from "vitest";

import { highlightSource } from "./codeHighlight";

async function chunks(source: string, language: string) {
  return (await highlightSource(source, language)) ?? [];
}

describe("highlightSource", () => {
  it("uses ChatGPT-compatible Python semantic roles", async () => {
    const result = await chunks(
      'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/hello")',
      "python",
    );

    expect(result).toContainEqual({ content: "from", type: "keyword" });
    expect(result).toContainEqual({ content: "fastapi", type: "variable" });
    expect(result).toContainEqual({ content: "FastAPI", type: "variable" });
    expect(result).toContainEqual({ content: "@", type: "tag" });
    expect(result).toContainEqual({ content: ".", type: "keyword" });
    expect(result).toContainEqual({ content: '"/hello"', type: "string" });
  });

  it("distinguishes JavaScript variables from object properties", async () => {
    const result = await chunks(
      'const response = await fetch("/api", { method: "POST", body: JSON.stringify({ message }) });',
      "javascript",
    );

    expect(result).toContainEqual({ content: "response", type: "variable" });
    expect(result).toContainEqual({ content: "fetch", type: "variable" });
    expect(result).toContainEqual({ content: "JSON", type: "variable" });
    expect(result.some((chunk) => chunk.content.includes("method") && chunk.type === null)).toBe(
      true,
    );
    expect(result.some((chunk) => chunk.content.includes("stringify") && chunk.type === null)).toBe(
      true,
    );
  });

  it("keeps JSON and YAML keys neutral", async () => {
    const json = await chunks('{"status": "ready", "count": 2}', "json");
    const yaml = await chunks('services:\n  image: "postgres:17"', "yaml");

    expect(json.some((chunk) => chunk.content.includes('"status":') && chunk.type === null)).toBe(
      true,
    );
    expect(json).toContainEqual({ content: '"ready"', type: "string" });
    expect(json).toContainEqual({ content: "2", type: "number" });
    expect(yaml.some((chunk) => chunk.content.includes("services:") && chunk.type === null)).toBe(
      true,
    );
    expect(yaml).toContainEqual({ content: '"postgres:17"', type: "string" });
  });

  it("matches Bash flag and subcommand colors", async () => {
    const result = await chunks(
      "docker compose -f compose.yml up -d --build\ndocker compose ps",
      "bash",
    );

    expect(result).toContainEqual({ content: "-f", type: "attribute" });
    expect(result).toContainEqual({ content: "-d", type: "attribute" });
    expect(result).toContainEqual({ content: "--build", type: "attribute" });
    expect(result).toContainEqual({ content: "ps", type: "number" });
  });

  it("uses keyword coloring for SQL functions and operators", async () => {
    const result = await chunks(
      "SELECT COUNT(m.id) AS total FROM messages WHERE id = 20;",
      "sql",
    );

    for (const content of ["SELECT", "COUNT", "AS", "FROM", "WHERE", "="]) {
      expect(result).toContainEqual({ content, type: "keyword" });
    }
    expect(result.some((chunk) => chunk.content.includes("m.id") && chunk.type === null)).toBe(
      true,
    );
    expect(result).toContainEqual({ content: "20", type: "number" });
  });

  it("matches HTML tag, attribute, equals, and string roles", async () => {
    const result = await chunks('<div class="message">Hi</div>', "markup");

    expect(result).toContainEqual({ content: "<div", type: "tag" });
    expect(result).toContainEqual({ content: "class", type: "attribute" });
    expect(result).toContainEqual({ content: "=", type: "keyword" });
    expect(result).toContainEqual({ content: '"message"', type: "string" });
    expect(result).toContainEqual({ content: "</div>", type: "tag" });
  });

  it("matches CSS selector, property, value, unit, and tag roles", async () => {
    const result = await chunks(
      ".message-content { max-width: 48rem; overflow-wrap: anywhere; } .message-content pre { overflow-x: auto; }",
      "css",
    );

    expect(result).toContainEqual({ content: "message-content", type: "number" });
    expect(result.some((chunk) => chunk.content.includes("max-width:") && chunk.type === null)).toBe(
      true,
    );
    expect(result).toContainEqual({ content: "48", type: "number" });
    expect(result).toContainEqual({ content: "rem", type: "keyword" });
    expect(result).toContainEqual({ content: "anywhere", type: "number" });
    expect(result).toContainEqual({ content: "pre", type: "tag" });
    expect(result).toContainEqual({ content: "auto", type: "number" });
  });

  it("keeps plain and diff source unhighlighted", async () => {
    await expect(highlightSource("plain", "plain")).resolves.toBeNull();
  });
});

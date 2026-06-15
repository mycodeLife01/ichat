import { describe, expect, it } from "vitest";

import { rehypeCitations } from "./citations";

// Minimal hast node shape for assertions in these tests.
type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

// Minimal hast builders mirroring what rehype passes to the transformer.
function text(value: string): Node {
  return { type: "text", value };
}
function el(tagName: string, children: Node[]): Node {
  return { type: "element", tagName, properties: {}, children };
}
function run(tree: Node, ids: number[]): void {
  // The plugin factory returns a unified attacher; call it to get the
  // transformer, then apply it to the tree (mutates in place).
  const transformer = rehypeCitations(new Set(ids))();
  transformer(tree as never);
}
function kids(node: Node): Node[] {
  return node.children ?? [];
}

describe("rehypeCitations", () => {
  it("replaces a single in-range marker with a citation element", () => {
    const tree = el("root", [el("p", [text("看这里[1]结束")])]);
    run(tree, [1]);
    const p = kids(kids(tree)[0]);
    expect(p.map((n) => n.type)).toEqual(["text", "element", "text"]);
    expect(p[1].tagName).toBe("citation");
    expect(p[1].properties?.citeIds).toBe("1");
    expect(p[0].value).toBe("看这里");
    expect(p[2].value).toBe("结束");
  });

  it("merges a consecutive run into one citation with all ids", () => {
    const tree = el("root", [el("p", [text("事实[1][2] [3]。")])]);
    run(tree, [1, 2, 3]);
    const p = kids(kids(tree)[0]);
    const cite = p.find((n) => n.tagName === "citation");
    expect(cite?.properties?.citeIds).toBe("1,2,3");
  });

  it("leaves out-of-range markers as plain text", () => {
    const tree = el("root", [el("p", [text("无来源[9]")])]);
    run(tree, [1, 2]);
    const p = kids(kids(tree)[0]);
    expect(p).toHaveLength(1);
    expect(p[0].type).toBe("text");
    expect(p[0].value).toBe("无来源[9]");
  });

  it("filters out-of-range ids within a mixed run", () => {
    const tree = el("root", [el("p", [text("混合[1][9]")])]);
    run(tree, [1]);
    const p = kids(kids(tree)[0]);
    const cite = p.find((n) => n.tagName === "citation");
    expect(cite?.properties?.citeIds).toBe("1");
  });

  it("moves a trailing sentence-ending punctuation in front of the chip", () => {
    const tree = el("root", [el("p", [text("结论[1]。继续")])]);
    run(tree, [1]);
    const p = kids(kids(tree)[0]);
    expect(p.map((n) => n.type)).toEqual(["text", "element", "text"]);
    expect(p[0].value).toBe("结论。");
    expect(p[1].tagName).toBe("citation");
    expect(p[2].value).toBe("继续");
  });

  it("does not rewrite markers inside code/pre", () => {
    const tree = el("root", [el("pre", [el("code", [text("arr[1]")])])]);
    run(tree, [1]);
    const codeText = kids(kids(kids(tree)[0])[0])[0];
    expect(codeText.type).toBe("text");
    expect(codeText.value).toBe("arr[1]");
  });
});

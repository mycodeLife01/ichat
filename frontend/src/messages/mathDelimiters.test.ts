import { describe, expect, it } from "vitest";

import { clampStreamingMath, normalizeMathDelimiters } from "./mathDelimiters";

describe("normalizeMathDelimiters", () => {
  it("reflows an own-line $$ block into a proper flow block (centered display)", () => {
    const md = "可得\n\n$$\nA = B\n$$\n\n后续";
    expect(normalizeMathDelimiters(md)).toContain("$$\nA = B\n$$");
  });

  it("reflows asymmetric fences (own-line opener, inline closer) into a flow block", () => {
    const md = "可得\n\n$$\n\\begin{cases} a \\end{cases}$$ 直观看";
    const out = normalizeMathDelimiters(md);
    expect(out).toContain("$$\n\\begin{cases} a \\end{cases}\n$$");
    // trailing prose is pushed past the closing fence, not swallowed into math
    expect(out).toContain("直观看");
  });

  it("keeps a sentence that starts with inline $$…$$ inline (no blockify)", () => {
    const md = "$$f$$ 是奇函数";
    expect(normalizeMathDelimiters(md)).toBe("$$f$$ 是奇函数");
  });

  it("leaves newlines outside math untouched", () => {
    const md = "第一行\n第二行 $$x$$ 末尾";
    expect(normalizeMathDelimiters(md)).toBe(md);
  });

  it("does not touch $$ inside code fences", () => {
    const md = "```\n$$\nnot math\n$$\n```";
    expect(normalizeMathDelimiters(md)).toBe(md);
  });

  it("still converts \\[ … \\] display math", () => {
    expect(normalizeMathDelimiters("块级 \\[x\\] 完")).toContain("$$x$$");
  });
});

describe("clampStreamingMath", () => {
  it("drops a dangling unclosed $$ (odd count)", () => {
    expect(clampStreamingMath("由 $$f$$ 现在 $$D(x)=(0,")).toBe("由 $$f$$ 现在 ");
  });

  it("leaves balanced math untouched", () => {
    const md = "由 $$f$$ 在 $$(0,1)$$ 上";
    expect(clampStreamingMath(md)).toBe(md);
  });

  it("ignores $$ inside code fences", () => {
    const md = "```sh\necho $$\n```\n后 $$x$$ 完";
    expect(clampStreamingMath(md)).toBe(md);
  });
});

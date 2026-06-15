// Rehype plugin that turns inline citation markers (`[1]`, `[2][3]`, ...) in the
// rendered body into `<citation>` element nodes the Markdown renderer maps to a
// React component. Runs AFTER rehype-sanitize so the injected custom element and
// its `citeIds` property survive sanitization.
//
// Minimal hast shapes are declared locally on purpose: `hast` is only a
// transitive dependency here, and pnpm's strict node_modules forbids importing
// it directly.

type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};
type HastParent = { type: string; tagName?: string; children: HastNode[] };
type HastNode = HastText | HastElement | { type: string; value?: string };

function hasChildren(node: HastNode): node is HastParent & HastNode {
  return Array.isArray((node as { children?: unknown }).children);
}

// A run of `[n]` markers separated only by whitespace, e.g. `[1]` or `[2] [3]`.
const RUN = /\[\d+\](?:\s*\[\d+\])*/g;
const NUM = /\[(\d+)\]/g;
// Sentence-ending punctuation pulled in front of the chip so it reads as
// "…sentence。[chip]" rather than "…sentence[chip]。".
const SENTENCE_END = new Set(["。", ".", "！", "!", "？", "?"]);

// Split one text value into a sequence of text / citation nodes. Marker runs
// whose numbers are all out of range are left untouched (as plain text).
function splitText(value: string, validIds: Set<number>): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  const run = new RegExp(RUN);
  let match: RegExpExecArray | null;
  while ((match = run.exec(value)) !== null) {
    const ids: number[] = [];
    const num = new RegExp(NUM);
    let nm: RegExpExecArray | null;
    while ((nm = num.exec(match[0])) !== null) {
      const n = Number(nm[1]);
      if (validIds.has(n) && !ids.includes(n)) ids.push(n);
    }
    if (ids.length === 0) continue; // unresolved marker — keep as plain text
    // Pull any sentence-ending punctuation directly after the run in front of
    // the chip (内容[1]。 → 内容。[chip]).
    let end = match.index + match[0].length;
    let trailing = "";
    while (end < value.length && SENTENCE_END.has(value[end])) {
      trailing += value[end];
      end += 1;
    }
    const before = value.slice(last, match.index) + trailing;
    if (before) out.push({ type: "text", value: before });
    out.push({
      type: "element",
      tagName: "citation",
      properties: { citeIds: ids.join(",") },
      children: [],
    });
    last = end;
  }
  if (out.length === 0) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

// True when a hast element is (or wraps) rendered KaTeX / unrendered math, so
// its subtree must be left untouched — KaTeX's MathML annotation embeds the raw
// LaTeX, which can contain `[n]`-like brackets (matrices, intervals).
function isMathElement(node: HastElement): boolean {
  const cn = node.properties?.className;
  const classes = Array.isArray(cn) ? cn : typeof cn === "string" ? cn.split(/\s+/) : [];
  return classes.some(
    (c) => typeof c === "string" && (c.startsWith("katex") || c.startsWith("math-")),
  );
}

function transform(parent: HastParent, inCode: boolean, validIds: Set<number>): void {
  const next: HastNode[] = [];
  for (const child of parent.children) {
    if (child.type === "text" && !inCode) {
      next.push(...splitText((child as HastText).value, validIds));
      continue;
    }
    if (hasChildren(child)) {
      const el = child as HastElement;
      const skip = inCode || el.tagName === "code" || el.tagName === "pre" || isMathElement(el);
      transform(child, skip, validIds);
    }
    next.push(child);
  }
  parent.children = next;
}

// Factory: bind the valid source ids, return a unified-compatible plugin.
export function rehypeCitations(validIds: Set<number>) {
  return function plugin() {
    return function (tree: HastParent) {
      transform(tree, false, validIds);
    };
  };
}

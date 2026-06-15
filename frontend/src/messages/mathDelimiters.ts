// Normalizes the backslash math delimiters DeepSeek emits — `\(…\)` (inline) and
// `\[…\]` (display) — into the dollar forms remark-math parses (`$$…$$`).
//
// This MUST run on the raw markdown string, before remark parses it: micromark
// treats `\(` / `\[` as character escapes and drops the backslash, so by the
// time math reaches the mdast tree the delimiter is gone. There is no reliable
// signal left to a tree plugin (a bare `(x)` is indistinguishable from prose).
//
// Both forms map to `$$…$$` rather than single `$`: remark-math runs with
// `singleDollarTextMath: false`, so `$$…$$` is the only dollar form it parses —
// which keeps prose like "$5 到 $10" from being misread as a formula. Whether
// `$$…$$` renders inline or as a block is decided by remark-math from the
// surrounding context, so inline `\(…\)` stays inline and `\[…\]` is pushed onto
// its own line with blank lines.

// A fenced code block (``` or ~~~) or an inline code span. Used to split the
// source so math rewriting skips code — a sample that literally shows `\(x\)`
// must survive verbatim.
const CODE_REGION = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*?`+)/g;

function rewrite(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n\n$$${body.trim()}$$\n\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$$${body.trim()}$$`);
}

export function normalizeMathDelimiters(markdown: string): string {
  // String.split with a capturing group interleaves the delimiters: even
  // indices are non-code text, odd indices are the code regions to leave alone.
  return markdown
    .split(CODE_REGION)
    .map((part, i) => (i % 2 === 1 ? part : rewrite(part)))
    .join("");
}

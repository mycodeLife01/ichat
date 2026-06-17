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

// Reflow each `$$…$$` region into the form micromark renders correctly.
//
// DeepSeek is inconsistent about display-math layout: it may put the opening
// `$$` on its own line (a "math flow" opener) but the closing `$$` inline after
// the content (e.g. `\end{cases}$$`). micromark only closes a flow block on a
// line that itself starts with `$$`, so the inline closer is missed and the
// block swallows the rest of the message into one expression that KaTeX renders
// as a red error.
//
// For each balanced `$$…$$`:
//   • Block intent — opener at the start of a line *and* immediately followed by
//     a newline — is re-emitted with both fences on their own lines
//     (`$$\n…\n$$`), which micromark renders as a centered `.katex-display`
//     block. Any text the model wrote after the inline closer is pushed onto a
//     new paragraph.
//   • Otherwise the math is inline; its internal newlines are folded to spaces
//     so an inline `$$…$$` can never spill into a flow block.
// An unterminated region (the half-written formula at a streaming tail) is left
// verbatim for clampStreamingMath to drop.
const BLOCK_OPENER_TAIL = /^[ \t]*\r?\n/; // content begins on the next line
const FOLD_NEWLINES = /[ \t]*\r?\n[ \t]*/g;

function reflowMathRegions(text: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = text.indexOf("$$", i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = text.indexOf("$$", open + 2);
    if (close === -1) {
      out += text.slice(open); // unterminated — leave for the streaming clamp
      break;
    }
    const raw = text.slice(open + 2, close);
    const body = raw.replace(FOLD_NEWLINES, " ").trim();
    const lineLeading = /(?:^|\n)[ \t]*$/.test(out);
    if (lineLeading && BLOCK_OPENER_TAIL.test(raw)) {
      if (out !== "" && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
      out += `$$\n${body}\n$$\n\n`;
    } else {
      out += `$$${body}$$`;
    }
    i = close + 2;
  }
  return out;
}

export function normalizeMathDelimiters(markdown: string): string {
  // String.split with a capturing group interleaves the delimiters: even
  // indices are non-code text, odd indices are the code regions to leave alone.
  return markdown
    .split(CODE_REGION)
    .map((part, i) => (i % 2 === 1 ? part : reflowMathRegions(rewrite(part))))
    .join("");
}

// Streaming guard: while a reply streams in, the closing `$$` of the formula
// being typed hasn't arrived yet, leaving an odd number of `$$`. micromark shows
// that dangling opener (and its half-written LaTeX) as literal `$$…` text. Drop
// it from the last `$$` so the in-progress formula simply isn't shown until its
// closer streams in. Runs only while streaming — the final render is untouched.
// Operates on the already normalized string, where every `$$…$$` is single-line.
export function clampStreamingMath(markdown: string): string {
  const parts = markdown.split(CODE_REGION);
  let count = 0;
  for (let i = 0; i < parts.length; i += 2) count += parts[i].match(/\$\$/g)?.length ?? 0;
  if (count % 2 === 0) return markdown;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (i % 2 === 1) continue; // code region — leave alone
    const idx = parts[i].lastIndexOf("$$");
    if (idx === -1) continue;
    parts[i] = parts[i].slice(0, idx);
    return parts.slice(0, i + 1).join("");
  }
  return markdown;
}

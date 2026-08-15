const RICH_BLOCK = [
  "## Performance section",
  "",
  "这是一段确定性的长回复正文，包含中文、English prose、数字 123456 与 **强调内容**。",
  "为了产生稳定的换行和解析成本，本段重复使用固定文本，不读取网络、时间或随机数。引用来源[1]。",
  "",
  "```typescript",
  "type RenderSample = { section: number; stable: boolean };",
  "const sample: RenderSample = { section: 1, stable: true };",
  'const stable_long_identifier_abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789 = "render";',
  "```",
  "",
  "| Surface | State | Notes |",
  "| --- | --- | --- |",
  "| Paragraph | complete | 中英文 mixed content |",
  "| Code | highlighted | deterministic_source_abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789 |",
  "| Table | scrollable | stable columns |",
  "",
  "\\[",
  "x^2 + y^2 = z^2",
  "\\]",
  "",
  "> 固定引用段落用于覆盖 blockquote，同时保留前后已闭合 rich blocks。",
  "",
  "- 第一项",
  "  - 嵌套项",
  "1. 有序项",
  "",
].join("\n");

const PADDING_SEED =
  "稳定填充文本 keeps deterministic Markdown length and browser layout predictable. ";

function repeatToLength(seed: string, targetLength: number) {
  if (targetLength <= 0) return "";
  return seed.repeat(Math.ceil(targetLength / seed.length)).slice(0, targetLength);
}

export function createLongMarkdownFixture(targetLength: number) {
  if (targetLength < RICH_BLOCK.length) {
    throw new RangeError(`Target length must be at least ${RICH_BLOCK.length}`);
  }

  let document = "";
  while (document.length + (document === "" ? 0 : 2) + RICH_BLOCK.length <= targetLength) {
    document += `${document === "" ? "" : "\n\n"}${RICH_BLOCK}`;
  }

  const remaining = targetLength - document.length;
  if (remaining === 1) return `${document}稳`;
  if (remaining > 1) {
    document += `\n\n${repeatToLength(PADDING_SEED, remaining - 2)}`;
  }
  return document;
}

const SANITIZED_TRACE_TEXT = repeatToLength(
  "清晨的光线穿过窗边，固定的脱敏文本随着累计 delta 逐字抵达。The renderer keeps completed prose visible while the next phrase is still streaming. ",
  174,
);

function cumulativePrefixes(finalText: string, deltaCount: number) {
  return Array.from({ length: deltaCount }, (_, index) =>
    finalText.slice(0, Math.ceil(((index + 1) * finalText.length) / deltaCount)),
  );
}

// The shape comes from the repository's documented real DeepSeek smoke run.
// Private response text is replaced; only the observed event count and final
// cumulative length are retained.
export const sanitizedRealDeltaTrace = {
  source: "docs/handover/2026-05-17-deepseek-smoke.md (run 1487)",
  sourceRunId: 1487,
  observedDeltaCount: 128,
  observedFinalLength: 174,
  finalText: SANITIZED_TRACE_TEXT,
  prefixes: cumulativePrefixes(SANITIZED_TRACE_TEXT, 128),
} as const;

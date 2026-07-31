// Derives the single-line rolling preview shown in the thinking header while
// reasoning streams. OpenAI summaries arrive as `**Headline**` sections
// followed by prose — the headline is the rolling status, so the latest
// complete headline wins. Summary parts are concatenated without a
// separator, so a new headline usually lands mid-line, glued to the previous
// part's final punctuation; the bold run still ends its line because the
// `\n\n` after it belongs to the same delta. Reasoning without headlines
// (DeepSeek's raw chain of thought) falls back to the latest non-empty line.
// An unfinished headline (`**Search` still streaming in) matches neither, so
// the label holds the previous value until the new headline closes.
const HASH_HEADLINE = /^#{1,6}\s+(.+?)\s*$/;
// Bold run closing the line, anchored to line start or a sentence-ending
// punctuation mark — mid-sentence emphasis stays excluded.
const BOLD_HEADLINE = /(?:^|[.!?:;。！？：；…])\s*\*\*([^*\n]+?)\*\*\s*$/;

export function reasoningPreview(content: string): string {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const headline = HASH_HEADLINE.exec(line) ?? BOLD_HEADLINE.exec(line);
    if (headline) return headline[1].trim();
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
      .replace(/\*\*|__|`/g, "")
      .replace(/^\s*[-*]\s+/, "")
      .trim();
    if (line) return line;
  }
  return "";
}

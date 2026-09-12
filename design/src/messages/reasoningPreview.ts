// Derives an explicit single-line headline for the thinking header while a
// reasoning summary streams. OpenAI summaries arrive as `**Headline**`
// sections followed by prose, so the latest complete headline wins. Summary
// parts are concatenated without a separator, which can glue a new headline
// to the previous sentence. Titleless summaries must return an empty preview
// so ordinary prose is not promoted into the header; the caller then uses the
// generic streaming status. An unfinished headline (`**Search` still
// streaming in) also keeps the previous complete headline.
const HASH_HEADLINE = /^#{1,6}\s+(.+?)\s*$/;
// Bold run closing the line, anchored to line start or a sentence-ending
// punctuation mark — mid-sentence emphasis stays excluded.
const BOLD_HEADLINE = /(?:^|[.!?:;。！？：；…])\s*\*\*([^*\n]+?)\*\*\s*$/;
// Numbered Markdown sections are summary body structure, not rolling status
// headlines. This also covers incomplete streamed prefixes such as `### 2.`
// and bold variants such as `### 1. **Military constraints**`.
const NUMBERED_SECTION = /^(?:#{1,6}\s+)?(?:\*\*)?\d+(?:\.\d+)*(?:[.)、．:：-])?(?:\s|$)/;

export function reasoningPreview(content: string): string {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (NUMBERED_SECTION.test(line)) continue;
    const headline = HASH_HEADLINE.exec(line) ?? BOLD_HEADLINE.exec(line);
    if (headline) return headline[1].trim();
  }
  return "";
}

/** Canonical visible text plus UTF-16 DOM points; excludes non-searchable controls. */
export type TextPoint = { node: Text; offset: number };
export type SearchText = {
  text: string;
  starts: (TextPoint | null)[];
  ends: (TextPoint | null)[];
};
const blocks = new Set([
  "P",
  "DIV",
  "PRE",
  "BLOCKQUOTE",
  "LI",
  "UL",
  "OL",
  "TABLE",
  "TR",
  "TD",
  "TH",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
]);
const excluded =
  "[data-reply-quote-exclude],.code-block-header,.katex,.katex-display,.citation-wrap,citation,img,svg,input,button,iframe,[aria-hidden=true]";

export function buildVisibleSearchText(root: HTMLElement): SearchText {
  const output: SearchText = { text: "", starts: [], ends: [] };
  const append = (
    char: string,
    start: TextPoint | null,
    end: TextPoint | null,
  ) => {
    if (/\s/.test(char)) {
      if (!output.text || output.text.endsWith(" ")) {
        if (output.text.endsWith(" ") && end)
          output.ends[output.ends.length - 1] = end;
        return;
      }
      char = " ";
    }
    output.text += char;
    for (let i = 0; i < char.length; i++) {
      output.starts.push(
        start ? { node: start.node, offset: start.offset + i } : null,
      );
      output.ends.push(
        end
          ? { node: end.node, offset: end.offset - char.length + i + 1 }
          : null,
      );
    }
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      let offset = 0;
      for (const char of text.data) {
        append(
          char,
          { node: text, offset },
          { node: text, offset: offset + char.length },
        );
        offset += char.length;
      }
    } else if (node instanceof HTMLElement) {
      if (node.matches(excluded)) {
        append(" ", null, null);
        return;
      }
      const block = blocks.has(node.tagName) && node !== root;
      if (block || node.tagName === "BR") append(" ", null, null);
      node.childNodes.forEach(walk);
      if (block) append(" ", null, null);
    }
  };
  walk(root);
  if (output.text.endsWith(" ")) {
    output.text = output.text.slice(0, -1);
    output.starts.pop();
    output.ends.pop();
  }
  return output;
}

export async function searchTextHash(text: string): Promise<string> {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`conversation-search:1\n${text}`),
  );
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function rangeForMatch(
  projection: SearchText,
  start: number,
  end: number,
): Range | null {
  const from = projection.starts[start];
  const to = projection.ends[end - 1];
  if (!from || !to || end <= start) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

type SourcePoint = {
  offset?: number;
};

type SourcePosition = {
  start?: SourcePoint;
  end?: SourcePoint;
};

type HastNode = {
  type?: string;
  tagName?: string;
  position?: SourcePosition;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const ANCHORED_TAGS = new Set([
  "a",
  "blockquote",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "pre",
  "strong",
  "table",
  "td",
  "th",
]);

function addAnchors(node: HastNode): void {
  if (node.type === "element" && node.tagName && ANCHORED_TAGS.has(node.tagName)) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start !== undefined &&
      end !== undefined &&
      start >= 0 &&
      end > start
    ) {
      node.properties ??= {};
      node.properties["data-reply-quote-start"] = start;
      node.properties["data-reply-quote-end"] = end;
    }
  }

  for (const child of node.children ?? []) addAnchors(child);
}

/** Project stable Markdown source positions onto selectable final-render DOM. */
export function rehypeReplyQuoteAnchors() {
  return (tree: HastNode) => addAnchors(tree);
}

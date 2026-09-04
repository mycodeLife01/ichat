export type MarkdownNode = {
  properties?: Record<string, unknown>;
};

type AnchorProps = {
  "data-reply-quote-start"?: number | string;
  "data-reply-quote-end"?: number | string;
};

function anchorValue(value: unknown): number | string | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

/** Keep only the two trusted attributes added by our final Markdown pipeline. */
export function replyQuoteAnchorProps(
  node: MarkdownNode | undefined,
  componentProps: Record<string, unknown>,
): AnchorProps {
  const start = anchorValue(
    componentProps["data-reply-quote-start"] ??
      node?.properties?.["data-reply-quote-start"] ??
      node?.properties?.dataReplyQuoteStart,
  );
  const end = anchorValue(
    componentProps["data-reply-quote-end"] ??
      node?.properties?.["data-reply-quote-end"] ??
      node?.properties?.dataReplyQuoteEnd,
  );
  return start === undefined || end === undefined
    ? {}
    : { "data-reply-quote-start": start, "data-reply-quote-end": end };
}

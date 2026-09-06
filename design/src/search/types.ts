export type SearchRange = { start: number; end: number };
export type SearchTarget = SearchRange & {
  message_id: string;
  field: "body" | "reply_quote";
  projection_version: number;
  projection_hash: string;
};
export type SearchItem = {
  conversation_id: string;
  title: string | null;
  updated_at: string;
  title_match: SearchRange | null;
  snippet: {
    text: string;
    match: SearchRange;
    truncated_before: boolean;
    truncated_after: boolean;
  } | null;
  target: SearchTarget | null;
};
export type SearchPage = { items: SearchItem[]; next_cursor: string | null };

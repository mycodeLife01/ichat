import type { ReplyQuoteDraft } from "../api/types";

const DRAFT_KEY_PREFIX = "ichat.reply-quote-draft.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function key(userId: number | string, conversationId: string): string {
  return `${DRAFT_KEY_PREFIX}:${userId}:${conversationId}`;
}

function validAnchor(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  const anchor = value as { version?: unknown; start?: unknown; end?: unknown };
  return (
    anchor.version === 1 &&
    Number.isSafeInteger(anchor.start) &&
    Number.isSafeInteger(anchor.end) &&
    Number(anchor.start) >= 0 &&
    Number(anchor.end) > Number(anchor.start)
  );
}

function valid(value: unknown): value is ReplyQuoteDraft {
  if (typeof value !== "object" || value === null) return false;
  const quote = value as Partial<ReplyQuoteDraft>;
  return (
    typeof quote.source_message_id === "string" &&
    UUID_PATTERN.test(quote.source_message_id) &&
    typeof quote.excerpt === "string" &&
    quote.excerpt.trim().length > 0 &&
    Array.from(quote.excerpt).length <= 4000 &&
    validAnchor(quote.source_anchor)
  );
}

function readableQuote(value: unknown): ReplyQuoteDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const quote = value as Partial<ReplyQuoteDraft>;
  const withoutAnchor = { ...quote, source_anchor: null };
  if (!valid(withoutAnchor)) return null;
  return {
    source_message_id: withoutAnchor.source_message_id,
    excerpt: withoutAnchor.excerpt,
    source_anchor: validAnchor(quote.source_anchor) ? quote.source_anchor ?? null : null,
  };
}

export const replyQuoteDraftStore = {
  read(userId: number | string, conversationId: string | null): ReplyQuoteDraft | null {
    if (conversationId === null) return null;
    const storageKey = key(userId, conversationId);
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      const quote = readableQuote(value);
      if (!quote) throw new Error("Invalid reply quote draft");
      if (!valid(value)) localStorage.setItem(storageKey, JSON.stringify(quote));
      return quote;
    } catch {
      localStorage.removeItem(storageKey);
      return null;
    }
  },
  write(
    userId: number | string,
    conversationId: string | null,
    quote: ReplyQuoteDraft | null,
  ): void {
    if (conversationId === null) return;
    const storageKey = key(userId, conversationId);
    if (quote === null) {
      localStorage.removeItem(storageKey);
      return;
    }
    if (!valid(quote)) {
      localStorage.removeItem(storageKey);
      return;
    }
    localStorage.setItem(storageKey, JSON.stringify(quote));
  },
  clear(userId: number | string, conversationId: string | null): void {
    if (conversationId !== null) localStorage.removeItem(key(userId, conversationId));
  },
  clearAll(): void {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const storageKey = localStorage.key(index);
      if (storageKey?.startsWith(`${DRAFT_KEY_PREFIX}:`)) localStorage.removeItem(storageKey);
    }
  },
  clearOtherUsers(userId: number | string): void {
    const ownPrefix = `${DRAFT_KEY_PREFIX}:${userId}:`;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const storageKey = localStorage.key(index);
      if (
        storageKey?.startsWith(`${DRAFT_KEY_PREFIX}:`) &&
        !storageKey.startsWith(ownPrefix)
      ) {
        localStorage.removeItem(storageKey);
      }
    }
  },
};

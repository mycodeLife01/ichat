import type { DraftAttachment } from "./types";

const DRAFT_KEY_PREFIX = "ichat.file-draft.v1";
const NEW_CONVERSATION_SCOPE = "new";

export type AttachmentDraft = {
  content: string;
  attachments: DraftAttachment[];
};

const emptyDraft = (): AttachmentDraft => ({ content: "", attachments: [] });

function key(userId: number | string, conversationId: string | null): string {
  return `${DRAFT_KEY_PREFIX}:${userId}:${conversationId ?? NEW_CONVERSATION_SCOPE}`;
}

function readRaw(storageKey: string): AttachmentDraft {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return emptyDraft();
  try {
    const value = JSON.parse(raw) as Partial<AttachmentDraft>;
    if (!Array.isArray(value.attachments) || typeof value.content !== "string") {
      throw new Error("Invalid attachment draft");
    }
    return { content: value.content, attachments: value.attachments };
  } catch {
    localStorage.removeItem(storageKey);
    return emptyDraft();
  }
}

export const attachmentDraftStore = {
  read(userId: number | string, conversationId: string | null): AttachmentDraft {
    return readRaw(key(userId, conversationId));
  },
  write(
    userId: number | string,
    conversationId: string | null,
    draft: AttachmentDraft,
  ): void {
    const storageKey = key(userId, conversationId);
    if (draft.content === "" && draft.attachments.length === 0) {
      localStorage.removeItem(storageKey);
      return;
    }
    // Object URLs only exist for the lifetime of the current document. Keeping
    // one in localStorage would restore a broken image after a reload.
    const serializable = {
      ...draft,
      attachments: draft.attachments.map((attachment) => {
        const serializedAttachment = { ...attachment };
        delete serializedAttachment.local_preview_url;
        return serializedAttachment;
      }),
    };
    localStorage.setItem(storageKey, JSON.stringify(serializable));
  },
  clear(userId: number | string, conversationId: string | null): void {
    localStorage.removeItem(key(userId, conversationId));
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

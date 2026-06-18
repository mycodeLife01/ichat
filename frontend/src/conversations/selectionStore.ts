// Bumped from the legacy numeric-id key so stale numeric selections (pre
// public_id) are ignored rather than sent to the API as invalid UUIDs.
const SELECTION_STORAGE_KEY = "ichat.selectedConversationPublicId";

export type SelectionStore = {
  read(): string | null;
  save(id: string): void;
  clear(): void;
};

export const selectionStore: SelectionStore = {
  read() {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    return raw && raw.length > 0 ? raw : null;
  },
  save(id) {
    localStorage.setItem(SELECTION_STORAGE_KEY, id);
  },
  clear() {
    localStorage.removeItem(SELECTION_STORAGE_KEY);
  },
};

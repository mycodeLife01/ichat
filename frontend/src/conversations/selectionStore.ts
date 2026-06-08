const SELECTION_STORAGE_KEY = "ichat.selectedConversationId";

export type SelectionStore = {
  read(): number | null;
  save(id: number): void;
  clear(): void;
};

export const selectionStore: SelectionStore = {
  read() {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      localStorage.removeItem(SELECTION_STORAGE_KEY);
      return null;
    }
    return value;
  },
  save(id) {
    localStorage.setItem(SELECTION_STORAGE_KEY, String(id));
  },
  clear() {
    localStorage.removeItem(SELECTION_STORAGE_KEY);
  },
};

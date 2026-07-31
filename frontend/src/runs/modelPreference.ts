import type { ChatModelCapability } from "../api/types";

// User-selected chat model for runs. The selectable list comes from the
// capabilities endpoint at bootstrap; the persisted choice only wins while it
// is still in that list, otherwise the server's default model applies.
const STORAGE_KEY = "ichat.model";

let availableModels: ChatModelCapability[] = [];

export const modelPreferenceStore = {
  read(): string | null {
    return localStorage.getItem(STORAGE_KEY);
  },
  save(modelId: string): void {
    localStorage.setItem(STORAGE_KEY, modelId);
  },
  setAvailable(models: ChatModelCapability[]): void {
    availableModels = models;
  },
  available(): ChatModelCapability[] {
    return availableModels;
  },
  // The effective selection: the saved model if the server still offers it,
  // else the catalog default, else null (capabilities unavailable).
  resolve(): ChatModelCapability | null {
    const saved = this.read();
    const match = availableModels.find((model) => model.id === saved);
    if (match) return match;
    return availableModels.find((model) => model.default) ?? availableModels[0] ?? null;
  },
  // The `model` run option to send; undefined lets the server pick its default.
  requestModel(): string | undefined {
    return this.resolve()?.id;
  },
};

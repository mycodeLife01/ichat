import type { ChatModelCapability, ImageContext } from "../api/types";

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
  supportsImages(modelId: string | null | undefined): boolean {
    return availableModels.find((model) => model.id === modelId)?.supports_image_input === true;
  },
  resolveForImageContext(context: ImageContext | null | undefined): ChatModelCapability | null {
    if (!context || context.state === "none") return this.resolve();
    const compatible = availableModels.filter((model) =>
      context.state === "vision_required"
        ? model.supports_image_input
        : !model.supports_image_input,
    );
    if (compatible.length === 0) return null;
    if (context.recommended_model) {
      const recommended = compatible.find((model) => model.id === context.recommended_model);
      if (recommended) return recommended;
    }
    const saved = this.read();
    return compatible.find((model) => model.id === saved) ?? compatible[0] ?? null;
  },
};

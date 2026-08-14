import { modelPreferenceStore } from "./modelPreference";
import {
  clampThinkingLevel,
  thinkingLevelStore,
  toRunOptions,
  type RunOptionsRequest,
} from "./thinkingLevel";
import { webSearchPreferenceStore } from "./webSearchPreference";

// The per-request options snapshot, read from the preference stores at call
// time (send / edit-and-regenerate / regenerate all use the same rules). The
// persisted thinking level is clamped onto the selected model's levels here so
// a stale preference never reaches the API.
export function currentRunOptions(modelId?: string): RunOptionsRequest {
  const model =
    modelId === undefined
      ? modelPreferenceStore.resolve()
      : modelPreferenceStore.available().find((entry) => entry.id === modelId) ?? null;
  return toRunOptions(
    clampThinkingLevel(thinkingLevelStore.read(), model?.thinking_levels ?? []),
    webSearchPreferenceStore.requestEnabled(),
    modelId ?? model?.id,
  );
}

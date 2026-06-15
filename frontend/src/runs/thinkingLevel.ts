// User-selected thinking level for runs. "fast" maps to thinking disabled;
// "high" / "max" map to the two DeepSeek reasoning_effort tiers we expose.
export type ThinkingLevel = "fast" | "high" | "max";

export type RunOptionsRequest = {
  thinking_enabled: boolean;
  reasoning_effort?: "high" | "max";
  web_search_enabled?: boolean;
};

const STORAGE_KEY = "ichat.thinkingLevel";

const LEVELS: ThinkingLevel[] = ["fast", "high", "max"];

export function toRunOptions(
  level: ThinkingLevel,
  webSearchEnabled?: boolean,
): RunOptionsRequest {
  const webSearchOption =
    webSearchEnabled === undefined ? {} : { web_search_enabled: webSearchEnabled };
  if (level === "fast") {
    return { thinking_enabled: false, ...webSearchOption };
  }
  return {
    thinking_enabled: true,
    reasoning_effort: level,
    ...webSearchOption,
  };
}

export const thinkingLevelStore = {
  read(): ThinkingLevel {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (LEVELS as string[]).includes(raw)) return raw as ThinkingLevel;
    return "fast";
  },
  save(level: ThinkingLevel): void {
    localStorage.setItem(STORAGE_KEY, level);
  },
};

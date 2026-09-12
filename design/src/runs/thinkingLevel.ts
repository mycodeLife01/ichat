// User-selected thinking level for runs — the neutral effort scale shared with
// the backend. Which levels are selectable depends on the chosen model (the
// capabilities endpoint lists them per model); an out-of-range persisted level
// is clamped before display and before every request.
export type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type RunOptionsRequest = {
  thinking_enabled: boolean;
  reasoning_effort: ThinkingLevel;
  web_search_enabled?: boolean;
  model?: string;
};

const STORAGE_KEY = "ichat.thinkingLevel";

export const THINKING_LEVEL_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: "low", label: "快速" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
  { value: "max", label: "极致" },
];

const LEVELS = THINKING_LEVEL_OPTIONS.map((option) => option.value);

// Pre-rework persisted value: "fast" meant thinking off, which low replaces.
const LEGACY_LEVELS: Record<string, ThinkingLevel> = { fast: "low" };

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return THINKING_LEVEL_OPTIONS.find((option) => option.value === level)?.label ?? "快速";
}

// Snap a level onto a model's selectable list: keep it when offered, otherwise
// prefer "high" (every model offers it) and fall back to the model's first tier.
export function clampThinkingLevel(
  level: ThinkingLevel,
  allowedLevels: string[],
): ThinkingLevel {
  if (allowedLevels.length === 0 || allowedLevels.includes(level)) return level;
  if (allowedLevels.includes("high")) return "high";
  const first = allowedLevels[0];
  return (LEVELS as string[]).includes(first) ? (first as ThinkingLevel) : level;
}

export function toRunOptions(
  level: ThinkingLevel,
  webSearchEnabled?: boolean,
  model?: string,
): RunOptionsRequest {
  const webSearchOption =
    webSearchEnabled === undefined ? {} : { web_search_enabled: webSearchEnabled };
  const modelOption = model === undefined ? {} : { model };
  return {
    thinking_enabled: true,
    reasoning_effort: level,
    ...webSearchOption,
    ...modelOption,
  };
}

export const thinkingLevelStore = {
  read(): ThinkingLevel {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (LEVELS as string[]).includes(raw)) return raw as ThinkingLevel;
    if (raw && raw in LEGACY_LEVELS) return LEGACY_LEVELS[raw];
    return "low";
  },
  save(level: ThinkingLevel): void {
    localStorage.setItem(STORAGE_KEY, level);
  },
};

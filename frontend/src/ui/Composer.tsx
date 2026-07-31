import { useEffect, useRef, useState } from "react";

import type { ChatModelCapability } from "../api/types";
import {
  clampThinkingLevel,
  THINKING_LEVEL_OPTIONS,
  thinkingLevelLabel,
  type ThinkingLevel,
} from "../runs/thinkingLevel";
import {
  composerSurface,
  focusRing,
  neutralMenuItem,
  popoverSurface,
} from "./classes";
import { Icons } from "./icons";

type ComposerState = "idle" | "submitting" | "streaming" | "stopping";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  state: ComposerState;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  webSearchEnabled?: boolean;
  webSearchAvailable?: boolean;
  onWebSearchEnabledChange?: (enabled: boolean) => void;
  models?: ChatModelCapability[];
  model?: string | null;
  onModelChange?: (modelId: string) => void;
};

const MAX_HEIGHT = 240;

// Composer tools share one geometry: a 36px visual target with a 4px
// pseudo-element bleed, so the effective touch target reaches 44×44 CSS px
// without enlarging the visual footprint.
const composerToolTarget =
  "relative h-9 before:absolute before:-inset-1 before:content-['']";

// Labeled pills (web search, model/thinking picker) use the pill role with a
// fixed 1px border, so geometry never shifts between idle and selected.
// Background and border swap as complete class sets per state: Tailwind
// resolves conflicting utilities by stylesheet order, not className order.
// Composer tools deliberately have no press motion (scale/translate) — state
// feedback is background/color only.
const composerPill =
  `${composerToolTarget} inline-flex items-center gap-1.5 rounded-pill border px-2.5 ` +
  `text-[13px] font-medium ${focusRing} ` +
  "transition-[background,color,border-color] duration-[120ms] " +
  "disabled:cursor-not-allowed disabled:opacity-50";
const composerPillIdle =
  "border-transparent bg-transparent text-text-muted hover:bg-hover hover:text-text-primary";
const webSearchPillSelected =
  "border-search-border bg-search-soft text-search-foreground hover:bg-search-soft-hover";

// Send and stop share the primary pill action. State is expressed through the
// icon plus the accessible name; disabled keeps the accent role and only drops
// opacity, with native behavior and a not-allowed cursor.
const composerPrimaryAction =
  `${composerToolTarget} inline-flex w-9 items-center justify-center rounded-pill ` +
  `bg-accent text-accent-foreground ${focusRing} ` +
  "transition-[opacity] duration-[120ms] not-disabled:hover:opacity-90 " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-wait aria-busy:opacity-60";

// The picker popover keeps the root menu (model + thinking rows, mirroring the
// reference two-column menu) visible and flies the tapped row's options out as
// a second panel beside it. The panel prefers the right side (as in the
// reference) and flips left when the viewport has no room. It is anchored to
// the row's bottom edge and grows upward — the root menu already hugs the
// viewport bottom, so growing downward would overflow the page and spawn a
// scrollbar that shifts the whole layout.
type PickerSubmenu = "model" | "level" | null;

// Safety estimate for a flyout's footprint (panel min-width + gap), used to
// pick the side before rendering — measuring after the fact would let the
// panel overflow for a frame and stretch the page.
const FLYOUT_WIDTH_PX = 200;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  state,
  thinkingLevel,
  onThinkingLevelChange,
  webSearchEnabled = false,
  webSearchAvailable = true,
  onWebSearchEnabledChange = () => {},
  models = [],
  model = null,
  onModelChange = () => {},
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<PickerSubmenu>(null);
  const [flyoutSide, setFlyoutSide] = useState<"right" | "left">("right");
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  const send = () => {
    if (!value.trim() || state !== "idle") return;
    onSend();
  };

  const togglePicker = () => {
    setOpenSubmenu(null);
    setPickerOpen((open) => !open);
  };

  const toggleSubmenu = (menu: Exclude<PickerSubmenu, null>) => {
    // The root menu's right edge sits at the picker wrapper's right edge
    // (right-0 anchored), so the space beyond it is what the flyout gets.
    const anchor = pickerRef.current?.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    setFlyoutSide(
      anchor && viewportWidth - anchor.right >= FLYOUT_WIDTH_PX ? "right" : "left",
    );
    setOpenSubmenu((current) => (current === menu ? null : menu));
  };

  const flyoutSideClass =
    flyoutSide === "right" ? "left-[calc(100%+10px)]" : "right-[calc(100%+10px)]";

  const selectedModel = models.find((entry) => entry.id === model) ?? null;
  // With no capabilities loaded every tier stays selectable; a model with no
  // thinking tiers (non-reasoning GPT) hides the thinking row entirely.
  const allowedLevels =
    selectedModel === null
      ? THINKING_LEVEL_OPTIONS.map((option) => option.value as string)
      : selectedModel.thinking_levels;
  const effectiveLevel = clampThinkingLevel(thinkingLevel, allowedLevels);
  const levelOptions = THINKING_LEVEL_OPTIONS.filter((option) =>
    allowedLevels.includes(option.value),
  );
  const levelLabel = thinkingLevelLabel(effectiveLevel);
  const pickerLabel = [
    selectedModel?.label,
    levelOptions.length > 0 ? levelLabel : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="composer-wrap border-t border-transparent bg-canvas px-8 pb-[22px] max-[760px]:px-4 max-[760px]:pb-[max(16px,env(safe-area-inset-bottom))]">
      <div
        className={`composer relative mx-auto flex w-full max-w-[var(--reading-width)] flex-col gap-1 py-2.5 pr-3.5 pl-[18px] ${composerSurface}`}
      >
        {/* Input state contract: only default applies. The field is
            borderless inside an already-bordered surface, so focus is
            conveyed by the caret alone (no ring — a focus outline here would
            box the whole composer); hover/active have no visual change;
            disabled/loading/error/success are not applicable — the input is
            never locked (send gating lives on the send button) and failures
            surface as toasts rather than field styling. Geometry stays
            borderless and fixed at every length. */}
        <textarea
          ref={ref}
          className="m-0 block min-h-[22px] w-full min-w-0 resize-none overflow-y-auto border-none bg-transparent py-2 text-[16px] leading-[1.55] text-text-primary outline-none placeholder:text-text-faint max-[760px]:text-[17px]"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="有问题，尽管问"
          rows={1}
          style={{ maxHeight: `${MAX_HEIGHT}px` }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <div className="flex items-center gap-1">
            <button
              className={`${composerPill} ${
                webSearchEnabled ? webSearchPillSelected : composerPillIdle
              }`}
              type="button"
              aria-pressed={webSearchEnabled}
              disabled={!webSearchAvailable}
              title={!webSearchAvailable ? "联网搜索不可用" : "联网搜索"}
              onClick={() => onWebSearchEnabledChange(!webSearchEnabled)}
            >
              <Icons.Globe size={15} />
              <span>智能搜索</span>
            </button>
          </div>
          <div className="flex items-center gap-1">
            {pickerLabel !== "" && (
              <div className="relative" ref={pickerRef}>
                <button
                  className={`${composerPill} ${composerPillIdle}`}
                  type="button"
                  aria-label="模型与思考强度"
                  aria-haspopup="menu"
                  aria-expanded={pickerOpen}
                  onClick={togglePicker}
                >
                  <span>{pickerLabel}</span>
                  <Icons.Chevron size={14} />
                </button>
                {pickerOpen && (
                  <div
                    role="menu"
                    aria-label="模型与思考强度"
                    className={`absolute right-0 bottom-[calc(100%+6px)] z-10 min-w-[208px] p-1.5 ${popoverSurface}`}
                  >
                    {models.length > 0 && (
                      <div className="relative">
                        <button
                          role="menuitem"
                          aria-haspopup="menu"
                          aria-expanded={openSubmenu === "model"}
                          className={`${neutralMenuItem} justify-between gap-4 max-[760px]:min-h-11`}
                          type="button"
                          onClick={() => toggleSubmenu("model")}
                        >
                          <span>模型</span>
                          <span className="inline-flex items-center gap-1 text-text-muted">
                            <span>{selectedModel?.label ?? ""}</span>
                            <Icons.Chevron size={14} className="-rotate-90" />
                          </span>
                        </button>
                        {openSubmenu === "model" && (
                          <div
                            role="menu"
                            aria-label="模型"
                            className={`absolute bottom-[-6px] ${flyoutSideClass} z-20 min-w-[176px] p-1.5 ${popoverSurface}`}
                          >
                            {models.map((entry) => (
                              <button
                                key={entry.id}
                                role="menuitemradio"
                                aria-checked={entry.id === selectedModel?.id}
                                className={`${neutralMenuItem} justify-between gap-4 max-[760px]:min-h-11`}
                                type="button"
                                onClick={() => {
                                  onModelChange(entry.id);
                                  setPickerOpen(false);
                                }}
                              >
                                <span>{entry.label}</span>
                                {entry.id === selectedModel?.id && (
                                  <Icons.Check size={14} />
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {levelOptions.length > 0 && (
                      <div className="relative">
                        <button
                          role="menuitem"
                          aria-haspopup="menu"
                          aria-expanded={openSubmenu === "level"}
                          className={`${neutralMenuItem} justify-between gap-4 max-[760px]:min-h-11`}
                          type="button"
                          onClick={() => toggleSubmenu("level")}
                        >
                          <span>思考强度</span>
                          <span className="inline-flex items-center gap-1 text-text-muted">
                            <span>{levelLabel}</span>
                            <Icons.Chevron size={14} className="-rotate-90" />
                          </span>
                        </button>
                        {openSubmenu === "level" && (
                          <div
                            role="menu"
                            aria-label="思考强度"
                            className={`absolute bottom-[-6px] ${flyoutSideClass} z-20 min-w-[128px] p-1.5 ${popoverSurface}`}
                          >
                            {levelOptions.map((option) => (
                              <button
                                key={option.value}
                                role="menuitemradio"
                                aria-checked={option.value === effectiveLevel}
                                className={`${neutralMenuItem} justify-between gap-4 max-[760px]:min-h-11`}
                                type="button"
                                onClick={() => {
                                  onThinkingLevelChange(option.value);
                                  setPickerOpen(false);
                                }}
                              >
                                <span>{option.label}</span>
                                {option.value === effectiveLevel && (
                                  <Icons.Check size={14} />
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {state === "idle" ? (
              <button
                className={composerPrimaryAction}
                type="button"
                aria-label="发送"
                disabled={!value.trim()}
                onClick={send}
              >
                <Icons.ArrowUp size={15} />
              </button>
            ) : state === "submitting" ? (
              <button
                className={composerPrimaryAction}
                type="button"
                aria-label="发送中"
                aria-busy="true"
                disabled
              >
                <Icons.Loading className="animate-spin" size={15} aria-hidden="true" />
              </button>
            ) : (
              <button
                className={composerPrimaryAction}
                type="button"
                aria-label={state === "stopping" ? "停止中" : "停止生成"}
                aria-busy={state === "stopping"}
                disabled={state === "stopping"}
                onClick={onStop}
              >
                <Icons.Stop size={11} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

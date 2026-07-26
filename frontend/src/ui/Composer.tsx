import { useEffect, useRef, useState } from "react";

import type { ThinkingLevel } from "../runs/thinkingLevel";
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
};

const MAX_HEIGHT = 240;

const THINKING_LEVEL_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: "fast", label: "快速" },
  { value: "high", label: "高" },
  { value: "max", label: "极致" },
];

// Composer tools share one geometry: a 36px visual target with a 4px
// pseudo-element bleed, so the effective touch target reaches 44×44 CSS px
// without enlarging the visual footprint.
const composerToolTarget =
  "relative h-9 before:absolute before:-inset-1 before:content-['']";

// Labeled pills (web search, thinking level) use the pill role with a fixed
// 1px border, so geometry never shifts between idle and selected. Background
// and border swap as complete class sets per state: Tailwind resolves
// conflicting utilities by stylesheet order, not className order. Composer
// tools deliberately have no press motion (scale/translate) — state feedback
// is background/color only.
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
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [levelMenuOpen, setLevelMenuOpen] = useState(false);
  const levelMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (!levelMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!levelMenuRef.current?.contains(event.target as Node)) {
        setLevelMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLevelMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [levelMenuOpen]);

  const send = () => {
    if (!value.trim() || state !== "idle") return;
    onSend();
  };

  const thinkingLabel =
    THINKING_LEVEL_OPTIONS.find((option) => option.value === thinkingLevel)?.label ?? "快速";

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
            <div className="relative" ref={levelMenuRef}>
              <button
                className={`${composerPill} ${composerPillIdle}`}
                type="button"
                aria-label="智能水平"
                aria-haspopup="menu"
                aria-expanded={levelMenuOpen}
                onClick={() => setLevelMenuOpen((open) => !open)}
              >
                <span>{thinkingLabel}</span>
                <Icons.Chevron size={14} />
              </button>
              {levelMenuOpen && (
                <div
                  role="menu"
                  aria-label="智能水平"
                  className={`absolute right-0 bottom-[calc(100%+6px)] z-10 min-w-[148px] p-1.5 ${popoverSurface}`}
                >
                  <div className="px-3 pt-1.5 pb-1 text-[12px] text-text-faint">智能水平</div>
                  {THINKING_LEVEL_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      role="menuitemradio"
                      aria-checked={option.value === thinkingLevel}
                      className={`${neutralMenuItem} justify-between max-[760px]:min-h-11`}
                      type="button"
                      onClick={() => {
                        onThinkingLevelChange(option.value);
                        setLevelMenuOpen(false);
                      }}
                    >
                      <span>{option.label}</span>
                      {option.value === thinkingLevel && <Icons.Check size={14} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
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

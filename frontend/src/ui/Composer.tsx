import { useEffect, useRef, useState } from "react";

import type { ThinkingLevel } from "../runs/thinkingLevel";
import { Icons } from "./icons";

type ComposerState = "idle" | "streaming" | "stopping";

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
  { value: "fast", label: "Fast" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

// Background/text colors live outside the base string: Tailwind resolves
// conflicting utilities by stylesheet order, not className order, so a toggled
// state must swap classes instead of appending overrides.
const composerToolBase =
  "inline-flex h-8 w-8 items-center justify-center rounded-full p-0 " +
  "transition-[background,color] duration-[120ms] hover:bg-bg-hover hover:text-fg";
const composerTool = `${composerToolBase} bg-transparent text-fg-muted`;

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
    THINKING_LEVEL_OPTIONS.find((option) => option.value === thinkingLevel)?.label ?? "Fast";

  return (
    <div className="composer-wrap border-t border-transparent bg-bg px-8 pb-[22px] max-[760px]:px-4 max-[760px]:pb-[max(16px,env(safe-area-inset-bottom))]">
      <div className="composer relative mx-auto flex w-full max-w-[var(--reading-width)] flex-col gap-1 rounded-[18px] border border-border-strong bg-bg-raised py-2.5 pr-3.5 pl-[18px]">
        <textarea
          ref={ref}
          className="m-0 block min-h-[22px] w-full min-w-0 resize-none overflow-y-auto border-none bg-transparent py-2 text-[16px] leading-[1.55] text-fg outline-none placeholder:text-fg-faint max-[760px]:text-[17px]"
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
            {/* Web search toggle as a labeled pill (replaces the old icon-only
                globe + the "+" attachment button). Enabled state turns blue;
                the theme has no blue token, so these are intentional one-off
                arbitrary values. The globe inherits the button's text color. */}
            <button
              className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-medium transition-[background,color,border-color] duration-[120ms] disabled:cursor-not-allowed disabled:opacity-50 ${
                webSearchEnabled
                  ? "border-[#bcd9f4] bg-[#e9f2fb] text-[#1a73c7] hover:bg-[#e0ecfa]"
                  : "border-border-strong bg-transparent text-fg-muted hover:bg-bg-hover hover:text-fg"
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
                className="inline-flex h-8 items-center gap-1 rounded-full bg-transparent px-2.5 text-[13px] font-medium text-fg-muted transition-[background,color] duration-[120ms] hover:bg-bg-hover hover:text-fg"
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
                  className="absolute right-0 bottom-[calc(100%+6px)] z-10 min-w-[148px] rounded-[10px] border border-border-strong bg-bg-raised p-1 shadow-[0_6px_20px_rgba(20,20,19,0.08)]"
                >
                  <div className="px-2.5 pt-1.5 pb-1 text-[12px] text-fg-faint">智能水平</div>
                  {THINKING_LEVEL_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      role="menuitemradio"
                      aria-checked={option.value === thinkingLevel}
                      className="flex w-full items-center justify-between gap-2 rounded-md bg-transparent px-2.5 py-[7px] text-left text-[13px] text-fg transition-[background] duration-[120ms] hover:bg-bg-hover"
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
            <button className={composerTool} type="button" aria-label="语音输入">
              <Icons.Mic size={16} />
            </button>
            {state === "idle" ? (
              <button
                className="relative inline-flex h-9 w-9 items-center justify-center rounded-[18px] bg-accent p-0 text-[13px] font-medium text-accent-fg transition-[opacity_120ms,transform_60ms,background_120ms] not-disabled:hover:opacity-[0.88] not-disabled:active:translate-y-px disabled:cursor-not-allowed disabled:bg-bg-sunken disabled:text-fg-faint"
                type="button"
                aria-label="发送"
                disabled={!value.trim()}
                onClick={send}
              >
                <Icons.ArrowUp size={15} />
              </button>
            ) : (
              <button
                className="relative inline-flex h-9 w-9 items-center justify-center rounded-[18px] border border-border-strong bg-bg-raised p-0 text-[13px] font-medium text-fg transition-[opacity_120ms,transform_60ms,background_120ms] hover:bg-bg-sunken disabled:cursor-not-allowed disabled:text-fg-muted"
                type="button"
                aria-label={state === "stopping" ? "停止中" : "停止生成"}
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

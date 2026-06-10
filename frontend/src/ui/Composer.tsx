import { useEffect, useRef } from "react";

import { Icons } from "./icons";

type ComposerState = "idle" | "streaming" | "stopping";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  state: ComposerState;
};

const MAX_HEIGHT = 240;

const composerTool =
  "inline-flex h-8 w-8 items-center justify-center rounded-full bg-transparent p-0 text-fg-muted " +
  "transition-[background,color] duration-[120ms] hover:bg-bg-hover hover:text-fg";

export function Composer({ value, onChange, onSend, onStop, state }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const send = () => {
    if (!value.trim() || state !== "idle") return;
    onSend();
  };

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
            <button className={composerTool} type="button" aria-label="添加附件">
              <Icons.Plus size={16} />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button
              className="inline-flex h-8 items-center gap-1 rounded-full bg-transparent px-2.5 text-[13px] font-medium text-fg-muted transition-[background,color] duration-[120ms] hover:bg-bg-hover hover:text-fg"
              type="button"
              aria-label="模型模式"
            >
              <span>Fast</span>
              <Icons.Chevron size={14} />
            </button>
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

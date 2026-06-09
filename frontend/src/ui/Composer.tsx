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
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
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
        <div className="composer-actions">
          <div className="composer-actions-left">
            <button className="composer-tool" type="button" aria-label="添加附件">
              <Icons.Plus size={16} />
            </button>
          </div>
          <div className="composer-actions-right">
            <button className="composer-mode" type="button" aria-label="模型模式">
              <span>Instant</span>
              <Icons.Chevron size={14} />
            </button>
            <button className="composer-tool" type="button" aria-label="语音输入">
              <Icons.Mic size={16} />
            </button>
            {state === "idle" ? (
              <button
                className="send-btn"
                type="button"
                aria-label="发送"
                disabled={!value.trim()}
                onClick={send}
              >
                <Icons.ArrowUp size={15} />
              </button>
            ) : (
              <button
                className="stop-btn"
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

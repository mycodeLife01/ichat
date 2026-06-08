import { useEffect, useRef } from "react";

import { Icons } from "./icons";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
};

const MAX_HEIGHT = 240;

// Send is intentionally disabled this step; SSE submit lands in step 8.
export function Composer({ value, onChange }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

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
            // Keyboard wiring reserved for step 8; Enter must not submit yet.
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
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
            <button className="send-btn" type="button" aria-label="发送" disabled>
              <Icons.ArrowUp size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

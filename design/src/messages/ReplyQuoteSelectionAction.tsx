import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ReplyQuoteSelectionCandidate } from "./useReplyQuoteSelection";

const VIEWPORT_GAP = 4;
const SELECTION_GAP = 4;

export function ReplyQuoteSelectionAction({
  candidate,
  onSelect,
}: {
  candidate: ReplyQuoteSelectionCandidate;
  onSelect: (candidate: ReplyQuoteSelectionCandidate) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ width: 0, height: 36 });

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect?.width && rect.height) setSize({ width: rect.width, height: rect.height });
  }, [candidate]);

  const left = Math.min(
    window.innerWidth - VIEWPORT_GAP - size.width,
    Math.max(VIEWPORT_GAP, candidate.rect.left - SELECTION_GAP),
  );
  const preferredTop = candidate.rect.top - SELECTION_GAP - size.height;
  const top =
    preferredTop >= VIEWPORT_GAP
      ? preferredTop
      : Math.max(
          VIEWPORT_GAP,
          Math.min(
            window.innerHeight - VIEWPORT_GAP - size.height,
            candidate.rect.bottom + SELECTION_GAP,
          ),
        );

  return createPortal(
    <button
      ref={ref}
      type="button"
      data-reply-quote-action="true"
      className="fixed z-50 inline-flex h-9 items-center justify-center whitespace-nowrap rounded-[12px] bg-surface px-3 text-[14px] leading-5 font-medium text-reply-quote-action-foreground shadow-reply-quote-action transition-colors duration-[120ms] motion-reduce:transition-none hover:bg-reply-quote-action-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-full before:min-w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
      style={{ left, top }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => onSelect(candidate)}
    >
      询问Piko
    </button>,
    document.body,
  );
}

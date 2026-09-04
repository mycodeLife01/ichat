import { useCallback, useEffect, useState } from "react";

import type { ReplyQuoteSourceAnchor } from "../api/types";
import { captureReplyQuoteSourceAnchor } from "./replyQuoteSourceNavigation";

export type ReplyQuoteSelectionCandidate = {
  sourceMessageId: string;
  excerpt: string;
  sourceAnchor: ReplyQuoteSourceAnchor | null;
  rect: { top: number; right: number; bottom: number; left: number; width: number; height: number };
};

const SELECTION_SETTLE_MS = 100;

function elementForNode(node: Node | null): Element | null {
  if (node instanceof Element) return node;
  return node?.parentElement ?? null;
}

function normalizeSelectionText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function useReplyQuoteSelection(conversationId: string | null) {
  const [candidate, setCandidate] = useState<ReplyQuoteSelectionCandidate | null>(null);
  const dismiss = useCallback(() => setCandidate(null), []);

  useEffect(() => {
    setCandidate(null);
    if (conversationId === null) return;

    let settleTimer: number | null = null;
    let pointerSelecting = false;

    const evaluate = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setCandidate(null);
        return;
      }
      const anchor = elementForNode(selection.anchorNode);
      const focus = elementForNode(selection.focusNode);
      const anchorRoot = anchor?.closest<HTMLElement>("[data-reply-quote-message-id]");
      const focusRoot = focus?.closest<HTMLElement>("[data-reply-quote-message-id]");
      if (
        !anchorRoot ||
        anchorRoot !== focusRoot ||
        anchor?.closest("[data-reply-quote-exclude]") ||
        focus?.closest("[data-reply-quote-exclude]")
      ) {
        setCandidate(null);
        return;
      }
      const sourceMessageId = anchorRoot.dataset.replyQuoteMessageId;
      const excerpt = normalizeSelectionText(selection.toString());
      if (!sourceMessageId || excerpt === "") {
        setCandidate(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const sourceAnchor = captureReplyQuoteSourceAnchor(range, anchorRoot);
      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 || rect.height > 0,
      );
      const boundingRect = range.getBoundingClientRect();
      const rangeRect =
        boundingRect.width > 0 || boundingRect.height > 0
          ? boundingRect
          : rects.at(0) ?? boundingRect;
      if (rangeRect.width <= 0 && rangeRect.height <= 0) {
        setCandidate(null);
        return;
      }
      setCandidate({
        sourceMessageId,
        excerpt,
        sourceAnchor,
        rect: {
          top: rangeRect.top,
          right: rangeRect.right,
          bottom: rangeRect.bottom,
          left: rangeRect.left,
          width: rangeRect.width,
          height: rangeRect.height,
        },
      });
    };
    const scheduleEvaluate = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (pointerSelecting) {
        settleTimer = null;
        return;
      }
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        evaluate();
      }, SELECTION_SETTLE_MS);
    };
    const dismissPending = () => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
        settleTimer = null;
      }
      setCandidate(null);
    };
    const evaluateAfterPointer = () => {
      const shouldEvaluate = pointerSelecting;
      pointerSelecting = false;
      if (shouldEvaluate) queueMicrotask(scheduleEvaluate);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-reply-quote-action]")) return;
      pointerSelecting = Boolean(target?.closest("[data-reply-quote-message-id]"));
      dismissPending();
    };
    const onPointerCancel = () => {
      pointerSelecting = false;
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
        settleTimer = null;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissPending();
    };

    document.addEventListener("selectionchange", scheduleEvaluate);
    document.addEventListener("pointerup", evaluateAfterPointer);
    document.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", dismissPending, true);
    window.addEventListener("resize", dismissPending);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      document.removeEventListener("selectionchange", scheduleEvaluate);
      document.removeEventListener("pointerup", evaluateAfterPointer);
      document.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", dismissPending, true);
      window.removeEventListener("resize", dismissPending);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [conversationId, dismiss]);

  return { candidate, dismiss };
}

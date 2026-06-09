import { useCallback } from "react";

import { isAbortError } from "../api/errors";
import { useAppActions } from "../app/context";

export function useRunStream() {
  const { dispatch, services, streamAbort, stateRef } = useAppActions();
  const { conversationApi, runApi } = services;

  // stateRef is advanced synchronously on every dispatch, so the async terminal
  // handler reads the latest selected conversation even when the stream finishes
  // before React commits a render — a run that ends after the user navigated away
  // must not overwrite detail.

  const start = useCallback(
    async (runId: number, conversationId: number, afterSeq: number): Promise<void> => {
      const controller = new AbortController();
      streamAbort.register(() => controller.abort());

      try {
        for await (const event of runApi.streamEvents(runId, afterSeq, {
          signal: controller.signal,
        })) {
          const raw = event.data.payload.text;
          const text = typeof raw === "string" ? raw : "";

          if (event.type === "reasoning_delta") {
            dispatch({ type: "run/reasoningDelta", seq: event.seq, text });
          } else if (event.type === "text_delta") {
            dispatch({ type: "run/textDelta", seq: event.seq, text });
          } else if (
            event.type === "run_succeeded" ||
            event.type === "run_failed" ||
            event.type === "run_cancelled"
          ) {
            const status =
              event.type === "run_succeeded"
                ? "succeeded"
                : event.type === "run_failed"
                  ? "failed"
                  : "cancelled";
            dispatch({ type: "run/terminal", status });

            if (status === "succeeded") {
              const [detail, list] = await Promise.all([
                conversationApi.detail(conversationId),
                conversationApi.list(),
              ]);
              dispatch({ type: "conversations/listLoaded", items: list });
              dispatch({ type: "conversations/draftActivated" });
              if (stateRef.current.conversationIndex.selectedId === conversationId) {
                const { messages, ...conversation } = detail;
                dispatch({ type: "conversations/detailLoaded", conversation, messages });
              }
              dispatch({ type: "run/cleared" });
            }
          }
        }
      } catch (error) {
        if (isAbortError(error)) return;
        dispatch({ type: "run/terminal", status: "failed" });
      }
    },
    [dispatch, conversationApi, runApi, streamAbort, stateRef],
  );

  // Optimistically flip to "停止中" and ask the server to cancel. We do NOT abort
  // the local stream — the server's run_cancelled event arrives over SSE and
  // drives the terminal transition (so "已停止" only shows after the real terminal).
  const cancel = useCallback(
    async (runId: number): Promise<void> => {
      dispatch({ type: "run/cancelRequested" });
      try {
        await runApi.cancel(runId);
      } catch {
        // Swallow: the SSE terminal still arrives, or the user can retry.
      }
    },
    [dispatch, runApi],
  );

  return { start, cancel };
}

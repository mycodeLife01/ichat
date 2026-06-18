import { useCallback, useRef } from "react";

import { isAbortError } from "../api/errors";
import type { RunEventResponse, RunToolState } from "../api/types";
import { useAppActions } from "../app/context";

export function useRunStream() {
  const { dispatch, services, streamAbort, stateRef } = useAppActions();
  const { conversationApi, runApi } = services;

  // stateRef is advanced synchronously on every dispatch, so the async terminal
  // handler reads the latest selected conversation even when the stream finishes
  // before React commits a render — a run that ends after the user navigated away
  // must not overwrite detail.

  // At most one stream is consumed at a time: starting a new one (send, or
  // recovery re-attaching to a run we may already be reading in the background)
  // aborts the previous consumer so events are never dispatched twice.
  const controllerRef = useRef<AbortController | null>(null);

  const start = useCallback(
    async (runId: string, conversationId: string, afterSeq: number): Promise<void> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      streamAbort.register(() => controller.abort());

      try {
        for await (const event of runApi.streamEvents(runId, afterSeq, {
          signal: controller.signal,
        })) {
          // Whether this run is still the one the UI is showing. Navigating to
          // another conversation clears (or replaces) activeRun, but this stream
          // keeps yielding in the background until its abort propagates. Run-state
          // mutations below are gated on this so a late event never lands on the
          // wrong run — leaking A's text/terminal into conversation B.
          const isActiveRun = () => stateRef.current.activeRun?.runId === runId;

          const raw = event.data.payload.text;
          const text = typeof raw === "string" ? raw : "";

          if (event.type === "reasoning_delta") {
            if (isActiveRun()) dispatch({ type: "run/reasoningDelta", seq: event.seq, text });
          } else if (event.type === "text_delta") {
            if (isActiveRun()) dispatch({ type: "run/textDelta", seq: event.seq, text });
          } else if (
            event.type === "tool_call_started" ||
            event.type === "tool_call_succeeded" ||
            event.type === "tool_call_failed"
          ) {
            if (isActiveRun()) {
              dispatch({
                type: "run/toolState",
                seq: event.seq,
                toolState: toolStateFromEvent(event.data),
              });
            }
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
            if (isActiveRun()) dispatch({ type: "run/terminal", status });

            if (status === "succeeded") {
              // Refetch unconditionally: a run finishing in the background still
              // activates its draft and updates the sidebar, even if the user has
              // moved on. Only the view-bound dispatches below are gated.
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
              if (isActiveRun()) dispatch({ type: "run/cleared" });

              // A freshly-activated draft has no title yet (the worker generates
              // it best-effort after this commit, with no SSE event). Mark it
              // pending so the sidebar/topbar show a skeleton; an AppShell effect
              // polls detail until the title lands or the window elapses.
              if (!detail.title?.trim()) {
                dispatch({ type: "conversations/titlePending", id: conversationId });
              }
            }
          }
        }
      } catch (error) {
        if (isAbortError(error)) return;
        // Same guard as the in-loop dispatches: a background stream error must
        // not fail whatever run is active now.
        if (stateRef.current.activeRun?.runId === runId) {
          dispatch({ type: "run/terminal", status: "failed" });
        }
      }
    },
    [dispatch, conversationApi, runApi, streamAbort, stateRef],
  );

  // Optimistically flip to "停止中" and ask the server to cancel. We do NOT abort
  // the local stream — the server's run_cancelled event arrives over SSE and
  // drives the terminal transition (so "已停止" only shows after the real terminal).
  const cancel = useCallback(
    async (runId: string): Promise<void> => {
      // The stop button disables on "stopping", but that only lands after a
      // render — rapid double clicks (or other callers) can get here first.
      // stateRef advances synchronously on dispatch, so this dedups reliably.
      const run = stateRef.current.activeRun;
      if (run?.runId === runId && run.cancelRequested) return;
      dispatch({ type: "run/cancelRequested" });
      try {
        await runApi.cancel(runId);
      } catch {
        // The server never got the cancel: revert the optimistic "停止中" so the
        // user can press stop again, and surface a Chinese toast.
        dispatch({ type: "run/cancelFailed" });
        dispatch({ type: "ui/showToast", message: "停止失败，请重试" });
      }
    },
    [dispatch, runApi, stateRef],
  );

  return { start, cancel };
}

function toolStateFromEvent(event: RunEventResponse): RunToolState {
  const payload = event.payload;
  const sources = Array.isArray(payload.sources)
    ? payload.sources
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          id: typeof item.id === "number" ? item.id : Number(item.id ?? 0),
          title: typeof item.title === "string" ? item.title : "",
          url: typeof item.url === "string" ? item.url : "",
        }))
    : [];
  const status =
    event.type === "tool_call_started"
      ? "running"
      : event.type === "tool_call_succeeded"
        ? "succeeded"
        : "failed";
  return {
    status,
    tool_name: typeof payload.tool_name === "string" ? payload.tool_name : "web_search",
    query: typeof payload.query === "string" ? payload.query : null,
    message: typeof payload.message === "string" ? payload.message : null,
    result_count: typeof payload.result_count === "number" ? payload.result_count : null,
    sources,
  };
}

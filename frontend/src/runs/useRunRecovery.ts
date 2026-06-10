import { useCallback } from "react";

import { useAppActions } from "../app/context";
import { findPendingRunId } from "./pendingRun";

type StartStream = (
  runId: number,
  conversationId: number,
  afterSeq: number,
) => Promise<void> | void;

// Recovery on conversation entry (page refresh restore, sidebar selection):
// when the loaded thread ends with a run that never materialized an assistant
// reply, rebuild the streaming placeholder from the server's run state — and,
// for a run still in flight, resume the SSE stream from latest_seq. Best-effort:
// any failure leaves the conversation as plain history.
export function useRunRecovery(start: StartStream) {
  const { dispatch, services, stateRef } = useAppActions();
  const { conversationApi, runApi } = services;

  return useCallback(
    async (conversationId: number): Promise<void> => {
      const { conversationDetail, activeRun } = stateRef.current;
      if (conversationDetail.conversation?.id !== conversationId) return;
      // Already attached (e.g. re-clicking the active conversation): nothing to do.
      if (activeRun?.conversationId === conversationId) return;

      const runId = findPendingRunId(conversationDetail.messages);
      if (runId == null) return;

      let runState;
      try {
        runState = await runApi.state(runId);
      } catch {
        return;
      }
      // The user may have navigated away while the state call was in flight.
      if (stateRef.current.conversationIndex.selectedId !== conversationId) return;

      if (runState.status === "succeeded") {
        // The reply materialized after our detail snapshot: refetch instead of
        // restoring a stale draft (mirrors the run-succeeded terminal handling).
        try {
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
        } catch {
          // Leave the snapshot as-is; the next selection or refresh catches up.
        }
        return;
      }

      dispatch({
        type: "run/restored",
        runId,
        conversationId,
        latestSeq: runState.latest_seq,
        draftText: runState.draft_text,
        draftReasoning: runState.draft_reasoning,
        status: runState.status,
      });

      // failed / cancelled: the partial and its status pill are all there is.
      if (runState.status === "failed" || runState.status === "cancelled") return;
      void start(runId, conversationId, runState.latest_seq);
    },
    [dispatch, conversationApi, runApi, stateRef, start],
  );
}

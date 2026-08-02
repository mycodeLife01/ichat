import { useCallback } from "react";

import { useAppActions } from "../app/context";
import { currentRunOptions } from "../runs/runOptions";
import { selectionStore } from "./selectionStore";

// `start` is injected by AppShell (which owns the single useRunStream instance),
// so this hook stays free of streaming wiring and is trivially testable with a spy.
export function useSendMessage(
  start: (runId: string, conversationId: string, afterSeq: number) => void,
) {
  const { dispatch, services, stateRef } = useAppActions();
  const { conversationApi } = services;

  return useCallback(
    async (content: string, attachmentIds?: string[]): Promise<boolean> => {
      const trimmed = content.trim();
      if (
        (trimmed === "" && (attachmentIds?.length ?? 0) === 0) ||
        stateRef.current.pendingSubmission !== null
      ) {
        return false;
      }

      let targetId = stateRef.current.conversationIndex.selectedId;
      const runOptions = currentRunOptions();
      dispatch({
        type: "submission/started",
        content: trimmed,
        conversationId: targetId,
      });

      try {
        if (targetId == null) {
          const { conversation: convo, message, run } =
            attachmentIds === undefined
              ? await conversationApi.createWithMessage(trimmed, runOptions)
              : await conversationApi.createWithMessage(
                  trimmed,
                  runOptions,
                  undefined,
                  attachmentIds,
                );
          targetId = convo.id;
          dispatch({ type: "submission/targeted", conversationId: convo.id });
          dispatch({
            type: "conversations/detailLoaded",
            conversation: convo,
            messages: [message],
          });
          dispatch({ type: "conversations/selected", id: convo.id });
          dispatch({ type: "conversations/draftCreated", id: convo.id });
          dispatch({
            type: "run/started",
            runId: run.id,
            conversationId: convo.id,
            providerName: run.provider_name,
          });
          dispatch({ type: "submission/cleared" });
          selectionStore.save(convo.id);
          void start(run.id, convo.id, 0);
          return true;
        }

        const { message, run } =
          attachmentIds === undefined
            ? await conversationApi.sendMessage(targetId, trimmed, runOptions)
            : await conversationApi.sendMessage(targetId, trimmed, runOptions, attachmentIds);
        dispatch({ type: "conversations/messageAppended", message });
        dispatch({
          type: "run/started",
          runId: run.id,
          conversationId: targetId,
          providerName: run.provider_name,
        });
        dispatch({ type: "submission/cleared" });
        void start(run.id, targetId, 0);
        return true;
      } catch (error) {
        dispatch({ type: "submission/cleared" });
        console.error("send message failed", error);
        dispatch({ type: "ui/showToast", message: "发送失败，请重试", tone: "error" });
        return false;
      }
    },
    [dispatch, conversationApi, start, stateRef],
  );
}

import { useCallback } from "react";

import { useAppActions, useAppState } from "../app/context";
import { thinkingLevelStore, toRunOptions } from "../runs/thinkingLevel";
import { webSearchPreferenceStore } from "../runs/webSearchPreference";
import { selectionStore } from "./selectionStore";

// `start` is injected by AppShell (which owns the single useRunStream instance),
// so this hook stays free of streaming wiring and is trivially testable with a spy.
export function useSendMessage(
  start: (runId: string, conversationId: string, afterSeq: number) => void,
) {
  const { conversationIndex } = useAppState();
  const { dispatch, services } = useAppActions();
  const { conversationApi } = services;

  return useCallback(
    async (content: string): Promise<void> => {
      const trimmed = content.trim();
      if (trimmed === "") return;

      try {
        let targetId = conversationIndex.selectedId;
        if (targetId == null) {
          const convo = await conversationApi.create();
          targetId = convo.id;
          dispatch({ type: "conversations/detailLoaded", conversation: convo, messages: [] });
          dispatch({ type: "conversations/selected", id: convo.id });
          dispatch({ type: "conversations/draftCreated", id: convo.id });
          selectionStore.save(convo.id);
        }

        const { message, run } = await conversationApi.sendMessage(
          targetId,
          trimmed,
          toRunOptions(thinkingLevelStore.read(), webSearchPreferenceStore.requestEnabled()),
        );
        dispatch({ type: "conversations/messageAppended", message });
        dispatch({ type: "run/started", runId: run.id, conversationId: targetId });
        void start(run.id, targetId, 0);
      } catch (error) {
        // Send failed before streaming started. Keep input so the user can retry,
        // and surface a Chinese toast.
        console.error("send message failed", error);
        dispatch({ type: "ui/showToast", message: "发送失败，请重试" });
      }
    },
    [conversationIndex.selectedId, dispatch, conversationApi, start],
  );
}

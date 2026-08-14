import { useCallback } from "react";

import { ApiError } from "../api/errors";
import { useAppActions } from "../app/context";
import { currentRunOptions } from "../runs/runOptions";
import type { FileAttachment } from "../files/types";
import { selectionStore } from "./selectionStore";

function createSubmissionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

// `start` is injected by AppShell (which owns the single useRunStream instance),
// so this hook stays free of streaming wiring and is trivially testable with a spy.
export function useSendMessage(
  start: (runId: string, conversationId: string, afterSeq: number) => void,
  onCommitted?: (messageId: string, clientSubmissionId: string) => void,
) {
  const { dispatch, services, stateRef } = useAppActions();
  const { conversationApi } = services;

  return useCallback(
    async (
      content: string,
      attachmentIds?: string[],
      optimisticAttachments: FileAttachment[] = [],
    ): Promise<boolean> => {
      const trimmed = content.trim();
      if (
        (trimmed === "" && (attachmentIds?.length ?? 0) === 0) ||
        stateRef.current.pendingSubmission !== null
      ) {
        return false;
      }

      let targetId = stateRef.current.conversationIndex.selectedId;
      const runOptions = currentRunOptions();
      const clientSubmissionId = createSubmissionId();
      dispatch({
        type: "submission/started",
        clientId: clientSubmissionId,
        content: trimmed,
        conversationId: targetId,
        attachments: optimisticAttachments,
      });

      try {
        if (targetId == null) {
          const { conversation: convo, message, run, image_context: imageContext } =
            attachmentIds === undefined
              ? await conversationApi.createWithMessage(trimmed, runOptions)
              : await conversationApi.createWithMessage(
                  trimmed,
                  runOptions,
                  undefined,
                  attachmentIds,
                );
          targetId = convo.id;
          onCommitted?.(message.id, clientSubmissionId);
          dispatch({ type: "submission/targeted", conversationId: convo.id });
          dispatch({
            type: "conversations/detailLoaded",
            conversation: convo,
            messages: [message],
            imageContext,
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

        const { message, run, image_context: imageContext } =
          attachmentIds === undefined
            ? await conversationApi.sendMessage(targetId, trimmed, runOptions)
            : await conversationApi.sendMessage(targetId, trimmed, runOptions, attachmentIds);
        onCommitted?.(message.id, clientSubmissionId);
        dispatch({ type: "conversations/messageAppended", message, imageContext });
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
        const code = error instanceof ApiError ? error.code : undefined;
        const recoveryMessage =
          code === "IMAGE_INPUT_NOT_SUPPORTED"
            ? "Switch to a vision model before sending images."
            : code === "VISION_MODEL_REQUIRED"
              ? "This conversation requires a compatible vision model."
              : code === "LEGACY_IMAGE_CONTEXT"
                ? "Upgrade the original image message with a vision model first."
                : null;
        if (recoveryMessage) {
          dispatch({ type: "ui/showToast", message: recoveryMessage, tone: "error" });
          return false;
        }
        dispatch({ type: "ui/showToast", message: "发送失败，请重试", tone: "error" });
        return false;
      }
    },
    [dispatch, conversationApi, onCommitted, start, stateRef],
  );
}

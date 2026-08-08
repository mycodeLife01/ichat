import { useCallback } from "react";

import type { RunResponse } from "../api/types";
import { ApiError } from "../api/errors";
import { useAppActions } from "../app/context";
import { currentRunOptions } from "../runs/runOptions";

type StartStream = (
  runId: string,
  conversationId: string,
  afterSeq: number,
) => Promise<void> | void;

// Edit-and-regenerate / regenerate both archive part of the thread server-side
// and queue a fresh run. We refetch detail as the authoritative post-archive
// thread (rather than trusting the returned message), then stream the new run —
// reusing the exact run lifecycle as a normal send. `start` is injected by
// AppShell (the single useRunStream owner), matching useSendMessage.
export function useRegenerate(start: StartStream) {
  const { dispatch, services, stateRef } = useAppActions();
  const { conversationApi } = services;

  const run = useCallback(
    async (
      call: () => Promise<{ run: RunResponse; image_context?: import("../api/types").ImageContext }>,
      conversationId: string,
    ): Promise<boolean> => {
      try {
        const { run: started } = await call();
        const detail = await conversationApi.detail(conversationId);
        const { messages, ...conversation } = detail;
        dispatch({
          type: "conversations/detailLoaded",
          conversation,
          messages,
          imageContext: detail.image_context,
        });
        dispatch({
          type: "run/started",
          runId: started.id,
          conversationId,
          providerName: started.provider_name,
        });
        void start(started.id, conversationId, 0);
        return true;
      } catch (error) {
        // Keep the current view usable (e.g. a 409 active-run race) and surface a
        // Chinese toast.
        console.error("regenerate failed", error);
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
        dispatch({ type: "ui/showToast", message: "操作失败，请重试", tone: "error" });
        return false;
      }
    },
    [dispatch, conversationApi, start],
  );

  const editAndRegenerate = useCallback(
    async (
      messageId: string,
      content: string,
      attachmentIds?: string[],
    ): Promise<boolean> => {
      const conversationId = stateRef.current.conversationIndex.selectedId;
      const trimmed = content.trim();
      if (
        conversationId == null ||
        (trimmed === "" && (attachmentIds === undefined || attachmentIds.length === 0))
      ) {
        return false;
      }
      const succeeded = await run(
        () =>
          attachmentIds === undefined
            ? conversationApi.editAndRegenerate(
                conversationId,
                messageId,
                trimmed,
                currentRunOptions(),
              )
            : conversationApi.editAndRegenerate(
                conversationId,
                messageId,
                trimmed,
                currentRunOptions(),
                attachmentIds,
              ),
        conversationId,
      );
      return succeeded;
    },
    [run, conversationApi, stateRef],
  );

  const regenerate = useCallback(
    async (messageId: string): Promise<boolean> => {
      const conversationId = stateRef.current.conversationIndex.selectedId;
      if (conversationId == null) return false;
      return run(
        () =>
          conversationApi.regenerate(conversationId, messageId, currentRunOptions()),
        conversationId,
      );
    },
    [run, conversationApi, stateRef],
  );

  return { editAndRegenerate, regenerate };
}

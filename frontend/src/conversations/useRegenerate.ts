import { useCallback } from "react";

import { useAppActions } from "../app/context";

type StartStream = (
  runId: number,
  conversationId: number,
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
      call: () => Promise<{ run: { id: number } }>,
      conversationId: number,
    ): Promise<void> => {
      try {
        const { run: started } = await call();
        const detail = await conversationApi.detail(conversationId);
        const { messages, ...conversation } = detail;
        dispatch({ type: "conversations/detailLoaded", conversation, messages });
        dispatch({ type: "run/started", runId: started.id, conversationId });
        void start(started.id, conversationId, 0);
      } catch (error) {
        // Keep the current view usable (e.g. a 409 active-run race) and surface a
        // Chinese toast.
        console.error("regenerate failed", error);
        dispatch({ type: "ui/showToast", message: "操作失败，请重试" });
      }
    },
    [dispatch, conversationApi, start],
  );

  const editAndRegenerate = useCallback(
    async (messageId: number, content: string): Promise<void> => {
      const conversationId = stateRef.current.conversationIndex.selectedId;
      const trimmed = content.trim();
      if (conversationId == null || trimmed === "") return;
      await run(
        () => conversationApi.editAndRegenerate(conversationId, messageId, trimmed),
        conversationId,
      );
    },
    [run, conversationApi, stateRef],
  );

  const regenerate = useCallback(
    async (messageId: number): Promise<void> => {
      const conversationId = stateRef.current.conversationIndex.selectedId;
      if (conversationId == null) return;
      await run(() => conversationApi.regenerate(conversationId, messageId), conversationId);
    },
    [run, conversationApi, stateRef],
  );

  return { editAndRegenerate, regenerate };
}

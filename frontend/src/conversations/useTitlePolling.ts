import { useCallback } from "react";

import { useAppActions } from "../app/context";

type PollOptions = {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The worker generates a draft's title best-effort after the first run succeeds,
// without an SSE event. We poll detail until the title is written back (then
// refresh the sidebar) or the window elapses (fall back to 新对话). The id stays
// in pendingTitleIds for the duration so the sidebar/topbar show a skeleton.
export function useTitlePolling() {
  const { dispatch, services, stateRef } = useAppActions();
  const { conversationApi } = services;

  return useCallback(
    async (conversationId: number, options: PollOptions = {}): Promise<void> => {
      const { attempts = 20, delayMs = 750, sleep = realSleep } = options;

      // One poller per conversation: a second kickoff while already pending bails.
      if (stateRef.current.conversationIndex.pendingTitleIds.includes(conversationId)) return;
      dispatch({ type: "conversations/titlePending", id: conversationId });

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await sleep(delayMs);
        // Cleared by logout / identity reset — stop silently.
        if (!stateRef.current.conversationIndex.pendingTitleIds.includes(conversationId)) return;

        let detail;
        try {
          detail = await conversationApi.detail(conversationId);
        } catch {
          dispatch({ type: "conversations/titleResolved", id: conversationId });
          return;
        }

        if (detail.title?.trim()) {
          const list = await conversationApi.list();
          dispatch({ type: "conversations/listLoaded", items: list });
          dispatch({ type: "conversations/titleResolved", id: conversationId });
          return;
        }
      }

      dispatch({ type: "conversations/titleResolved", id: conversationId });
    },
    [dispatch, conversationApi, stateRef],
  );
}

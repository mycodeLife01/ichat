import { useCallback, useRef } from "react";

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
  // Dedup on the actual running loop, not on pendingTitleIds: the kickoff (e.g.
  // useRunStream) may already have set the id pending, and an effect may call us
  // again for the same id — only one loop should run.
  const running = useRef(new Set<number>());

  return useCallback(
    async (conversationId: number, options: PollOptions = {}): Promise<void> => {
      const { attempts = 20, delayMs = 750, sleep = realSleep } = options;

      if (running.current.has(conversationId)) return;
      running.current.add(conversationId);
      dispatch({ type: "conversations/titlePending", id: conversationId });

      try {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          await sleep(delayMs);
          // Cleared by logout / identity reset — stop silently.
          if (!stateRef.current.conversationIndex.pendingTitleIds.includes(conversationId)) {
            return;
          }

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
      } finally {
        running.current.delete(conversationId);
      }
    },
    [dispatch, conversationApi, stateRef],
  );
}


import { useEffect, useRef } from "react";

import { useAppActions, useAppState } from "../app/context";
import { CONVERSATION_PAGE_SIZE } from "./pagination";

type SyncOptions = {
  titleIntervalMs?: number;
  runIntervalMs?: number;
  titleTimeoutMs?: number;
};

// Titles and background runs change without an SSE event on this client, so
// the sidebar re-reads its first page while either is outstanding: fast while
// a title is pending (it usually lands within seconds of sending), slower
// while another conversation's run is in flight. A title that never lands
// stops pending after the timeout and the row falls back to 新对话.
export function useConversationListSync({
  titleIntervalMs = 1000,
  runIntervalMs = 3000,
  titleTimeoutMs = 20_000,
}: SyncOptions = {}) {
  const { dispatch, services, stateRef } = useAppActions();
  const { conversationApi } = services;
  const { conversationIndex, activeRun } = useAppState();
  const { pendingTitleIds, items, pinnedItems } = conversationIndex;
  const localRunId = activeRun?.runId ?? null;
  const hasBackgroundRun = [...items, ...pinnedItems].some(
    (c) => c.active_run != null && c.active_run.id !== localRunId,
  );
  const delay =
    pendingTitleIds.length > 0 ? titleIntervalMs : hasBackgroundRun ? runIntervalMs : null;

  const pendingSince = useRef(new Map<string, number>());
  useEffect(() => {
    const now = Date.now();
    for (const id of pendingTitleIds) {
      if (!pendingSince.current.has(id)) pendingSince.current.set(id, now);
    }
    for (const id of [...pendingSince.current.keys()]) {
      if (!pendingTitleIds.includes(id)) pendingSince.current.delete(id);
    }
  }, [pendingTitleIds]);

  useEffect(() => {
    if (delay === null) return;
    let inFlight = false;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [id, since] of pendingSince.current) {
        if (now - since >= titleTimeoutMs) {
          dispatch({ type: "conversations/titleResolved", id });
        }
      }
      if (inFlight) return;
      inFlight = true;
      Promise.all([
        conversationApi.list({ limit: CONVERSATION_PAGE_SIZE, skip: 0 }),
        conversationApi.list({ view: "pinned" }),
      ])
        .then(([list, pinned]) => {
          // Logout / identity reset while the request was out: drop the result.
          if (stateRef.current.auth.session === null) return;
          dispatch({ type: "conversations/listSynced", items: list, pinned });
        })
        .catch(() => {
          // Transient; the next tick retries.
        })
        .finally(() => {
          inFlight = false;
        });
    }, delay);
    return () => clearInterval(timer);
  }, [delay, titleTimeoutMs, dispatch, conversationApi, stateRef]);
}

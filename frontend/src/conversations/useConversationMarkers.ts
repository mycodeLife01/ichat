import { useCallback } from "react";

import { ApiError } from "../api/errors";
import type { ConversationResponse } from "../api/types";
import { useAppActions } from "../app/context";

export const PINNED_CONVERSATION_LIMIT = 10;
const PIN_LIMIT_MESSAGE = "最多置顶 10 个对话";

// Pin and favorite toggles. The row moves at once; the server response then
// confirms it, and a failure puts the row back and says so.
export function useConversationMarkers() {
  const { dispatch, services, stateRef } = useAppActions();
  const { conversationApi } = services;

  const find = useCallback(
    (id: string): ConversationResponse | undefined => {
      const { conversationIndex, conversationDetail } = stateRef.current;
      return (
        conversationIndex.pinnedItems.find((c) => c.id === id) ??
        conversationIndex.items.find((c) => c.id === id) ??
        (conversationDetail.conversation?.id === id
          ? conversationDetail.conversation
          : undefined)
      );
    },
    [stateRef],
  );

  const toast = useCallback(
    (message: string, tone: "success" | "warning" | "error") =>
      dispatch({ type: "ui/showToast", message, tone }),
    [dispatch],
  );

  const togglePin = useCallback(
    async (id: string, fallback?: ConversationResponse) => {
      const current = find(id) ?? fallback;
      if (!current) return;
      const pinned = !current.pinned_at;
      if (
        pinned &&
        stateRef.current.conversationIndex.pinnedItems.length >= PINNED_CONVERSATION_LIMIT
      ) {
        toast(PIN_LIMIT_MESSAGE, "warning");
        return;
      }
      dispatch({
        type: "conversations/markerChanged",
        conversation: { ...current, pinned_at: pinned ? new Date().toISOString() : null },
      });
      try {
        const saved = await conversationApi.setPinned(id, pinned);
        dispatch({ type: "conversations/markerChanged", conversation: saved });
        toast(pinned ? "已置顶" : "已取消置顶", "success");
      } catch (error) {
        dispatch({ type: "conversations/markerChanged", conversation: current });
        if (error instanceof ApiError && error.code === "PIN_LIMIT_REACHED") {
          toast(PIN_LIMIT_MESSAGE, "warning");
        } else {
          toast("操作失败，请重试", "error");
        }
      }
    },
    [conversationApi, dispatch, find, stateRef, toast],
  );

  // Resolves to the saved favorite state, or null when the request failed.
  const toggleFavorite = useCallback(
    async (id: string, fallback?: ConversationResponse): Promise<boolean | null> => {
      const current = find(id) ?? fallback;
      if (!current) return null;
      const favorited = !current.favorited_at;
      dispatch({
        type: "conversations/markerChanged",
        conversation: {
          ...current,
          favorited_at: favorited ? new Date().toISOString() : null,
        },
      });
      try {
        const saved = await conversationApi.setFavorited(id, favorited);
        dispatch({ type: "conversations/markerChanged", conversation: saved });
        toast(favorited ? "已加入收藏" : "已取消收藏", "success");
        return favorited;
      } catch {
        dispatch({ type: "conversations/markerChanged", conversation: current });
        toast("操作失败，请重试", "error");
        return null;
      }
    },
    [conversationApi, dispatch, find, toast],
  );

  return { togglePin, toggleFavorite };
}

import { useCallback, useRef } from "react";

import { ApiError } from "../api/errors";
import { useAppActions, useAppState } from "../app/context";
import { CONVERSATION_PAGE_SIZE, hasMoreConversationPages } from "./pagination";
import { selectionStore } from "./selectionStore";

const INVALID_SELECTION_STATUSES = new Set([403, 404, 422]);

export function useConversationLoader() {
  const { conversationIndex, conversationDetail } = useAppState();
  const { dispatch, services } = useAppActions();
  const { conversationApi } = services;
  const loadingMoreRef = useRef(false);

  const loadList = useCallback(async () => {
    dispatch({ type: "conversations/listLoading" });
    try {
      const items = await conversationApi.list({
        limit: CONVERSATION_PAGE_SIZE,
        skip: 0,
      });
      dispatch({
        type: "conversations/listLoaded",
        items,
        hasMore: hasMoreConversationPages(items.length),
      });
    } catch {
      dispatch({ type: "conversations/listError" });
    }
  }, [dispatch, conversationApi]);

  const loadMore = useCallback(async () => {
    if (
      loadingMoreRef.current ||
      !conversationIndex.hasMore ||
      conversationIndex.status === "loading" ||
      conversationIndex.status === "loadingMore"
    ) {
      return;
    }

    loadingMoreRef.current = true;
    dispatch({ type: "conversations/listLoadingMore" });
    try {
      const items = await conversationApi.list({
        limit: CONVERSATION_PAGE_SIZE,
        skip: conversationIndex.items.length,
      });
      dispatch({
        type: "conversations/listPageLoaded",
        items,
        hasMore: hasMoreConversationPages(items.length),
      });
    } catch {
      dispatch({ type: "conversations/listError" });
    } finally {
      loadingMoreRef.current = false;
    }
  }, [
    dispatch,
    conversationApi,
    conversationIndex.hasMore,
    conversationIndex.items.length,
    conversationIndex.status,
  ]);

  const newConversation = useCallback(() => {
    dispatch({ type: "run/cleared" });
    dispatch({ type: "conversations/selected", id: null });
    dispatch({ type: "conversations/detailReset" });
    dispatch({ type: "ui/setMobileSidebar", open: false });
    selectionStore.clear();
  }, [dispatch]);

  const selectConversation = useCallback(
    async (id: string) => {
      // Re-clicking the active conversation is a no-op: avoid a redundant refetch.
      // Users who want to reload the current conversation should refresh the page.
      if (id === conversationIndex.selectedId) {
        dispatch({ type: "ui/setMobileSidebar", open: false });
        return;
      }
      dispatch({ type: "run/cleared" });
      dispatch({ type: "conversations/selected", id });
      dispatch({ type: "conversations/detailLoading" });
      dispatch({ type: "ui/setMobileSidebar", open: false });
      try {
        const detail = await conversationApi.detail(id);
        const { messages, ...conversation } = detail;
        dispatch({ type: "conversations/detailLoaded", conversation, messages });
        selectionStore.save(id);
      } catch (error) {
        // 403/404/422: invalid or inaccessible URL selection; clear back to blank.
        // Other errors still use the simplified forbidden detail state.
        dispatch({ type: "conversations/detailForbidden" });
        if (error instanceof ApiError && INVALID_SELECTION_STATUSES.has(error.status)) {
          dispatch({ type: "conversations/selected", id: null });
          dispatch({
            type: "ui/showToast",
            message: "会话 ID 无效或已失效，已回到新对话",
          });
          selectionStore.clear();
        }
      }
    },
    [dispatch, conversationApi, conversationIndex.selectedId],
  );

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim();
      if (trimmed === "") return;
      // Unchanged after trimming (e.g. blur without editing) — skip the API call.
      const current = conversationIndex.items.find((c) => c.id === id);
      if (current && current.title === trimmed) return;
      const conversation = await conversationApi.rename(id, trimmed);
      dispatch({ type: "conversations/renamed", conversation });
    },
    [dispatch, conversationApi, conversationIndex.items],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await conversationApi.remove(id);
      const remaining = conversationIndex.items.filter((c) => c.id !== id);
      dispatch({ type: "conversations/removed", id });
      dispatch({ type: "ui/closeConfirm" });
      if (conversationIndex.selectedId === id) {
        if (remaining.length > 0) {
          await selectConversation(remaining[0].id);
        } else {
          newConversation();
        }
      }
    },
    [dispatch, conversationApi, conversationIndex, selectConversation, newConversation],
  );

  return {
    items: conversationIndex.items,
    selectedId: conversationIndex.selectedId,
    listStatus: conversationIndex.status,
    hasMore: conversationIndex.hasMore,
    isLoadingMore: conversationIndex.status === "loadingMore",
    detail: conversationDetail,
    detailStatus: conversationDetail.status,
    loadList,
    loadMore,
    selectConversation,
    newConversation,
    renameConversation,
    deleteConversation,
  };
}

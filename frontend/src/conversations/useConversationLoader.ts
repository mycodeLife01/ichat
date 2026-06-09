import { useCallback } from "react";

import { ApiError } from "../api/errors";
import { useAppActions, useAppState } from "../app/context";
import { selectionStore } from "./selectionStore";

export function useConversationLoader() {
  const { conversationIndex, conversationDetail } = useAppState();
  const { dispatch, services } = useAppActions();
  const { conversationApi } = services;

  const loadList = useCallback(async () => {
    dispatch({ type: "conversations/listLoading" });
    try {
      const items = await conversationApi.list();
      dispatch({ type: "conversations/listLoaded", items });
    } catch {
      dispatch({ type: "conversations/listError" });
    }
  }, [dispatch, conversationApi]);

  const newConversation = useCallback(() => {
    dispatch({ type: "run/cleared" });
    dispatch({ type: "conversations/selected", id: null });
    dispatch({ type: "conversations/detailReset" });
    dispatch({ type: "ui/setMobileSidebar", open: false });
    selectionStore.clear();
  }, [dispatch]);

  const selectConversation = useCallback(
    async (id: number) => {
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
        // 403/404：失效选择，静默清理回空白态。其它错误也归为 forbidden 简化态。
        dispatch({ type: "conversations/detailForbidden" });
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          dispatch({ type: "conversations/selected", id: null });
          selectionStore.clear();
        }
      }
    },
    [dispatch, conversationApi, conversationIndex.selectedId],
  );

  const renameConversation = useCallback(
    async (id: number, title: string) => {
      const trimmed = title.trim();
      if (trimmed === "") return;
      const conversation = await conversationApi.rename(id, trimmed);
      dispatch({ type: "conversations/renamed", conversation });
    },
    [dispatch, conversationApi],
  );

  const deleteConversation = useCallback(
    async (id: number) => {
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
    detail: conversationDetail,
    detailStatus: conversationDetail.status,
    loadList,
    selectConversation,
    newConversation,
    renameConversation,
    deleteConversation,
  };
}

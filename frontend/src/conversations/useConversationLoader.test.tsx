import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import type { ConversationResponse } from "../api/types";
import { useAppActions, useAppState } from "../app/context";
import { conversationDetailResponse, conversationResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { CONVERSATION_PAGE_SIZE } from "./pagination";
import { selectionStore } from "./selectionStore";
import { useConversationLoader } from "./useConversationLoader";

function makeConversation(index: number): ConversationResponse {
  return {
    ...conversationResponse,
    id: String(index),
    title: `Conversation ${index}`,
  };
}

describe("useConversationLoader", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("loads the first page of the list", async () => {
    const list = vi.fn(async () => [conversationResponse]);
    const services = createFakeServices({}, { list });
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.loadList();
    });

    expect(result.current.items).toEqual([conversationResponse]);
    expect(result.current.hasMore).toBe(false);
    expect(list).toHaveBeenCalledWith({ limit: CONVERSATION_PAGE_SIZE, skip: 0 });
  });

  it("loads the next page when more conversations are available", async () => {
    const firstPage = Array.from({ length: CONVERSATION_PAGE_SIZE }, (_, index) =>
      makeConversation(index + 1),
    );
    const secondPage = [makeConversation(CONVERSATION_PAGE_SIZE + 1)];
    const list = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    const services = createFakeServices({}, { list });
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.loadList();
    });
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(list).toHaveBeenNthCalledWith(2, {
      limit: CONVERSATION_PAGE_SIZE,
      skip: CONVERSATION_PAGE_SIZE,
    });
    expect(result.current.items).toHaveLength(CONVERSATION_PAGE_SIZE + 1);
    expect(result.current.hasMore).toBe(false);
  });

  it("selects a conversation and persists the id", async () => {
    const services = createFakeServices(
      {},
      { detail: async () => conversationDetailResponse },
    );
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.selectConversation(conversationResponse.id);
    });

    expect(result.current.selectedId).toBe(conversationResponse.id);
    expect(result.current.detailStatus).toBe("ready");
    expect(selectionStore.read()).toBe(conversationResponse.id);
  });

  it("does not refetch when the already-selected conversation is clicked again", async () => {
    const detail = vi.fn(async () => conversationDetailResponse);
    const services = createFakeServices({}, { detail });
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.selectConversation(conversationResponse.id);
    });
    expect(detail).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.selectConversation(conversationResponse.id);
    });
    expect(detail).toHaveBeenCalledTimes(1);
  });

  it("clears selection when detail is forbidden (404)", async () => {
    selectionStore.save("999");
    const services = createFakeServices(
      {},
      {
        detail: async () => {
          throw new ApiError({ status: 404 });
        },
      },
    );
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.selectConversation("999");
    });

    expect(result.current.selectedId).toBeNull();
    expect(result.current.detailStatus).toBe("forbidden");
    expect(selectionStore.read()).toBeNull();
  });

  it("new conversation resets detail and clears persistence", async () => {
    selectionStore.save("5");
    const services = createFakeServices();
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    act(() => {
      result.current.newConversation();
    });

    expect(result.current.selectedId).toBeNull();
    expect(result.current.detailStatus).toBe("idle");
    expect(selectionStore.read()).toBeNull();
  });

  it("renames a conversation", async () => {
    const renamed = { ...conversationResponse, title: "新名" };
    const services = createFakeServices(
      {},
      {
        list: async () => [conversationResponse],
        rename: async () => renamed,
      },
    );
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.loadList();
    });
    await act(async () => {
      await result.current.renameConversation(conversationResponse.id, "新名");
    });

    expect(result.current.items[0].title).toBe("新名");
  });

  it("skips the rename API when the trimmed title is unchanged", async () => {
    const rename = vi.fn(async () => conversationResponse);
    const services = createFakeServices(
      {},
      { list: async () => [conversationResponse], rename },
    );
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.loadList();
    });
    await act(async () => {
      // Same title with surrounding whitespace — blur without a real edit.
      await result.current.renameConversation(
        conversationResponse.id,
        `  ${conversationResponse.title}  `,
      );
    });

    expect(rename).not.toHaveBeenCalled();
  });

  it("deletes the selected conversation and falls back to empty", async () => {
    const remove = vi.fn(async () => ({ status: "ok" }));
    const services = createFakeServices(
      {},
      { list: async () => [conversationResponse], detail: async () => conversationDetailResponse, remove },
    );
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.loadList();
      await result.current.selectConversation(conversationResponse.id);
    });
    await act(async () => {
      await result.current.deleteConversation(conversationResponse.id);
    });

    expect(remove).toHaveBeenCalledWith(conversationResponse.id);
    expect(result.current.items).toHaveLength(0);
    expect(result.current.selectedId).toBeNull();
  });

  function useClearProbe() {
    const loader = useConversationLoader();
    const { activeRun, ui } = useAppState();
    const { dispatch } = useAppActions();
    return { loader, activeRun, ui, dispatch };
  }

  it("clears selection and shows a toast when detail id is invalid (422)", async () => {
    selectionStore.save("bad-id");
    const services = createFakeServices(
      {},
      {
        detail: async () => {
          throw new ApiError({ status: 422 });
        },
      },
    );
    const { result } = renderHook(() => useClearProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.loader.selectConversation("bad-id");
    });

    expect(result.current.loader.selectedId).toBeNull();
    expect(selectionStore.read()).toBeNull();
    expect(result.current.ui.toast?.message).toContain("会话 ID 无效");
  });

  it("clears the active run when selecting another conversation", async () => {
    const services = createFakeServices(
      {},
      { detail: async () => conversationDetailResponse },
    );
    const { result } = renderHook(() => useClearProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      result.current.dispatch({ type: "run/started", runId: "1", conversationId: "10" });
    });
    expect(result.current.activeRun).not.toBeNull();

    await act(async () => {
      await result.current.loader.selectConversation(conversationResponse.id);
    });
    expect(result.current.activeRun).toBeNull();
  });

  it("clears the active run on newConversation", async () => {
    const services = createFakeServices();
    const { result } = renderHook(() => useClearProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      result.current.dispatch({ type: "run/started", runId: "1", conversationId: "10" });
    });
    expect(result.current.activeRun).not.toBeNull();

    act(() => {
      result.current.loader.newConversation();
    });
    expect(result.current.activeRun).toBeNull();
  });
});

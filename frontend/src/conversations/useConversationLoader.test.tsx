import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { conversationDetailResponse, conversationResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { selectionStore } from "./selectionStore";
import { useConversationLoader } from "./useConversationLoader";

describe("useConversationLoader", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("loads the list", async () => {
    const services = createFakeServices({}, { list: async () => [conversationResponse] });
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.loadList();
    });

    expect(result.current.items).toEqual([conversationResponse]);
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

  it("clears selection when detail is forbidden (404)", async () => {
    selectionStore.save(999);
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
      await result.current.selectConversation(999);
    });

    expect(result.current.selectedId).toBeNull();
    expect(result.current.detailStatus).toBe("forbidden");
    expect(selectionStore.read()).toBeNull();
  });

  it("new conversation resets detail and clears persistence", async () => {
    selectionStore.save(5);
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
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppActions, useAppState } from "../app/context";
import type { ConversationResponse } from "../api/types";
import { sendMessageResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { webSearchPreferenceStore } from "../runs/webSearchPreference";
import { selectionStore } from "./selectionStore";
import { useSendMessage } from "./useSendMessage";

const draft: ConversationResponse = {
  id: "77",
  title: null,
  activated_at: null,
  created_at: "t",
  updated_at: "t",
};

type Start = (runId: string, conversationId: string, afterSeq: number) => void;

function useSendProbe(start: Start) {
  const send = useSendMessage(start);
  const { conversationIndex, conversationDetail, activeRun, ui } = useAppState();
  const { dispatch } = useAppActions();
  return { send, conversationIndex, conversationDetail, activeRun, ui, dispatch };
}

describe("useSendMessage", () => {
  beforeEach(() => {
    localStorage.clear();
    webSearchPreferenceStore.setCapability(false);
  });
  afterEach(() => {
    localStorage.clear();
    webSearchPreferenceStore.setCapability(false);
  });

  it("creates a draft conversation when none is selected", async () => {
    const start = vi.fn();
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { create, sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("你好");
    });

    expect(create).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("77", "你好", {
      thinking_enabled: false,
      web_search_enabled: false,
    });
    expect(result.current.conversationIndex.selectedId).toBe("77");
    expect(result.current.conversationIndex.draftId).toBe("77");
    expect(selectionStore.read()).toBe("77");
    expect(start).toHaveBeenCalledWith(sendMessageResponse.run.id, "77", 0);
    await waitFor(() =>
      expect(result.current.activeRun?.runId).toBe(sendMessageResponse.run.id),
    );
  });

  it("sends to the already-selected conversation without creating a draft", async () => {
    const start = vi.fn();
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { create, sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      result.current.dispatch({ type: "conversations/selected", id: "55" });
    });
    await act(async () => {
      await result.current.send("世界");
    });

    expect(create).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("55", "世界", {
      thinking_enabled: false,
      web_search_enabled: false,
    });
    expect(result.current.conversationDetail.messages.at(-1)).toEqual(
      sendMessageResponse.message,
    );
  });

  it("sends web_search_enabled true only when preference and capability are enabled", async () => {
    webSearchPreferenceStore.save(true);
    webSearchPreferenceStore.setCapability(true);
    const start = vi.fn();
    const sendMessage = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      result.current.dispatch({ type: "conversations/selected", id: "55" });
    });
    await act(async () => {
      await result.current.send("查一下最新版本");
    });

    expect(sendMessage).toHaveBeenCalledWith("55", "查一下最新版本", {
      thinking_enabled: false,
      web_search_enabled: true,
    });

    webSearchPreferenceStore.setCapability(false);
    await act(async () => {
      await result.current.send("再查一下");
    });

    expect(sendMessage).toHaveBeenLastCalledWith("55", "再查一下", {
      thinking_enabled: false,
      web_search_enabled: false,
    });
  });

  it("ignores empty content", async () => {
    const start = vi.fn();
    const sendMessage = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("   ");
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps state usable when sendMessage rejects", async () => {
    const start = vi.fn();
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => {
      throw new Error("network");
    });
    const services = createFakeServices({}, { create, sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("会失败");
    });

    expect(sendMessage).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(result.current.activeRun).toBeNull();
  });

  it("shows a toast when sendMessage rejects", async () => {
    const start = vi.fn();
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => {
      throw new Error("network");
    });
    const services = createFakeServices({}, { create, sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("会失败");
    });

    expect(result.current.ui.toast?.message).toBe("发送失败，请重试");
  });
});

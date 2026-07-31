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
  const {
    conversationIndex,
    conversationDetail,
    activeRun,
    pendingSubmission,
    ui,
  } = useAppState();
  const { dispatch } = useAppActions();
  return {
    send,
    conversationIndex,
    conversationDetail,
    activeRun,
    pendingSubmission,
    ui,
    dispatch,
  };
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
    const createWithMessage = vi.fn(async () => ({
      conversation: draft,
      ...sendMessageResponse,
    }));
    const services = createFakeServices({}, { create, createWithMessage, sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("你好");
    });

    expect(create).not.toHaveBeenCalled();
    expect(createWithMessage).toHaveBeenCalledWith("你好", {
      thinking_enabled: true,
      reasoning_effort: "low",
      web_search_enabled: false,
    });
    expect(sendMessage).not.toHaveBeenCalled();
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
      thinking_enabled: true,
      reasoning_effort: "low",
      web_search_enabled: false,
    });
    expect(result.current.conversationDetail.messages.at(-1)).toEqual(
      sendMessageResponse.message,
    );
  });

  it("exposes a pending submission until the send API resolves", async () => {
    const start = vi.fn();
    let resolveSend!: (value: typeof sendMessageResponse) => void;
    const sendMessage = vi.fn(
      () =>
        new Promise<typeof sendMessageResponse>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const services = createFakeServices({}, { sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      result.current.dispatch({ type: "conversations/selected", id: "55" });
    });

    let sendResult!: Promise<boolean>;
    await act(async () => {
      sendResult = result.current.send("世界");
      await Promise.resolve();
    });

    expect(result.current.pendingSubmission).toEqual({
      content: "世界",
      conversationId: "55",
    });
    expect(result.current.conversationDetail.messages).toEqual([]);
    expect(result.current.activeRun).toBeNull();

    let duplicateResult: boolean | undefined;
    await act(async () => {
      duplicateResult = await result.current.send("重复发送");
    });
    expect(duplicateResult).toBe(false);
    expect(sendMessage).toHaveBeenCalledOnce();

    await act(async () => {
      resolveSend(sendMessageResponse);
      await sendResult;
    });

    expect(await sendResult).toBe(true);
    expect(result.current.pendingSubmission).toBeNull();
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
      thinking_enabled: true,
      reasoning_effort: "low",
      web_search_enabled: true,
    });

    webSearchPreferenceStore.setCapability(false);
    await act(async () => {
      await result.current.send("再查一下");
    });

    expect(sendMessage).toHaveBeenLastCalledWith("55", "再查一下", {
      thinking_enabled: true,
      reasoning_effort: "low",
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
    const createWithMessage = vi.fn(async () => {
      throw new Error("network");
    });
    const services = createFakeServices({}, { createWithMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.send("会失败");
    });

    expect(createWithMessage).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(sent).toBe(false);
    expect(result.current.pendingSubmission).toBeNull();
    expect(result.current.activeRun).toBeNull();
  });

  it("shows a toast when sendMessage rejects", async () => {
    const start = vi.fn();
    const createWithMessage = vi.fn(async () => {
      throw new Error("network");
    });
    const services = createFakeServices({}, { createWithMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("会失败");
    });

    expect(result.current.ui.toast).toMatchObject({
      message: "发送失败，请重试",
      tone: "error",
    });
  });
});

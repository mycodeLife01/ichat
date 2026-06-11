import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAppActions, useAppState } from "../app/context";
import {
  conversationDetailResponse,
  conversationResponse,
  sendMessageResponse,
} from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { useRegenerate } from "./useRegenerate";

type Start = (runId: number, conversationId: number, afterSeq: number) => void;

function useRegenProbe(start: Start) {
  const { editAndRegenerate, regenerate } = useRegenerate(start);
  const { activeRun, conversationDetail, ui } = useAppState();
  const { dispatch } = useAppActions();
  return { editAndRegenerate, regenerate, activeRun, conversationDetail, ui, dispatch };
}

async function selectConversation(
  result: { current: ReturnType<typeof useRegenProbe> },
  id = conversationResponse.id,
) {
  await act(async () => {
    result.current.dispatch({ type: "conversations/selected", id });
  });
}

describe("useRegenerate", () => {
  it("edits a user message: calls API, refetches detail, starts the run", async () => {
    const start = vi.fn();
    const editAndRegenerate = vi.fn(async () => sendMessageResponse);
    const detail = vi.fn(async () => conversationDetailResponse);
    const services = createFakeServices({}, { editAndRegenerate, detail });
    const { result } = renderHook(() => useRegenProbe(start), {
      wrapper: makeWrapper(services),
    });
    await selectConversation(result);

    await act(async () => {
      await result.current.editAndRegenerate(501, "改写");
    });

    expect(editAndRegenerate).toHaveBeenCalledWith(conversationResponse.id, 501, "改写", {
      thinking_enabled: false,
    });
    expect(detail).toHaveBeenCalledWith(conversationResponse.id);
    expect(result.current.conversationDetail.messages).toEqual(
      conversationDetailResponse.messages,
    );
    expect(result.current.activeRun?.runId).toBe(sendMessageResponse.run.id);
    expect(start).toHaveBeenCalledWith(sendMessageResponse.run.id, conversationResponse.id, 0);
  });

  it("regenerates an assistant message: calls API, refetches detail, starts the run", async () => {
    const start = vi.fn();
    const regenerate = vi.fn(async () => sendMessageResponse);
    const detail = vi.fn(async () => conversationDetailResponse);
    const services = createFakeServices({}, { regenerate, detail });
    const { result } = renderHook(() => useRegenProbe(start), {
      wrapper: makeWrapper(services),
    });
    await selectConversation(result);

    await act(async () => {
      await result.current.regenerate(2);
    });

    expect(regenerate).toHaveBeenCalledWith(conversationResponse.id, 2, {
      thinking_enabled: false,
    });
    expect(detail).toHaveBeenCalledWith(conversationResponse.id);
    expect(start).toHaveBeenCalledWith(sendMessageResponse.run.id, conversationResponse.id, 0);
  });

  it("ignores empty edit content and no selection", async () => {
    const start = vi.fn();
    const editAndRegenerate = vi.fn(async () => sendMessageResponse);
    const regenerate = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { editAndRegenerate, regenerate });
    const { result } = renderHook(() => useRegenProbe(start), {
      wrapper: makeWrapper(services),
    });

    // No selection yet → regenerate is a no-op.
    await act(async () => {
      await result.current.regenerate(2);
    });
    expect(regenerate).not.toHaveBeenCalled();

    await selectConversation(result);
    await act(async () => {
      await result.current.editAndRegenerate(501, "   ");
    });
    expect(editAndRegenerate).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps state usable when the API rejects", async () => {
    const start = vi.fn();
    const regenerate = vi.fn(async () => {
      throw new Error("409 active run");
    });
    const services = createFakeServices({}, { regenerate });
    const { result } = renderHook(() => useRegenProbe(start), {
      wrapper: makeWrapper(services),
    });
    await selectConversation(result);

    await act(async () => {
      await result.current.regenerate(2);
    });

    expect(regenerate).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(result.current.activeRun).toBeNull();
  });

  it("shows a toast when the API rejects", async () => {
    const start = vi.fn();
    const regenerate = vi.fn(async () => {
      throw new Error("409 active run");
    });
    const services = createFakeServices({}, { regenerate });
    const { result } = renderHook(() => useRegenProbe(start), {
      wrapper: makeWrapper(services),
    });
    await selectConversation(result);

    await act(async () => {
      await result.current.regenerate(2);
    });

    expect(result.current.ui.toast?.message).toBe("操作失败，请重试");
  });
});

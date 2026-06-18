import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationDetailResponse } from "../api/types";
import { useAppActions, useAppState, type Services } from "../app/context";
import {
  conversationDetailResponse,
  conversationResponse,
  runStateResponse,
  sendMessageResponse,
} from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { useRunRecovery } from "./useRunRecovery";

type Start = (runId: string, conversationId: string, afterSeq: number) => void;

function useRecoveryProbe(start: Start) {
  const recover = useRunRecovery(start);
  const { activeRun, conversationDetail } = useAppState();
  const { dispatch } = useAppActions();
  return { recover, activeRun, conversationDetail, dispatch };
}

const materializedDetail: ConversationDetailResponse = {
  ...conversationResponse,
  messages: [
    sendMessageResponse.message,
    {
      id: "502",
      conversation_id: conversationResponse.id,
      run_id: "100",
      role: "assistant",
      content: "Hi there",
      reasoning: null,
      position: 2,
      created_at: "t",
    },
  ],
};

function setup(start: Start, services: Services) {
  const rendered = renderHook(() => useRecoveryProbe(start), {
    wrapper: makeWrapper(services),
  });
  return rendered;
}

async function enterConversation(
  result: { current: ReturnType<typeof useRecoveryProbe> },
  detail: ConversationDetailResponse = conversationDetailResponse,
) {
  await act(async () => {
    result.current.dispatch({ type: "conversations/selected", id: detail.id });
    const { messages, ...conversation } = detail;
    result.current.dispatch({ type: "conversations/detailLoaded", conversation, messages });
  });
}

describe("useRunRecovery", () => {
  it("does nothing when the thread has no pending run", async () => {
    const start = vi.fn();
    const state = vi.fn(async () => runStateResponse);
    const { result } = setup(start, createFakeServices({}, {}, { state }));

    await enterConversation(result, materializedDetail);
    await act(async () => {
      await result.current.recover(conversationResponse.id);
    });

    expect(state).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(result.current.activeRun).toBeNull();
  });

  it("restores and resumes an in-progress run", async () => {
    const start = vi.fn();
    const state = vi.fn(async () => ({
      ...runStateResponse,
      draft_reasoning: "想",
    }));
    const { result } = setup(start, createFakeServices({}, {}, { state }));

    await enterConversation(result);
    await act(async () => {
      await result.current.recover(conversationResponse.id);
    });

    expect(state).toHaveBeenCalledWith("100");
    expect(result.current.activeRun).toEqual({
      runId: "100",
      conversationId: conversationResponse.id,
      latestSeq: runStateResponse.latest_seq,
      draftText: runStateResponse.draft_text,
      draftReasoning: "想",
      toolState: null,
      status: "streaming",
      cancelRequested: false,
    });
    expect(start).toHaveBeenCalledWith(
      "100",
      conversationResponse.id,
      runStateResponse.latest_seq,
    );
  });

  it("restores the partial without resuming for a terminal run", async () => {
    const start = vi.fn();
    const state = vi.fn(async () => ({
      ...runStateResponse,
      status: "cancelled" as const,
      terminal_event: {
        seq: 9,
        type: "run_cancelled" as const,
        payload: {},
        created_at: "t",
      },
    }));
    const { result } = setup(start, createFakeServices({}, {}, { state }));

    await enterConversation(result);
    await act(async () => {
      await result.current.recover(conversationResponse.id);
    });

    expect(result.current.activeRun?.status).toBe("cancelled");
    expect(result.current.activeRun?.draftText).toBe(runStateResponse.draft_text);
    expect(start).not.toHaveBeenCalled();
  });

  it("refetches detail when the run already succeeded", async () => {
    const start = vi.fn();
    const state = vi.fn(async () => ({
      ...runStateResponse,
      status: "succeeded" as const,
    }));
    const detail = vi.fn(async () => materializedDetail);
    const list = vi.fn(async () => [conversationResponse]);
    const { result } = setup(start, createFakeServices({}, { detail, list }, { state }));

    await enterConversation(result);
    await act(async () => {
      await result.current.recover(conversationResponse.id);
    });

    expect(detail).toHaveBeenCalledWith(conversationResponse.id);
    expect(list).toHaveBeenCalled();
    expect(result.current.conversationDetail.messages).toEqual(materializedDetail.messages);
    expect(result.current.activeRun).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("stays silent when the state call fails", async () => {
    const start = vi.fn();
    const state = vi.fn(async () => {
      throw new Error("network");
    });
    const { result } = setup(start, createFakeServices({}, {}, { state }));

    await enterConversation(result);
    await act(async () => {
      await result.current.recover(conversationResponse.id);
    });

    expect(result.current.activeRun).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("skips when a run is already attached to this conversation", async () => {
    const start = vi.fn();
    const state = vi.fn(async () => runStateResponse);
    const { result } = setup(start, createFakeServices({}, {}, { state }));

    await enterConversation(result);
    await act(async () => {
      result.current.dispatch({
        type: "run/started",
        runId: "100",
        conversationId: conversationResponse.id,
      });
    });
    await act(async () => {
      await result.current.recover(conversationResponse.id);
    });

    expect(state).not.toHaveBeenCalled();
  });

  it("skips when the loaded detail belongs to another conversation", async () => {
    const start = vi.fn();
    const state = vi.fn(async () => runStateResponse);
    const { result } = setup(start, createFakeServices({}, {}, { state }));

    await enterConversation(result);
    await act(async () => {
      await result.current.recover("999");
    });

    expect(state).not.toHaveBeenCalled();
  });
});

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationDetailResponse,
  ConversationResponse,
  MessageResponse,
  RunResponse,
  SendMessageResponse,
} from "../api/types";
import {
  conversationDetailResponse,
  conversationResponse,
  reasoningDeltaEvent,
  runStateResponse,
  succeededEvent,
  textDeltaEvent,
} from "../test/apiFixtures";
import { selectionStore } from "../conversations/selectionStore";
import { createFakeServices, fakeStream, renderWithApp } from "../test/appHarness";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("loads and lists conversations on mount", async () => {
    const services = createFakeServices(
      {},
      { list: async () => [conversationResponse] },
    );
    renderWithApp(<AppShell />, services);

    expect(await screen.findByText(conversationResponse.title as string)).toBeInTheDocument();
  });

  it("loads detail when a conversation is selected", async () => {
    // A thread at rest: the run has a materialized reply, so entry triggers no recovery.
    const services = createFakeServices(
      {},
      {
        list: async () => [conversationResponse],
        detail: async () => ({
          ...conversationDetailResponse,
          messages: [
            ...conversationDetailResponse.messages,
            {
              id: 502,
              conversation_id: conversationResponse.id,
              run_id: 100,
              role: "assistant" as const,
              content: "Hi!",
              reasoning: null,
              position: 2,
              created_at: "t",
            },
          ],
        }),
      },
    );
    const user = userEvent.setup();
    renderWithApp(<AppShell />, services);

    await user.click(await screen.findByText(conversationResponse.title as string));

    // user message content from the detail fixture
    expect(await screen.findByText("Hello")).toBeInTheDocument();
  });

  it("shows the welcome heading in the empty state", async () => {
    const services = createFakeServices({}, { list: async () => [] });
    renderWithApp(<AppShell />, services);

    expect(await screen.findByText("我们先从哪里开始呢？")).toBeInTheDocument();
  });

  it("sends a message and replaces the stream with the server reply", async () => {
    const user = userEvent.setup();

    const draft: ConversationResponse = {
      id: 77, title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: 1, conversation_id: 77, run_id: 100, role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const assistantMessage: MessageResponse = {
      id: 2, conversation_id: 77, run_id: 100, role: "assistant",
      content: "你好呀", reasoning: null, position: 2, created_at: "t",
    };
    const run: RunResponse = {
      id: 100, conversation_id: 77, user_message_id: 1, status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    const sent: SendMessageResponse = { message: userMessage, run };
    const serverDetail: ConversationDetailResponse = {
      ...draft, activated_at: "t", title: "新对话",
      messages: [userMessage, assistantMessage],
    };

    const services = createFakeServices(
      {},
      {
        list: async () => [],
        create: async () => draft,
        detail: async () => serverDetail,
        sendMessage: async () => sent,
      },
      {
        streamEvents: () =>
          fakeStream([
            { ...reasoningDeltaEvent, seq: 1 },
            { ...textDeltaEvent, seq: 2, payload: { text: "你好" } },
            { ...succeededEvent, seq: 3 },
          ]),
      },
    );

    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // Server-materialized assistant reply replaces the streamed draft.
    await waitFor(() => expect(screen.getByText("你好呀")).toBeInTheDocument());
    expect(screen.getByText("你好")).toBeInTheDocument();
    // Back to idle: send button returns.
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  it("swaps the send button for the demo stop button while streaming", async () => {
    const user = userEvent.setup();

    const draft: ConversationResponse = {
      id: 77, title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: 1, conversation_id: 77, run_id: 100, role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const run: RunResponse = {
      id: 100, conversation_id: 77, user_message_id: 1, status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    const sent: SendMessageResponse = { message: userMessage, run };

    const services = createFakeServices(
      {},
      { list: async () => [], create: async () => draft, sendMessage: async () => sent },
      {
        // No terminal event: the run stays "streaming", so the stop button is stable.
        streamEvents: () =>
          fakeStream([{ ...textDeltaEvent, seq: 1, payload: { text: "你好" } }]),
      },
    );

    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止生成" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("restores a stopped run's partial after refresh", async () => {
    selectionStore.save(conversationResponse.id);
    const streamEvents = vi.fn(() => fakeStream([]));
    const services = createFakeServices(
      {},
      {
        list: async () => [conversationResponse],
        detail: async () => conversationDetailResponse,
      },
      {
        state: async () => ({
          ...runStateResponse,
          status: "cancelled" as const,
          draft_text: "写到一半",
          terminal_event: {
            seq: 9,
            type: "run_cancelled" as const,
            payload: {},
            created_at: "t",
          },
        }),
        streamEvents,
      },
    );

    const { container } = renderWithApp(<AppShell />, services);

    expect(await screen.findByText("写到一半")).toBeInTheDocument();
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(container.querySelector(".status-pill.stopped")).toBeTruthy();
    expect(streamEvents).not.toHaveBeenCalled();
  });

  it("resumes an in-progress run after refresh and replaces it with the reply", async () => {
    selectionStore.save(conversationResponse.id);
    const assistantMessage: MessageResponse = {
      id: 502,
      conversation_id: conversationResponse.id,
      run_id: 100,
      role: "assistant",
      content: "Hello there!",
      reasoning: null,
      position: 2,
      created_at: "t",
    };
    const materializedDetail: ConversationDetailResponse = {
      ...conversationResponse,
      messages: [...conversationDetailResponse.messages, assistantMessage],
    };
    const detail = vi
      .fn()
      .mockResolvedValueOnce(conversationDetailResponse)
      .mockResolvedValue(materializedDetail);
    const streamEvents = vi.fn(() =>
      fakeStream([
        { ...textDeltaEvent, seq: 2, payload: { text: "lo" } },
        { ...succeededEvent, seq: 3 },
      ]),
    );
    const services = createFakeServices(
      {},
      { list: async () => [conversationResponse], detail },
      {
        state: async () => ({ ...runStateResponse, draft_text: "Hel", latest_seq: 1 }),
        streamEvents,
      },
    );

    renderWithApp(<AppShell />, services);

    // Resumes from the server-provided cursor, not from the beginning.
    await waitFor(() => expect(streamEvents).toHaveBeenCalled());
    expect(streamEvents.mock.calls[0]).toEqual([100, 1, expect.anything()]);
    // Terminal success swaps in the materialized assistant reply.
    expect(await screen.findByText("Hello there!")).toBeInTheDocument();
  });
});

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  succeededEvent,
  textDeltaEvent,
} from "../test/apiFixtures";
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
    const services = createFakeServices(
      {},
      {
        list: async () => [conversationResponse],
        detail: async () => conversationDetailResponse,
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
});

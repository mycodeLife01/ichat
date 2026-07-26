import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocation, useNavigate } from "react-router-dom";

import { ApiError } from "../api/errors";
import type {
  AuthUserResponse,
  ConversationDetailResponse,
  ConversationResponse,
  MessageResponse,
  RunResponse,
  SendMessageResponse,
} from "../api/types";
import {
  authTokenResponse,
  conversationDetailResponse,
  conversationResponse,
  reasoningDeltaEvent,
  runStateResponse,
  succeededEvent,
  textDeltaEvent,
} from "../test/apiFixtures";
import { selectionStore } from "../conversations/selectionStore";
import { createAuthSession, tokenStore } from "../auth/tokenStore";
import { createFakeServices, fakeStream, renderWithApp } from "../test/appHarness";
import { AppShell } from "./AppShell";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function NavigateProbe({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>Go invalid</button>;
}

describe("AppShell", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("loads and lists conversations on mount", async () => {
    const list = vi.fn(async () => [conversationResponse]);
    const services = createFakeServices(
      {},
      { list },
    );
    renderWithApp(<AppShell />, services);

    expect(await screen.findByText(conversationResponse.title as string)).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith({ limit: 30, skip: 0 });
  });

  it("passes username to the account card without showing it in the user menu", async () => {
    const accountUser: AuthUserResponse = {
      ...authTokenResponse.user,
      username: "alice-login",
      nickname: "Alice Cooper",
      email_verified: true,
    };
    tokenStore.save(
      createAuthSession({
        ...authTokenResponse,
        user: accountUser,
      }),
    );
    const services = createFakeServices(
      { me: async () => accountUser },
      { list: async () => [] },
    );
    const user = userEvent.setup();
    renderWithApp(<AppShell />, services);

    const trigger = await screen.findByRole("button", { name: "打开个人中心" });
    expect(within(trigger).getByText("Alice Cooper")).toBeInTheDocument();
    expect(within(trigger).getByText("Pro")).toBeInTheDocument();
    expect(within(trigger).queryByText("alice-login")).toBeNull();

    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "个人中心" });
    expect(within(menu).queryByText("用户名")).toBeNull();
    expect(within(menu).queryByText("alice-login")).toBeNull();

    await user.click(within(menu).getByRole("menuitem", { name: "账号" }));
    const dialog = screen.getByRole("dialog", { name: "账号" });
    expect(within(dialog).getByText("alice-login")).toBeInTheDocument();
    expect(within(dialog).getByText("用户名 · 不可修改")).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox", { name: "用户名" })).toBeNull();
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
              id: "502",
              conversation_id: conversationResponse.id,
              run_id: "100",
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

  it("loads the conversation named in the URL on a deep link", async () => {
    // Entering directly at /c/:publicId (copy-pasted/bookmarked link) must load
    // that conversation, not fall back to the blank new-chat state. Settled
    // thread (assistant reply present) so entry triggers no run recovery.
    const services = createFakeServices(
      {},
      {
        list: async () => [conversationResponse],
        detail: async () => ({
          ...conversationDetailResponse,
          messages: [
            ...conversationDetailResponse.messages,
            {
              id: "502",
              conversation_id: conversationResponse.id,
              run_id: "100",
              role: "assistant" as const,
              content: "Deep linked reply",
              reasoning: null,
              position: 2,
              created_at: "t",
            },
          ],
        }),
      },
    );
    renderWithApp(<AppShell />, services, undefined, [`/c/${conversationResponse.id}`]);

    // The deep-linked thread renders. If the URL→state sync regressed and reset
    // to "/", newConversation would clear detail and this reply would be absent.
    expect(await screen.findByText("Deep linked reply")).toBeInTheDocument();
  });

  it("clears an invalid URL conversation id before sending", async () => {
    const user = userEvent.setup();
    const currentAssistant: MessageResponse = {
      id: "502",
      conversation_id: conversationResponse.id,
      run_id: "100",
      role: "assistant",
      content: "Current reply",
      reasoning: null,
      position: 2,
      created_at: "t",
    };
    const draft: ConversationResponse = {
      id: "77", title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: "1", conversation_id: "77", run_id: "100", role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const run: RunResponse = {
      id: "100", conversation_id: "77", user_message_id: "1", status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => ({ message: userMessage, run }));
    const detail = vi.fn(async (id: string) => {
      if (id === conversationResponse.id) {
        return {
          ...conversationDetailResponse,
          messages: [...conversationDetailResponse.messages, currentAssistant],
        };
      }
      throw new ApiError({ status: 422 });
    });
    const services = createFakeServices(
      {},
      {
        list: async () => [conversationResponse],
        detail,
        create,
        sendMessage,
      },
      { streamEvents: () => fakeStream([]) },
    );

    renderWithApp(
      <>
        <AppShell />
        <LocationProbe />
        <NavigateProbe to="/c/not-a-uuid" />
      </>,
      services,
      undefined,
      [`/c/${conversationResponse.id}`],
    );

    expect(await screen.findByText("Current reply")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go invalid" }));

    await waitFor(() => expect(detail).toHaveBeenLastCalledWith("not-a-uuid"));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/"));
    expect(await screen.findByRole("status")).toHaveTextContent("会话 ID 无效");

    const textarea = screen.getByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(create).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("77", "你好", {
      thinking_enabled: false,
      web_search_enabled: false,
    });
  });

  it("shows the welcome heading in the empty state", async () => {
    const services = createFakeServices({}, { list: async () => [] });
    renderWithApp(<AppShell />, services);

    expect(await screen.findByText("我们先从哪里开始呢？")).toBeInTheDocument();
  });

  it("opens the root URL as a blank new conversation even with a stored selection", async () => {
    selectionStore.save(conversationResponse.id);
    const detail = vi.fn(async () => conversationDetailResponse);
    const services = createFakeServices(
      {},
      { list: async () => [conversationResponse], detail },
    );

    renderWithApp(
      <>
        <AppShell />
        <LocationProbe />
      </>,
      services,
    );

    expect(await screen.findByText("我们先从哪里开始呢？")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(detail).not.toHaveBeenCalled();
  });

  it("sends a message and replaces the stream with the server reply", async () => {
    const user = userEvent.setup();

    const draft: ConversationResponse = {
      id: "77", title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: "1", conversation_id: "77", run_id: "100", role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const assistantMessage: MessageResponse = {
      id: "2", conversation_id: "77", run_id: "100", role: "assistant",
      content: "你好呀", reasoning: null, position: 2, created_at: "t",
    };
    const run: RunResponse = {
      id: "100", conversation_id: "77", user_message_id: "1", status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    const sent: SendMessageResponse = { message: userMessage, run };
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(sent)
      .mockImplementationOnce(() => new Promise<SendMessageResponse>(() => {}));
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
        sendMessage,
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
    const transitionEnd = new Event("transitionend", { bubbles: true });
    Object.defineProperty(transitionEnd, "propertyName", { value: "flex-grow" });
    fireEvent(screen.getByRole("main"), transitionEnd);

    await user.type(textarea, "第二条");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const thinking = await screen.findByText("正在思考");
    expect(thinking.closest("main")).not.toHaveClass("composer-animate");
  });

  it("shows the optimistic turn while the send API is pending", async () => {
    const user = userEvent.setup();
    const draft: ConversationResponse = {
      id: "77", title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const sendMessage = vi.fn(
      () => new Promise<SendMessageResponse>(() => {}),
    );
    const services = createFakeServices(
      {},
      { list: async () => [], create: async () => draft, sendMessage },
    );

    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("你好")).toBeInTheDocument();
    expect(screen.getByText("正在思考")).toBeInTheDocument();
    const submitting = screen.getByRole("button", { name: "发送中" });
    expect(submitting).toBeDisabled();
    expect(submitting).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  });

  it("preserves the thinking status node when the pending submission becomes a run", async () => {
    const user = userEvent.setup();
    const draft: ConversationResponse = {
      id: "77", title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: "1", conversation_id: "77", run_id: "100", role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const run: RunResponse = {
      id: "100", conversation_id: "77", user_message_id: "1", status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    let resolveSend: ((value: SendMessageResponse) => void) | undefined;
    const sendMessage = vi.fn(
      () =>
        new Promise<SendMessageResponse>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const services = createFakeServices(
      {},
      { list: async () => [], create: async () => draft, sendMessage },
      { streamEvents: () => fakeStream([]) },
    );

    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    const pendingThinking = await screen.findByText("正在思考");

    expect(resolveSend).toBeDefined();
    resolveSend?.({ message: userMessage, run });
    await screen.findByRole("button", { name: "停止生成" });

    expect(screen.getByText("正在思考")).toBe(pendingThinking);
  });

  it("restores the submitted text when sending fails", async () => {
    const user = userEvent.setup();
    const services = createFakeServices(
      {},
      {
        list: async () => [],
        create: async () => ({
          id: "77", title: null, activated_at: null, created_at: "t", updated_at: "t",
        }),
        sendMessage: async () => {
          throw new Error("network");
        },
      },
    );
    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "请再试一次");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("发送失败，请重试");
    await waitFor(() => expect(textarea).toHaveValue("请再试一次"));
    expect(screen.queryByText("正在思考")).toBeNull();
  });

  it("swaps the send button for the demo stop button while streaming", async () => {
    const user = userEvent.setup();

    const draft: ConversationResponse = {
      id: "77", title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: "1", conversation_id: "77", run_id: "100", role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const run: RunResponse = {
      id: "100", conversation_id: "77", user_message_id: "1", status: "streaming",
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

  it("returns the composer to idle after a stop completes", async () => {
    const user = userEvent.setup();

    const draft: ConversationResponse = {
      id: "77", title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: "1", conversation_id: "77", run_id: "100", role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const run: RunResponse = {
      id: "100", conversation_id: "77", user_message_id: "1", status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    const sent: SendMessageResponse = { message: userMessage, run };

    // The stream stalls after the first delta until cancel is requested, then
    // delivers the server's run_cancelled terminal — the real stop sequence.
    let releaseCancel = () => {};
    const cancelRequested = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    async function* stream() {
      yield { seq: 1, type: "text_delta" as const, data: { ...textDeltaEvent, seq: 1 } };
      await cancelRequested;
      yield {
        seq: 2,
        type: "run_cancelled" as const,
        data: { seq: 2, type: "run_cancelled" as const, payload: {}, created_at: "t" },
      };
    }
    const services = createFakeServices(
      {},
      { list: async () => [], create: async () => draft, sendMessage: async () => sent },
      {
        streamEvents: () => stream(),
        cancel: async () => {
          releaseCancel();
          return { status: "ok" };
        },
      },
    );

    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await user.click(await screen.findByRole("button", { name: "停止生成" }));

    // Terminal arrived: the partial stays without a stopped-status block, and
    // the composer is usable again — not stuck on a disabled "停止中" button.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("已停止")).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  it("restores a stopped run's partial after refresh", async () => {
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

    renderWithApp(
      <AppShell />,
      services,
      undefined,
      [`/c/${conversationResponse.id}`],
    );

    expect(await screen.findByText("写到一半")).toBeInTheDocument();
    expect(screen.queryByText("已停止")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(streamEvents).not.toHaveBeenCalled();
  });

  it("resumes an in-progress run after refresh and replaces it with the reply", async () => {
    const assistantMessage: MessageResponse = {
      id: "502",
      conversation_id: conversationResponse.id,
      run_id: "100",
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

    renderWithApp(<AppShell />, services, undefined, [`/c/${conversationResponse.id}`]);

    // Resumes from the server-provided cursor, not from the beginning.
    await waitFor(() => expect(streamEvents).toHaveBeenCalled());
    expect(streamEvents.mock.calls[0]).toEqual(["100", 1, expect.anything()]);
    // Terminal success swaps in the materialized assistant reply.
    expect(await screen.findByText("Hello there!")).toBeInTheDocument();
  });

  it("edits a user message and streams the regenerated reply", async () => {
    const titled = { ...conversationResponse, title: "对话A" };
    const userMsg: MessageResponse = {
      id: "1", conversation_id: conversationResponse.id, run_id: "100", role: "user",
      content: "原问题", reasoning: null, position: 1, created_at: "t",
    };
    const assistantMsg: MessageResponse = {
      id: "2", conversation_id: conversationResponse.id, run_id: "100", role: "assistant",
      content: "旧答案", reasoning: null, position: 2, created_at: "t",
    };
    const editedUser: MessageResponse = { ...userMsg, id: "3", content: "新问题", run_id: "101" };
    const newAssistant: MessageResponse = { ...assistantMsg, id: "4", content: "新答案", run_id: "101" };
    const newRun: RunResponse = {
      id: "101", conversation_id: conversationResponse.id, user_message_id: "3", status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };

    const detail = vi
      .fn()
      .mockResolvedValueOnce({ ...titled, messages: [userMsg, assistantMsg] }) // initial select
      .mockResolvedValueOnce({ ...titled, messages: [editedUser] }) // post-edit truncated
      .mockResolvedValue({ ...titled, messages: [editedUser, newAssistant] }); // post-success
    const editAndRegenerate = vi.fn(async () => ({ message: editedUser, run: newRun }));
    const services = createFakeServices(
      {},
      { list: async () => [titled], detail, editAndRegenerate },
      { streamEvents: () => fakeStream([{ ...textDeltaEvent, seq: 1, payload: { text: "新答案" } }, { ...succeededEvent, seq: 2 }]) },
    );
    const user = userEvent.setup();
    renderWithApp(<AppShell />, services, undefined, [`/c/${conversationResponse.id}`]);

    expect(await screen.findByText("旧答案")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    const editor = screen.getByDisplayValue("原问题");
    await user.clear(editor);
    await user.type(editor, "新问题");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(editAndRegenerate).toHaveBeenCalledWith(conversationResponse.id, "1", "新问题", {
      thinking_enabled: false,
      web_search_enabled: false,
    });
    // Old answer truncated away; the regenerated answer streams in and replaces.
    expect(await screen.findByText("新答案")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("旧答案")).toBeNull());
  });

  it("regenerates an assistant reply", async () => {
    const titled = { ...conversationResponse, title: "对话A" };
    const userMsg: MessageResponse = {
      id: "1", conversation_id: conversationResponse.id, run_id: "100", role: "user",
      content: "问题", reasoning: null, position: 1, created_at: "t",
    };
    const oldAssistant: MessageResponse = {
      id: "2", conversation_id: conversationResponse.id, run_id: "100", role: "assistant",
      content: "第一版答案", reasoning: null, position: 2, created_at: "t",
    };
    const newAssistant: MessageResponse = { ...oldAssistant, id: "3", content: "第二版答案", run_id: "101" };
    const newRun: RunResponse = {
      id: "101", conversation_id: conversationResponse.id, user_message_id: "1", status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };

    const detail = vi
      .fn()
      .mockResolvedValueOnce({ ...titled, messages: [userMsg, oldAssistant] }) // initial
      .mockResolvedValueOnce({ ...titled, messages: [userMsg] }) // post-regenerate truncated
      .mockResolvedValue({ ...titled, messages: [userMsg, newAssistant] }); // post-success
    const regenerate = vi.fn(async () => ({ message: userMsg, run: newRun }));
    const services = createFakeServices(
      {},
      { list: async () => [titled], detail, regenerate },
      { streamEvents: () => fakeStream([{ ...textDeltaEvent, seq: 1, payload: { text: "第二版答案" } }, { ...succeededEvent, seq: 2 }]) },
    );
    const user = userEvent.setup();
    renderWithApp(<AppShell />, services, undefined, [`/c/${conversationResponse.id}`]);

    expect(await screen.findByText("第一版答案")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /重新生成/ }));

    expect(regenerate).toHaveBeenCalledWith(conversationResponse.id, "2", {
      thinking_enabled: false,
      web_search_enabled: false,
    });
    expect(await screen.findByText("第二版答案")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("第一版答案")).toBeNull());
  });

  it("disables the mutate buttons while a run is streaming", async () => {
    const draft: ConversationResponse = {
      id: "77", title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: "1", conversation_id: "77", run_id: "100", role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const run: RunResponse = {
      id: "100", conversation_id: "77", user_message_id: "1", status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    const services = createFakeServices(
      {},
      { list: async () => [], create: async () => draft, sendMessage: async () => ({ message: userMessage, run }) },
      { streamEvents: () => fakeStream([{ ...textDeltaEvent, seq: 1, payload: { text: "正在回答" } }]) }, // no terminal: stays streaming
    );
    const user = userEvent.setup();
    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // The just-sent user message is in the thread; its edit button is disabled.
    const sentMsg = (await screen.findByText("你好")).closest(".msg") as HTMLElement;
    await waitFor(() => {
      expect(within(sentMsg).getByRole("button", { name: "编辑并重发" })).toBeDisabled();
    });
  });

  it("re-enables the mutate buttons after a stop completes", async () => {
    const user = userEvent.setup();

    const draft: ConversationResponse = {
      id: "77", title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: "1", conversation_id: "77", run_id: "100", role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const run: RunResponse = {
      id: "100", conversation_id: "77", user_message_id: "1", status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    const sent: SendMessageResponse = { message: userMessage, run };

    // Same stop sequence as the composer test: stall after the first delta
    // until cancel, then deliver the server's run_cancelled terminal.
    let releaseCancel = () => {};
    const cancelRequested = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    async function* stream() {
      yield { seq: 1, type: "text_delta" as const, data: { ...textDeltaEvent, seq: 1 } };
      await cancelRequested;
      yield {
        seq: 2,
        type: "run_cancelled" as const,
        data: { seq: 2, type: "run_cancelled" as const, payload: {}, created_at: "t" },
      };
    }
    const services = createFakeServices(
      {},
      { list: async () => [], create: async () => draft, sendMessage: async () => sent },
      {
        streamEvents: () => stream(),
        cancel: async () => {
          releaseCancel();
          return { status: "ok" };
        },
      },
    );

    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(await screen.findByRole("button", { name: "停止生成" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("已停止")).toBeNull();
    // The run is terminal: editing the user message must be allowed again.
    const sentMsg = screen.getByText("你好").closest(".msg") as HTMLElement;
    expect(within(sentMsg).getByRole("button", { name: "编辑并重发" })).toBeEnabled();
  });

  it("scrolls the thread to the bottom after sending into an existing conversation", async () => {
    // Existing conversation (id unchanged on send): the scroll must be forced
    // by the new user message itself, not by the enter-conversation jump.
    const titled = { ...conversationResponse, title: "对话A" };
    const oldUser: MessageResponse = {
      id: "1", conversation_id: titled.id, run_id: "99", role: "user",
      content: "旧问题", reasoning: null, position: 1, created_at: "t",
    };
    const oldAssistant: MessageResponse = {
      id: "2", conversation_id: titled.id, run_id: "99", role: "assistant",
      content: "旧答案", reasoning: null, position: 2, created_at: "t",
    };
    const newUser: MessageResponse = {
      id: "3", conversation_id: titled.id, run_id: "100", role: "user",
      content: "新问题", reasoning: null, position: 3, created_at: "t",
    };
    const run: RunResponse = {
      id: "100", conversation_id: titled.id, user_message_id: "3", status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    const services = createFakeServices(
      {},
      {
        list: async () => [titled],
        detail: async () => ({ ...titled, messages: [oldUser, oldAssistant] }),
        sendMessage: async () => ({ message: newUser, run }),
      },
      { streamEvents: () => fakeStream([]) },
    );
    const user = userEvent.setup();
    const { container } = renderWithApp(
      <AppShell />,
      services,
      undefined,
      [`/c/${conversationResponse.id}`],
    );

    await screen.findByText("旧答案");

    // jsdom has no layout: give the scroll container a fake height and park the
    // scrollbar far from the bottom, so only a forced scroll can move it.
    const region = container.querySelector(".thread-region") as HTMLElement;
    Object.defineProperty(region, "scrollHeight", { value: 1000, configurable: true });
    region.scrollTop = 200;

    const textarea = screen.getByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "新问题");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("新问题");
    await waitFor(() => expect(region.scrollTop).toBe(1000));
  });

  it("keeps the thinking label stable while reasoning grows", async () => {
    const titled = { ...conversationResponse, title: "对话A" };
    const oldUser: MessageResponse = {
      id: "1", conversation_id: titled.id, run_id: "99", role: "user",
      content: "旧问题", reasoning: null, position: 1, created_at: "t",
    };
    const oldAssistant: MessageResponse = {
      id: "2", conversation_id: titled.id, run_id: "99", role: "assistant",
      content: "旧答案", reasoning: null, position: 2, created_at: "t",
    };
    const newUser: MessageResponse = {
      id: "3", conversation_id: titled.id, run_id: "100", role: "user",
      content: "新问题", reasoning: null, position: 3, created_at: "t",
    };
    const run: RunResponse = {
      id: "100", conversation_id: titled.id, user_message_id: "3", status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    let releaseReasoning = () => {};
    const reasoningReady = new Promise<void>((resolve) => {
      releaseReasoning = resolve;
    });
    const services = createFakeServices(
      {},
      {
        list: async () => [titled],
        detail: async () => ({ ...titled, messages: [oldUser, oldAssistant] }),
        sendMessage: async () => ({ message: newUser, run }),
      },
      {
        streamEvents: async function* () {
          await reasoningReady;
          const data = {
            ...reasoningDeltaEvent,
            seq: 1,
            payload: { text: "新增推理" },
          };
          yield { seq: data.seq, type: data.type, data };
          await new Promise(() => {});
        },
      },
    );
    const user = userEvent.setup();
    const { container } = renderWithApp(
      <AppShell />,
      services,
      undefined,
      [`/c/${conversationResponse.id}`],
    );

    await screen.findByText("旧答案");
    const region = container.querySelector(".thread-region") as HTMLElement;
    let scrollHeight = 1000;
    Object.defineProperty(region, "scrollHeight", {
      get: () => scrollHeight,
      configurable: true,
    });

    const textarea = screen.getByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "新问题");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("正在思考");
    await waitFor(() => expect(region.scrollTop).toBe(1000));

    scrollHeight = 1200;
    releaseReasoning();
    await screen.findByText("新增推理");

    expect(region.scrollTop).toBe(1000);
  });

  it("surfaces a toast when sending fails", async () => {
    const services = createFakeServices(
      {},
      {
        list: async () => [],
        create: async () => ({
          id: "77", title: null, activated_at: null, created_at: "t", updated_at: "t",
        }),
        sendMessage: async () => {
          throw new Error("network");
        },
      },
    );
    const user = userEvent.setup();
    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const toast = await screen.findByRole("alert");
    expect(toast).toHaveTextContent("发送失败，请重试");
    expect(toast).toHaveAttribute("data-tone", "error");
    expect(toast.querySelector('[data-toast-icon="error"]')).toBeInTheDocument();
  });
});

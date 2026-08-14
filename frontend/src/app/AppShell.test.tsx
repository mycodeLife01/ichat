import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocation, useNavigate } from "react-router-dom";

import { ApiError } from "../api/errors";
import type {
  AuthUserResponse,
  ConversationCreateWithMessageResponse,
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
  shareLinkResponse,
  succeededEvent,
  textDeltaEvent,
} from "../test/apiFixtures";
import { selectionStore } from "../conversations/selectionStore";
import { createAuthSession, tokenStore } from "../auth/tokenStore";
import { createFakeServices, fakeStream, renderWithApp } from "../test/appHarness";
import { AppShell } from "./AppShell";

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function NavigateProbe({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>Go invalid</button>;
}

function createWithMessageResponse(
  conversation: ConversationResponse,
  sent: SendMessageResponse,
): ConversationCreateWithMessageResponse {
  return { conversation, ...sent };
}

describe("AppShell", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  });

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

  it("copies a permanent share link from the chat header actions", async () => {
    const create = vi.fn(async () => shareLinkResponse);
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
      {},
      {},
      // No active link yet, so sharing mints a permanent one.
      { list: async () => [], create },
    );
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    renderWithApp(<AppShell />, services);

    await user.click(await screen.findByText(conversationResponse.title as string));
    await user.click(await screen.findByRole("button", { name: "分享" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/share/${shareLinkResponse.token}`,
      ),
    );
    expect(create).toHaveBeenCalledWith(conversationResponse.id, null, undefined);
    expect(await screen.findByText("公开链接已复制到剪贴板")).toBeInTheDocument();
  });

  it("reuses an existing active share link instead of creating another", async () => {
    const create = vi.fn(async () => shareLinkResponse);
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
      {},
      {},
      { list: async () => [shareLinkResponse], create },
    );
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    renderWithApp(<AppShell />, services);

    await user.click(await screen.findByText(conversationResponse.title as string));
    await user.click(await screen.findByRole("button", { name: "分享" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(create).not.toHaveBeenCalled();
  });

  it("deletes the open conversation from the chat three-dot menu", async () => {
    const remove = vi.fn(async () => ({ status: "ok" as const }));
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
        remove,
      },
    );
    const user = userEvent.setup();
    renderWithApp(<AppShell />, services);

    await user.click(await screen.findByText(conversationResponse.title as string));
    await user.click(await screen.findByRole("button", { name: "更多操作" }));
    const menu = screen.getByRole("menu", { name: "对话操作" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "删除",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(conversationResponse.id));
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
    const createWithMessage = vi.fn(async () =>
      createWithMessageResponse(draft, { message: userMessage, run }),
    );
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
        createWithMessage,
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

    expect(createWithMessage).toHaveBeenCalledWith("你好", {
      thinking_enabled: true,
      reasoning_effort: "low",
      web_search_enabled: false,
      model: "deepseek-v4-flash",
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
    const createWithMessage = vi.fn(async () => createWithMessageResponse(draft, sent));
    const sendMessage = vi.fn(
      () => new Promise<SendMessageResponse>(() => {}),
    );
    const serverDetail: ConversationDetailResponse = {
      ...draft, activated_at: "t", title: "新对话",
      messages: [userMessage, assistantMessage],
    };

    const services = createFakeServices(
      {},
      {
        list: async () => [],
        createWithMessage,
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
    const createWithMessage = vi.fn(
      () => new Promise<ConversationCreateWithMessageResponse>(() => {}),
    );
    const services = createFakeServices(
      {},
      { list: async () => [], createWithMessage },
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
    await waitFor(() => expect(createWithMessage).toHaveBeenCalledOnce());
  });

  it("keeps sent image pixels stable after placement", async () => {
    const verifiedUser: AuthUserResponse = {
      ...authTokenResponse.user,
      email_verified: true,
    };
    tokenStore.save(
      createAuthSession({
        ...authTokenResponse,
        user: verifiedUser,
      }),
    );

    const createObjectURL = vi.fn<(blob: Blob | MediaSource) => string>(() =>
      "blob:composer-preview",
    );
    const revokeObjectURL = vi.fn<(url: string) => void>();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 200,
          headers: { ETag: '"upload-etag"' },
        }),
      ),
    );

    const attachment = {
      id: "file-1",
      name: "photo.png",
      media_type: "image/png",
      size_bytes: 7,
      category: "image" as const,
      model_input_kind: "image" as const,
      warning: [],
      preview_available: true,
      stats: { width: 1329, height: 1434 },
    };
    const draft: ConversationResponse = {
      id: "77",
      title: null,
      activated_at: null,
      created_at: "t",
      updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: "1",
      conversation_id: draft.id,
      run_id: "100",
      role: "user",
      content: "look",
      reasoning: null,
      position: 1,
      created_at: "t",
      attachments: [attachment],
    };
    const run: RunResponse = {
      id: "100",
      conversation_id: draft.id,
      user_message_id: userMessage.id,
      status: "streaming",
      provider_name: "openai",
      provider_model: "gpt-5-mini",
      created_at: "t",
    };
    const readUrl = vi.fn(async () => ({
      url: "https://downloads.example.test/file-1/preview",
      expires_at: "2026-08-08T10:05:00Z",
    }));
    let resolveSuccessfulSend!: (value: ConversationCreateWithMessageResponse) => void;
    const createWithMessage = vi
      .fn<() => Promise<ConversationCreateWithMessageResponse>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockImplementationOnce(
        () =>
          new Promise<ConversationCreateWithMessageResponse>((resolve) => {
            resolveSuccessfulSend = resolve;
          }),
      );
    const services = createFakeServices(
      { me: async () => verifiedUser },
      { list: async () => [], createWithMessage },
      { streamEvents: () => fakeStream([]) },
      {
        get: async () => ({
          web_search: { enabled: false },
          models: [
            {
              id: "gpt-5-mini",
              provider: "openai",
              label: "GPT-5 mini",
              thinking_levels: ["low"],
              default: true,
              supports_image_input: true,
            },
          ],
          files: {
            enabled: true,
            allowed_extensions: ["png"],
            category_max_bytes: { image: 10_000_000 },
            max_attachments_per_message: 10,
            max_message_bytes: 10_000_000,
            quota_bytes: 100_000_000,
            target_turn_tokens: 8_000,
            context_budget_tokens: 32_000,
          },
        }),
      },
      {},
      {
        createUpload: async () => ({
          upload_id: "upload-1",
          upload_url: "https://uploads.example.test/upload-1",
          upload_headers: { "Content-Type": "image/png" },
          upload_url_expires_at: "2026-08-08T10:05:00Z",
          session_expires_at: "2026-08-08T10:30:00Z",
        }),
        confirm: async () => ({
          upload_id: "upload-1",
          status: "succeeded",
          error_code: null,
          file: attachment,
        }),
        readUrl,
      },
    );

    const rendered = renderWithApp(<AppShell />, services);

    await waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('input[type="file"]')).not.toBeNull(),
    );
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [new File(["picture"], "photo.png", { type: "image/png" })] },
    });
    await waitFor(() =>
      expect(document.querySelector('[data-attachment-status="succeeded"]')).not.toBeNull(),
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "look" } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(createWithMessage).toHaveBeenCalledOnce());
    await waitFor(() => expect(textarea).toHaveValue("look"));
    expect(document.querySelector<HTMLImageElement>('img[alt="photo.png"]')?.src).toContain(
      "blob:composer-preview",
    );
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:composer-preview");

    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(createWithMessage).toHaveBeenCalledTimes(2));
    const pendingMessage = document.querySelector('[data-state="pending"]');
    const pendingImage = pendingMessage?.querySelector<HTMLImageElement>('img[alt="photo.png"]');
    expect(pendingMessage).toHaveTextContent("look");
    expect(pendingImage?.getAttribute("src")).toBe("blob:composer-preview");
    expect(document.querySelector('[data-testid="composer"] img[alt="photo.png"]')).toBeNull();

    await act(async () => {
      resolveSuccessfulSend(createWithMessageResponse(draft, { message: userMessage, run }));
      await Promise.resolve();
    });

    await waitFor(() => expect(document.querySelector('[data-state="pending"]')).toBeNull());
    const visibleImage = document.querySelector<HTMLImageElement>('img[alt="photo.png"]');
    expect(visibleImage).toBe(pendingImage);
    expect(visibleImage?.getAttribute("src")).toBe("blob:composer-preview");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:composer-preview");
    const localImage = visibleImage;
    const imageGroup = localImage?.closest('[data-attachment-group="images"]');
    expect(imageGroup?.className).not.toMatch(/\banimate-/);
    expect(localImage?.src).toContain("blob:composer-preview");
    expect(localImage).not.toHaveClass("transition-opacity", "opacity-0", "opacity-100");
    expect(localImage?.className).not.toMatch(/\b(?:animate|scale)-/);
    expect(document.querySelector('img[data-preview-preload="true"]')).toBeNull();
    expect(readUrl).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:composer-preview");

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    });

    expect(document.querySelector<HTMLImageElement>('img[alt="photo.png"]')).toBe(localImage);
    expect(localImage?.src).toContain("blob:composer-preview");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:composer-preview");

    rendered.unmount();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:composer-preview");
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
    let resolveSend: ((value: ConversationCreateWithMessageResponse) => void) | undefined;
    const createWithMessage = vi.fn(
      () =>
        new Promise<ConversationCreateWithMessageResponse>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const services = createFakeServices(
      {},
      { list: async () => [], createWithMessage },
      { streamEvents: () => fakeStream([]) },
    );

    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    const pendingThinking = await screen.findByText("正在思考");

    expect(resolveSend).toBeDefined();
    resolveSend?.(createWithMessageResponse(draft, { message: userMessage, run }));
    await screen.findByRole("button", { name: "停止生成" });

    expect(screen.getByText("正在思考")).toBe(pendingThinking);
  });

  it("restores the submitted text when sending fails", async () => {
    const user = userEvent.setup();
    const services = createFakeServices(
      {},
      {
        list: async () => [],
        createWithMessage: async () => {
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
      {
        list: async () => [],
        createWithMessage: async () => createWithMessageResponse(draft, sent),
      },
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
      {
        list: async () => [],
        createWithMessage: async () => createWithMessageResponse(draft, sent),
      },
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

  it("expands restored DeepSeek reasoning below its generic label after refresh", async () => {
    const services = createFakeServices(
      {},
      {
        list: async () => [conversationResponse],
        detail: async () => conversationDetailResponse,
      },
      {
        state: async () => ({
          ...runStateResponse,
          provider_name: "deepseek",
          draft_text: "",
          draft_reasoning: "刷新前已经生成的思考过程",
        }),
        streamEvents: () => fakeStream([]),
      },
    );

    renderWithApp(
      <AppShell />,
      services,
      undefined,
      [`/c/${conversationResponse.id}`],
    );

    const header = await screen.findByRole("button", { name: /正在思考/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header).not.toHaveTextContent("刷新前已经生成的思考过程");
    expect(screen.getByText("刷新前已经生成的思考过程")).not.toHaveClass("hidden");
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
    await user.click(
      within(screen.getByTestId("message-editor")).getByRole("button", { name: "发送" }),
    );

    expect(editAndRegenerate).toHaveBeenCalledWith(conversationResponse.id, "1", "新问题", {
      thinking_enabled: true,
      reasoning_effort: "low",
      web_search_enabled: false,
      model: "deepseek-v4-flash",
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
      thinking_enabled: true,
      reasoning_effort: "low",
      web_search_enabled: false,
      model: "deepseek-v4-flash",
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
      {
        list: async () => [],
        createWithMessage: async () =>
          createWithMessageResponse(draft, { message: userMessage, run }),
      },
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
      {
        list: async () => [],
        createWithMessage: async () => createWithMessageResponse(draft, sent),
      },
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

  it("keeps scroll pinned while DeepSeek reasoning expands below the thinking header", async () => {
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
    expect(region.className).toContain("[overflow-anchor:none]");
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
    const reasoningBody = await screen.findByText("新增推理");
    expect(reasoningBody).not.toHaveClass("hidden");
    const thinkingHeader = screen.getByRole("button", { name: /正在思考/ });
    expect(thinkingHeader).not.toHaveTextContent("新增推理");

    expect(region.scrollTop).toBe(1000);
  });

  it("surfaces a toast when sending fails", async () => {
    const services = createFakeServices(
      {},
      {
        list: async () => [],
        createWithMessage: async () => {
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

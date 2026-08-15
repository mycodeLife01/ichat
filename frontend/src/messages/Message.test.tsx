import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessageResponse } from "../api/types";
import type { FileAttachment } from "../files/types";
import { Message } from "./Message";

const userMessage: MessageResponse = {
  id: "1",
  conversation_id: "10",
  run_id: null,
  role: "user",
  content: "你好",
  reasoning: null,
  position: 1,
  created_at: "2026-06-08T10:00:00Z",
};

const assistantMessage: MessageResponse = {
  id: "2",
  conversation_id: "10",
  run_id: "100",
  role: "assistant",
  content: "**回答**正文",
  reasoning: "我的推理",
  position: 2,
  created_at: "2026-06-08T10:00:01Z",
};

const attachments: FileAttachment[] = [
  {
    id: "file-1",
    name: "report.pdf",
    media_type: "application/pdf",
    size_bytes: 1234,
    category: "pdf",
    model_input_kind: null,
    warning: ["Some scanned pages were not read."],
    preview_available: false,
  },
  {
    id: "file-2",
    name: "photo.png",
    media_type: "image/png",
    size_bytes: 4321,
    category: "image",
    model_input_kind: "image",
    warning: [],
    preview_available: true,
    stats: { width: 640, height: 480 },
  },
];

// Simulates a touch held past the 450ms long-press window.
function longPress(el: HTMLElement) {
  vi.useFakeTimers();
  fireEvent.touchStart(el);
  act(() => {
    vi.advanceTimersByTime(500);
  });
  vi.useRealTimers();
}

describe("Message", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders a user bubble", () => {
    render(<Message message={userMessage} />);
    expect(screen.getByText("你好")).toBeInTheDocument();
  });

  it("renders a signed image thumbnail and reopens its preview without another read-url request", async () => {
    const user = userEvent.setup();
    const onReadAttachment = vi.fn(async () => ({ url: "https://signed.example.test/preview" }));
    render(
      <Message
        message={{ ...userMessage, attachments }}
        onReadAttachment={onReadAttachment}
      />,
    );

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("Some scanned pages were not read.")).toBeInTheDocument();
    expect(
      screen.getByText(/File available for download — the model cannot read its contents/),
    ).toBeInTheDocument();
    await waitFor(() => expect(onReadAttachment).toHaveBeenCalledWith("file-2", "preview"));
    expect(await screen.findByAltText("photo.png")).toHaveAttribute(
      "src",
      "https://signed.example.test/preview",
    );

    const imageButton = screen.getByRole("button", { name: "打开图片：photo.png" });
    await user.click(imageButton);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onReadAttachment).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(imageButton);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onReadAttachment).toHaveBeenCalledTimes(1);
  });

  it("keeps sent-image frame geometry stable while the signed preview loads", async () => {
    let resolveReadUrl!: (value: { url: string }) => void;
    const onReadAttachment = vi.fn(
      () =>
        new Promise<{ url: string }>((resolve) => {
          resolveReadUrl = resolve;
        }),
    );
    render(
      <Message
        message={{ ...userMessage, attachments: [attachments[1]] }}
        onReadAttachment={onReadAttachment}
      />,
    );

    const imageButton = screen.getByRole("button", { name: "打开图片：photo.png" });
    const frameBeforePreview = imageButton.style.cssText;
    expect(imageButton).toHaveStyle({ width: "341.3333333333333px", height: "256px" });

    resolveReadUrl({ url: "https://signed.example.test/preview" });
    const image = await screen.findByAltText("photo.png");

    expect(imageButton.style.cssText).toBe(frameBeforePreview);
    expect(imageButton).toHaveClass("max-h-64", "max-w-96", "rounded-[28px]");
    expect(image).toHaveClass("block", "object-cover", "max-h-64", "max-w-96");
  });

  it("matches the wider ChatGPT frame for one landscape image", async () => {
    const onReadAttachment = vi.fn(async () => ({
      url: "https://signed.example.test/landscape-preview",
    }));
    const landscapeImage = {
      ...attachments[1],
      stats: { width: 2048, height: 1152 },
    };
    render(
      <Message
        message={{ ...userMessage, attachments: [landscapeImage] }}
        onReadAttachment={onReadAttachment}
      />,
    );

    const image = await screen.findByAltText("photo.png");
    const imageButton = screen.getByRole("button", { name: "打开图片：photo.png" });

    expect(imageButton).toHaveClass("max-h-64", "max-w-96", "rounded-[28px]");
    expect(imageButton).toHaveStyle({ width: "384px", height: "216px" });
    expect(image).toHaveClass("block", "object-cover", "max-h-64", "max-w-96");
  });

  it("places sent files above and outside the user bubble", () => {
    render(<Message message={{ ...userMessage, attachments }} />);

    const attachmentList = screen.getByLabelText("附件");
    const fileCard = screen.getByRole("group", { name: "report.pdf" });
    const messageText = screen.getByText("你好");
    expect(attachmentList.parentElement).toHaveClass(
      "flex-col",
      "items-end",
      "gap-1",
      "w-full",
    );
    expect(attachmentList).toHaveClass("flex-col", "items-end", "gap-1");
    expect(attachmentList.querySelector('[data-attachment-group="images"]')).toHaveClass(
      "max-w-72",
      "flex-wrap",
      "gap-1",
      "justify-end",
    );
    expect(attachmentList.querySelector('[data-attachment-group="files"]')).toHaveClass(
      "max-w-[80%]",
      "flex-wrap",
      "gap-2",
      "justify-end",
    );
    expect(fileCard).toHaveClass("w-[320px]", "min-w-[320px]");
    expect(
      attachmentList.compareDocumentPosition(messageText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps one sent image aspect-preserving but switches image collections to 128px tiles", async () => {
    const onReadAttachment = vi.fn(async (fileId: string) => ({
      url: `https://signed.example.test/${fileId}`,
    }));
    const image = {
      ...attachments[1],
      stats: { width: 640, height: 960 },
    };
    const secondImage = { ...image, id: "file-3", name: "second.png" };
    const { rerender } = render(
      <Message
        message={{ ...userMessage, attachments: [image] }}
        onReadAttachment={onReadAttachment}
      />,
    );

    await waitFor(() => expect(onReadAttachment).toHaveBeenCalledTimes(1));
    await screen.findByAltText("photo.png");
    const singleGroup = screen.getByLabelText("附件").querySelector(
      '[data-attachment-group="images"]',
    );
    expect(singleGroup).toHaveAttribute("data-image-layout", "single");
    expect(singleGroup).toHaveClass("w-[70%]", "flex-col", "items-end");
    expect(screen.getByRole("button", { name: "打开图片：photo.png" })).toHaveClass(
      "max-h-96",
      "max-w-64",
      "rounded-[28px]",
    );
    expect(screen.getByRole("button", { name: "打开图片：photo.png" })).toHaveStyle({
      width: "256px",
      height: "384px",
    });

    rerender(
      <Message
        message={{ ...userMessage, attachments: [image, secondImage] }}
        onReadAttachment={onReadAttachment}
      />,
    );
    await waitFor(() => expect(onReadAttachment).toHaveBeenCalledTimes(2));
    const collection = screen.getByLabelText("附件").querySelector(
      '[data-attachment-group="images"]',
    );
    expect(collection).toHaveAttribute("data-image-layout", "collection");
    expect(collection).toHaveClass("max-w-72", "flex-row", "gap-1");
    expect(screen.getByRole("button", { name: "打开图片：photo.png" })).toHaveClass(
      "h-32",
      "w-32",
      "rounded-s-2xl",
    );
    expect(screen.getByRole("button", { name: "打开图片：second.png" })).toHaveClass(
      "h-32",
      "w-32",
      "rounded-e-2xl",
    );
  });

  it("renders only the formal assistant reply after completion", () => {
    render(<Message message={assistantMessage} />);
    expect(screen.getByText("回答")).toBeInTheDocument(); // bold rendered
    expect(screen.queryByText("我的推理")).toBeNull();
    expect(screen.queryByText("已思考")).toBeNull();
  });

  it("keeps assistant body and actions in the shared content column", () => {
    const { container } = render(<Message message={assistantMessage} />);
    const column = container.querySelector(".assistant-content");

    expect(column).not.toBeNull();
    expect(column?.querySelector(".assistant-markdown")).not.toBeNull();
    expect(column?.querySelector(".msg-actions")).not.toBeNull();
  });

  it("renders final tables and external links through the shared Markdown surface", () => {
    const content = [
      "| Surface | State |",
      "| --- | --- |",
      "| Table | complete |",
      "",
      "[External](https://example.com/final)",
    ].join("\n");
    const { container } = render(
      <Message message={{ ...assistantMessage, content }} />,
    );

    expect(container.querySelector(".assistant-markdown [data-table-block]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "External" })).toHaveAttribute(
      "target",
      "_new",
    );
  });

  it("shows a sources trigger that opens the sources panel", async () => {
    const user = userEvent.setup();
    const onShowSources = vi.fn();
    const sources = [
      {
        id: 1,
        title: "Release notes",
        url: "https://www.example.com/releases",
        snippet: "Version 1.2 shipped.",
        published_at: "2026-06-11",
        provider: "tavily",
      },
    ];
    render(
      <Message
        message={{ ...assistantMessage, metadata: { sources } }}
        onShowSources={onShowSources}
      />,
    );

    await user.click(screen.getByRole("button", { name: "查看 1 个来源" }));
    expect(onShowSources).toHaveBeenCalledWith(sources);
  });

  it("copies content", async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs a (non-writable) clipboard stub; spy on its
    // writeText rather than replacing navigator.clipboard.
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    render(<Message message={userMessage} />);
    await user.click(screen.getByRole("button", { name: /复制/ }));

    expect(writeText).toHaveBeenCalledWith("你好");
  });

  it("edits a user message and submits the new content", async () => {
    const user = userEvent.setup();
    const onEditAndRegenerate = vi.fn();
    render(
      <Message
        message={userMessage}
        mutateDisabledReason={null}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("你好");
    await user.clear(textarea);
    await user.type(textarea, "改写后的问题");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(onEditAndRegenerate).toHaveBeenCalledWith(userMessage.id, "改写后的问题");
  });

  it("offers legacy image editing only after the vision model upgrade succeeds", async () => {
    const user = userEvent.setup();
    const onEditUpgradeLegacy = vi.fn(() => true);
    render(
      <Message
        message={{ ...userMessage, attachments: [attachments[1]] }}
        legacyUpgradeAvailable
        onEditUpgradeLegacy={onEditUpgradeLegacy}
      />,
    );

    await user.click(screen.getByRole("button", { name: "编辑并升级" }));

    expect(onEditUpgradeLegacy).toHaveBeenCalledWith(userMessage.id);
    expect(screen.getByRole("textbox")).toHaveValue(userMessage.content);
  });

  it("cancels editing without calling back", async () => {
    const user = userEvent.setup();
    const onEditAndRegenerate = vi.fn();
    render(
      <Message
        message={userMessage}
        mutateDisabledReason={null}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(onEditAndRegenerate).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("你好")).toBeInTheDocument();
  });

  it("uses ChatGPT's compact attachment layout and inherits files when editing", async () => {
    const user = userEvent.setup();
    const onEditAndRegenerate = vi.fn();
    const message = { ...userMessage, attachments: [attachments[1], attachments[0]] };
    render(
      <Message message={message} onEditAndRegenerate={onEditAndRegenerate} />,
    );

    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    const editor = screen.getByTestId("message-editor");
    const attachmentRail = screen.getByLabelText("编辑消息附件");
    const image = screen.getByRole("group", { name: "photo.png" });
    const file = screen.getByRole("group", { name: "report.pdf" });
    expect(editor).toHaveClass("w-full", "rounded-[24px]", "bg-sunken", "px-3", "py-3");
    expect(attachmentRail).toHaveClass("flex", "flex-wrap", "gap-2");
    expect(image).toHaveClass("h-[60px]", "w-14", "rounded-xl");
    expect(file).toHaveClass("w-[320px]", "min-w-[320px]");
    expect(file.firstElementChild).toHaveClass("h-[60px]");
    expect(image.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/original attachments|replace the original/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Move attachment|Remove attachment/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(onEditAndRegenerate).toHaveBeenCalledWith(userMessage.id, "你好");
  });

  it("does not submit an empty edit", async () => {
    const user = userEvent.setup();
    const onEditAndRegenerate = vi.fn();
    render(
      <Message
        message={userMessage}
        mutateDisabledReason={null}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    await user.clear(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(onEditAndRegenerate).not.toHaveBeenCalled();
  });

  it("keeps image attachment controls absent on hover while editing text", async () => {
    const user = userEvent.setup();
    const onEditAndRegenerate = vi.fn();
    render(
      <Message
        message={{ ...userMessage, attachments: [attachments[1]] }}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    await user.hover(screen.getByRole("group", { name: "photo.png" }));
    expect(screen.queryByRole("button", { name: /Move attachment|Remove attachment/ })).toBeNull();
    const textbox = screen.getByRole("textbox");
    await user.clear(textbox);
    await user.type(textbox, "只修改文字");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(onEditAndRegenerate).toHaveBeenCalledWith(userMessage.id, "只修改文字");
  });

  it("regenerates an assistant message", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    render(
      <Message
        message={assistantMessage}
        mutateDisabledReason={null}
        onRegenerate={onRegenerate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /重新生成/ }));
    expect(onRegenerate).toHaveBeenCalledWith(assistantMessage.id);
  });

  it("disables the mutate button and shows the reason on hover", async () => {
    const reason = "请先停止当前生成";
    const user = userEvent.setup();
    const { rerender } = render(
      <Message message={userMessage} mutateDisabledReason={reason} />,
    );
    const editBtn = screen.getByRole("button", { name: "编辑并重发" });
    expect(editBtn).toBeDisabled();
    await user.hover(editBtn);
    expect(screen.getByText(reason)).toBeInTheDocument();
    // Copy stays enabled.
    expect(screen.getByRole("button", { name: /复制/ })).toBeEnabled();

    rerender(<Message message={assistantMessage} mutateDisabledReason={reason} />);
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  });

  it("desktop: hides labels until hover, then shows a dropdown", async () => {
    const user = userEvent.setup();
    render(<Message message={assistantMessage} mutateDisabledReason={null} />);
    // Icon-only by default: the label is the accessible name, not visible text.
    expect(screen.queryByText("重新生成")).toBeNull();
    await user.hover(screen.getByRole("button", { name: "重新生成" }));
    expect(screen.getByText("重新生成")).toBeInTheDocument();
  });

  it("desktop: swaps the copy icon to a check after copying", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<Message message={assistantMessage} />);

    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
  });

  it("desktop: assistant bar is resident (always visible), user bar is not", () => {
    const { container, rerender } = render(<Message message={assistantMessage} />);
    expect(container.querySelector(".msg-actions")).toHaveClass("resident");
    rerender(<Message message={userMessage} />);
    expect(container.querySelector(".msg-actions")).not.toHaveClass("resident");
  });

  it("desktop: does not render a more button", () => {
    render(<Message message={userMessage} />);
    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
    expect(screen.getByRole("button", { name: /复制/ })).toBeInTheDocument();
  });

  it("mobile: long-press on the user bubble opens the action sheet", async () => {
    const onEditAndRegenerate = vi.fn();
    render(
      <Message
        message={userMessage}
        isMobile
        mutateDisabledReason={null}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    // No visible action button; actions live behind the long-press sheet.
    expect(screen.queryByRole("button", { name: /复制/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
    longPress(screen.getByText("你好"));
    expect(screen.getByRole("button", { name: /复制/ })).toBeInTheDocument();
    expect(document.querySelector(".sheet-scrim")).toHaveClass("bg-overlay");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    // The mobile edit action enters the same inline editor.
    expect(screen.getByRole("textbox")).toHaveValue("你好");
  });

  it("mobile: a released touch does not open the sheet", () => {
    render(<Message message={userMessage} isMobile />);

    const bubble = screen.getByText("你好");
    vi.useFakeTimers();
    fireEvent.touchStart(bubble);
    fireEvent.touchEnd(bubble); // lifted before the long-press window
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();

    expect(screen.queryByRole("button", { name: /复制/ })).toBeNull();
  });

  it("mobile: copies from the sheet", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<Message message={userMessage} isMobile />);

    longPress(screen.getByText("你好"));
    await user.click(screen.getByRole("button", { name: /复制/ }));
    expect(writeText).toHaveBeenCalledWith("你好");
  });

  it("mobile: assistant actions are resident, no sheet involved", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    render(<Message message={assistantMessage} isMobile onRegenerate={onRegenerate} />);

    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /重新生成/ }));
    expect(onRegenerate).toHaveBeenCalledWith(assistantMessage.id);
  });

  it("mobile: keeps the resident assistant shortcuts compact", () => {
    const { container } = render(<Message message={assistantMessage} isMobile />);

    const actionBar = container.querySelector(".msg-actions");
    expect(actionBar).toHaveClass("gap-0.5");
    for (const action of screen.getAllByRole("button")) {
      expect(action).toHaveClass("w-7");
    }
  });

  it("mobile: disables the mutate action in the sheet with a reason", async () => {
    const reason = "请先停止当前生成";
    render(<Message message={userMessage} isMobile mutateDisabledReason={reason} />);

    longPress(screen.getByText("你好"));
    const editBtn = screen.getByRole("button", { name: /编辑并重发/ });
    expect(editBtn).toBeDisabled();
    const reasonText = screen.getByText(reason);
    expect(reasonText).toBeVisible();
    expect(editBtn).toHaveAccessibleDescription(reason);
    expect(screen.getByRole("button", { name: /复制/ })).toBeEnabled();
  });

  it("does not show an expand toggle for short user messages", () => {
    render(<Message message={userMessage} />);
    expect(screen.queryByRole("button", { name: /展开/ })).toBeNull();
  });

  it("collapses a tall user message and toggles 展开/收起", async () => {
    // jsdom has no layout: fake a content scrollHeight above the collapse cap.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 1000;
      },
    });

    try {
      const user = userEvent.setup();
      render(<Message message={userMessage} />);

      const expand = screen.getByRole("button", { name: /展开/ });
      expect(expand).toHaveAttribute("aria-expanded", "false");
      // Collapsed content is height-clipped.
      const content = screen.getByText("你好");
      expect(content.style.maxHeight).not.toBe("");
      expect(content.style.overflow).toBe("hidden");

      await user.click(expand);
      const collapse = screen.getByRole("button", { name: /收起/ });
      expect(collapse).toHaveAttribute("aria-expanded", "true");
      expect(content.style.maxHeight).toBe("");

      await user.click(collapse);
      expect(screen.getByRole("button", { name: /展开/ })).toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original);
      else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
    }
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type { DraftAttachment } from "../files/types";
import { Composer } from "./Composer";

const noop = () => {};

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    value: "",
    onChange: noop,
    onSend: noop,
    onStop: noop,
    state: "idle",
    thinkingLevel: "low",
    onThinkingLevelChange: noop,
    ...overrides,
  };
  return render(<Composer {...props} />);
}

const FLASH = {
  id: "deepseek-v4-flash",
  provider: "deepseek",
  label: "deepseek-v4-flash",
  thinking_levels: ["low", "high", "max"],
  default: true,
  supports_image_input: false,
};
const PRO = {
  id: "deepseek-v4-pro",
  provider: "deepseek",
  label: "deepseek-v4-pro",
  thinking_levels: ["high", "max"],
  default: false,
  supports_image_input: false,
};
const LUNA = {
  id: "openai/gpt-5.6-luna",
  provider: "openai",
  label: "gpt-5.6-luna",
  thinking_levels: ["low", "medium", "high", "xhigh", "max"],
  default: false,
  supports_image_input: true,
};
const NO_THINKING = {
  id: "gpt-4.1-mini",
  provider: "openai",
  label: "gpt-4.1-mini",
  thinking_levels: [] as string[],
  default: false,
  supports_image_input: false,
};
const MODELS = [FLASH, PRO, LUNA, NO_THINKING];

const FILES = {
  enabled: true,
  allowed_extensions: ["txt", "png"],
  category_max_bytes: { text: 2_000_000, image: 10_000_000 },
  max_attachments_per_message: 5,
  max_message_bytes: 50_000_000,
  quota_bytes: 1_000_000_000,
  target_turn_tokens: 128_000,
  context_budget_tokens: 256_000,
};

const READY_ATTACHMENT = {
  client_id: "draft-1",
  upload_id: "upload-1",
  status: "succeeded",
  error_code: null,
  file: {
    id: "file-1",
    name: "report.xlsx",
    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size_bytes: 1024,
    category: "office",
    model_input_kind: "document",
    preview_available: false,
  },
  name: "report.xlsx",
  media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size_bytes: 1024,
  category: "office",
} satisfies DraftAttachment;

const READY_IMAGE = {
  client_id: "draft-image",
  upload_id: "upload-image",
  status: "succeeded",
  error_code: null,
  file: {
    id: "file-image",
    name: "photo.png",
    media_type: "image/png",
    size_bytes: 512,
    category: "image",
    model_input_kind: "image",
    preview_available: true,
  },
  name: "photo.png",
  media_type: "image/png",
  size_bytes: 512,
  category: "image",
  local_preview_url: "blob:photo-preview",
} satisfies DraftAttachment;

describe("Composer", () => {
  it("uses the assistant content width for horizontal alignment", () => {
    renderComposer();

    const composer = screen.getByTestId("composer");
    expect(composer).toHaveClass(
      "max-w-[var(--assistant-content-width)]",
    );
    expect(composer.parentElement).toHaveClass("composer-wrap", "pointer-events-auto");
    expect(composer.parentElement).not.toHaveClass("bg-canvas");
  });

  it("disables send when empty (idle)", () => {
    renderComposer();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("enables send with non-empty input (idle)", () => {
    renderComposer({ value: "hi" });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("moves the controls below a prompt that reaches the ChatGPT height limit", () => {
    const props: ComponentProps<typeof Composer> = {
      value: "short",
      onChange: noop,
      onSend: noop,
      onStop: noop,
      state: "idle",
      thinkingLevel: "low",
      onThinkingLevelChange: noop,
    };
    const { rerender } = render(<Composer {...props} />);
    const textbox = screen.getByPlaceholderText("有问题，尽管问");
    Object.defineProperty(textbox, "scrollHeight", {
      configurable: true,
      value: 500,
    });

    rerender(<Composer {...props} value="a much longer prompt" />);

    expect(textbox).toHaveStyle({ height: "500px", maxHeight: "max(30svh, 5rem)" });
    expect(screen.getByTestId("composer")).toHaveAttribute("data-expanded", "true");
    expect(textbox.parentElement).toHaveClass(
      "col-span-3",
      "col-start-1",
      "px-2.5",
      "composer-prompt-fade",
    );
    expect(textbox).not.toHaveClass("composer-prompt-fade");
    expect(textbox).toHaveClass("py-4");
    expect(
      screen.getByRole("button", { name: "添加文件等" }).parentElement?.parentElement,
    ).toHaveClass("row-start-3", "h-[42px]");
    expect(screen.getByRole("button", { name: "发送" }).parentElement).toHaveClass(
      "row-start-3",
      "h-[42px]",
    );
    expect(screen.getByRole("button", { name: "发送" })).toHaveClass(
      "h-9",
      "w-9",
      "rounded-pill",
      "bg-composer-submit",
    );
    expect(screen.getByRole("button", { name: "发送" }).querySelector("svg")).toHaveAttribute(
      "data-icon",
      "send-prompt",
    );
  });

  it("returns to the compact height after an expanded prompt is cleared at once", () => {
    const props: ComponentProps<typeof Composer> = {
      value: "short",
      onChange: noop,
      onSend: noop,
      onStop: noop,
      state: "idle",
      thinkingLevel: "low",
      onThinkingLevelChange: noop,
    };
    const { rerender } = render(<Composer {...props} />);
    const textbox = screen.getByPlaceholderText("有问题，尽管问") as HTMLTextAreaElement;
    Object.defineProperty(textbox, "scrollHeight", {
      configurable: true,
      get: () => {
        if (textbox.value !== "") return 500;
        return textbox.classList.contains("py-4") ? 57 : 25;
      },
    });

    rerender(<Composer {...props} value="a much longer prompt" />);
    expect(screen.getByTestId("composer")).toHaveAttribute("data-expanded", "true");

    rerender(<Composer {...props} value="" />);

    expect(screen.getByTestId("composer")).toHaveAttribute("data-expanded", "false");
    expect(textbox).not.toHaveClass("py-4");
    expect(textbox).toHaveStyle({ height: "25px" });
  });

  it("calls onSend on Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderComposer({ value: "hi", onSend });
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalled();
  });

  it("does not send on Shift+Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderComposer({ value: "hi", onSend });
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send on Enter while an IME composition is active", () => {
    const onSend = vi.fn();
    renderComposer({ value: "nihao", onSend });
    fireEvent.keyDown(screen.getByPlaceholderText("有问题，尽管问"), {
      key: "Enter",
      isComposing: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clicking send calls onSend", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderComposer({ value: "hi", onSend });
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalled();
  });

  it("shows a disabled busy send action while submitting", () => {
    renderComposer({ state: "submitting" });
    const submitting = screen.getByRole("button", { name: "发送中" });
    expect(submitting).toBeDisabled();
    expect(submitting).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "停止生成" })).toBeNull();
  });

  it("shows the stop button while streaming and calls onStop", async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    renderComposer({ value: "hi", onStop, state: "streaming" });
    const stop = screen.getByRole("button", { name: "停止生成" });
    expect(stop).toBeEnabled();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    await user.click(stop);
    expect(onStop).toHaveBeenCalled();
  });

  it("disables the stop button and marks it busy while stopping", () => {
    renderComposer({ value: "hi", state: "stopping" });
    const stopping = screen.getByRole("button", { name: "停止中" });
    expect(stopping).toBeDisabled();
    expect(stopping).toHaveAttribute("aria-busy", "true");
  });

  it("does not show a voice input button", () => {
    renderComposer();
    expect(screen.queryByRole("button", { name: "语音输入" })).toBeNull();
  });

  it("shows the attachment picker only when the server enables files", async () => {
    const user = userEvent.setup();
    const onSelectFiles = vi.fn();
    const { rerender } = renderComposer({ onSelectFiles });
    await user.click(screen.getByRole("button", { name: "添加文件等" }));
    expect(screen.queryByRole("menuitem", { name: /添加照片和文件/ })).toBeNull();

    rerender(
      <Composer
        value=""
        onChange={noop}
        onSend={noop}
        onStop={noop}
        state="idle"
        thinkingLevel="low"
        onThinkingLevelChange={noop}
        fileCapability={FILES}
        onSelectFiles={onSelectFiles}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: /添加照片和文件/ }));
    const input = screen.getByLabelText("选择附件") as HTMLInputElement;
    expect(input).toHaveAttribute("accept", ".txt,.png");
  });

  it("uses the attachment-aware send gate instead of requiring text", () => {
    renderComposer({ value: "", canSend: true });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("places compact attachment tiles above the prompt without reorder controls", async () => {
    const onCancelAttachment = vi.fn();
    const user = userEvent.setup();
    renderComposer({
      attachments: [READY_ATTACHMENT],
      onCancelAttachment,
    });

    const tile = screen.getByRole("group", { name: "report.xlsx" });
    const textbox = screen.getByRole("textbox");
    expect(tile).toHaveClass("w-[320px]", "min-w-[320px]");
    expect(tile.firstElementChild).toHaveClass("h-[60px]");
    expect(tile).toHaveTextContent("电子表格");
    expect(tile.querySelector("svg")).toHaveClass("text-[#16a34a]");
    expect(
      tile.compareDocumentPosition(textbox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move attachment earlier" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move attachment later" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Remove attachment" }));
    expect(onCancelAttachment).toHaveBeenCalledWith("draft-1");
  });

  it("uses a scrollbar-free horizontal rail for mixed images and files", async () => {
    const user = userEvent.setup();
    const onReadAttachment = vi.fn();
    renderComposer({
      attachments: [READY_IMAGE, READY_ATTACHMENT, { ...READY_ATTACHMENT, client_id: "draft-2" }],
      onReadAttachment,
    });

    const rail = screen.getByLabelText("附件");
    expect(rail).toHaveClass(
      "overflow-x-auto",
      "scrollbar-none",
      "touch-pan-x",
      "items-stretch",
    );
    expect(screen.getByRole("group", { name: "photo.png" })).toHaveClass(
      "h-[60px]",
      "w-14",
      "rounded-xl",
    );

    await user.click(screen.getByRole("button", { name: "打开图片：photo.png" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onReadAttachment).not.toHaveBeenCalled();
  });

  it("keeps 80px image tiles when a Composer collection contains only images", () => {
    renderComposer({
      attachments: [
        READY_IMAGE,
        {
          ...READY_IMAGE,
          client_id: "draft-image-2",
          name: "second.png",
          file: { ...READY_IMAGE.file, id: "file-image-2", name: "second.png" },
        },
      ],
    });

    expect(screen.getByRole("group", { name: "photo.png" })).toHaveClass("h-20", "w-20");
    expect(screen.getByRole("group", { name: "second.png" })).toHaveClass("h-20", "w-20");
  });

  it("uses a larger aspect-preserving frame for an isolated Composer image", () => {
    renderComposer({ attachments: [READY_IMAGE] });

    const image = screen.getByRole("group", { name: "photo.png" });
    expect(image).toHaveClass("max-h-[120px]", "max-w-[160px]");
    expect(image).not.toHaveClass("h-20", "w-20");
    expect(screen.getByAltText("photo.png")).toHaveClass(
      "max-h-[120px]",
      "max-w-[160px]",
    );
  });

  it("reopens a restored Composer image without requesting another read URL", async () => {
    const user = userEvent.setup();
    const onReadAttachment = vi.fn(async () => ({ url: "https://signed.example.test/photo" }));
    const restoredImage = { ...READY_IMAGE, local_preview_url: undefined };
    renderComposer({ attachments: [restoredImage], onReadAttachment });

    await waitFor(() => expect(onReadAttachment).toHaveBeenCalledTimes(1));
    const imageButton = screen.getByRole("button", { name: "打开图片：photo.png" });
    await user.click(imageButton);
    await user.click(screen.getByRole("button", { name: "关闭图片预览" }));
    await user.click(imageButton);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onReadAttachment).toHaveBeenCalledTimes(1);
  });

  it("reuses a signed download URL when a Composer file is clicked repeatedly", async () => {
    const user = userEvent.setup();
    const onReadAttachment = vi.fn(async () => ({ url: "https://signed.example.test/report" }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderComposer({ attachments: [READY_ATTACHMENT], onReadAttachment });

    const fileButton = screen.getByRole("button", { name: "report.xlsx" });
    await user.click(fileButton);
    await user.click(fileButton);

    expect(onReadAttachment).toHaveBeenCalledTimes(1);
    expect(onReadAttachment).toHaveBeenCalledWith("file-1", "download");
  });

  it("keeps every non-terminal attachment in one neutral loading state", () => {
    renderComposer({
      attachments: [
        {
          ...READY_ATTACHMENT,
          status: "processing",
          file: null,
        },
      ],
    });

    const tile = screen.getByRole("group", { name: "report.xlsx" });
    expect(tile).toHaveAttribute("aria-busy", "true");
    expect(tile).toHaveTextContent("正在上传");
    expect(tile).not.toHaveTextContent("Scanning and processing");
    expect(tile.querySelector("svg")).toHaveClass("animate-spin");
  });

  it("explains an attachment send gate when disabled", () => {
    renderComposer({
      value: "",
      canSend: false,
      sendDisabledReason: "Add text or a readable document. Images alone cannot be sent.",
    });
    expect(screen.getByRole("button", { name: "发送" })).toHaveAttribute(
      "title",
      "Add text or a readable document. Images alone cannot be sent.",
    );
  });

  it("toggles web search inside the tools menu and exposes its current state", async () => {
    const onWebSearchEnabledChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderComposer({ onWebSearchEnabledChange });

    await user.click(screen.getByRole("button", { name: "添加文件等" }));
    const searchItem = screen.getByRole("menuitemcheckbox", { name: /网页搜索/ });
    expect(searchItem).toHaveAttribute("aria-checked", "false");
    expect(searchItem).toHaveTextContent("已关闭");
    await user.click(searchItem);
    expect(onWebSearchEnabledChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("menu", { name: "添加和工具" })).toBeInTheDocument();

    rerender(
      <Composer
        value=""
        onChange={noop}
        onSend={noop}
        onStop={noop}
        state="idle"
        thinkingLevel="low"
        onThinkingLevelChange={noop}
        webSearchEnabled
        onWebSearchEnabledChange={onWebSearchEnabledChange}
      />,
    );
    const enabledSearchItem = screen.getByRole("menuitemcheckbox", { name: /网页搜索/ });
    expect(enabledSearchItem).toHaveAttribute("aria-checked", "true");
    expect(enabledSearchItem).not.toHaveTextContent("已关闭");
    await user.click(enabledSearchItem);
    expect(onWebSearchEnabledChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps web search out of the prompt when enabled", () => {
    renderComposer({ webSearchEnabled: true });

    expect(screen.queryByText("网页搜索")).toBeNull();
    const textbox = screen.getByRole("textbox");
    expect(textbox).toHaveAttribute("placeholder", "有问题，尽管问");
    expect(screen.getByRole("button", { name: "添加文件等" })).toHaveClass(
      "border-transparent",
      "bg-transparent",
      "text-text-muted",
    );
  });

  it("drops the prompt placeholder on mobile", () => {
    renderComposer({ isMobile: true });

    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "");
  });

  it("accepts files dropped anywhere on the page", () => {
    const onSelectFiles = vi.fn();
    renderComposer({ fileCapability: FILES, onSelectFiles });
    const composer = screen.getByTestId("composer");
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const dataTransfer = { files: [file], types: ["Files"], dropEffect: "none" };

    fireEvent.dragEnter(document.body, { dataTransfer });
    const overlay = screen.getByTestId("page-file-drop-overlay");
    expect(overlay).toHaveClass("fixed", "inset-0");
    expect(screen.getByText("松开即可上传")).toBeInTheDocument();
    expect(composer).toHaveAttribute("data-drag-active", "true");
    fireEvent.dragOver(document.body, { dataTransfer });
    fireEvent.drop(document.body, { dataTransfer });

    expect(onSelectFiles).toHaveBeenCalledTimes(1);
    expect(Array.from(onSelectFiles.mock.calls[0][0])).toEqual([file]);
    expect(screen.queryByTestId("page-file-drop-overlay")).toBeNull();
  });

  it("uploads pasted clipboard images through the attachment flow", () => {
    const onSelectFiles = vi.fn();
    renderComposer({
      fileCapability: FILES,
      models: MODELS,
      model: LUNA.id,
      onSelectFiles,
    });
    const image = new File(["pixels"], "image.png", { type: "image/png" });

    const pasteAccepted = fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => image,
          },
          {
            kind: "string",
            type: "text/plain",
            getAsFile: () => null,
          },
        ],
      },
    });

    expect(pasteAccepted).toBe(false);
    expect(onSelectFiles).toHaveBeenCalledOnce();
    expect(onSelectFiles).toHaveBeenCalledWith([image]);
  });

  it("shows a Chinese notice without uploading or switching models", async () => {
    const user = userEvent.setup();
    const onSelectFiles = vi.fn();
    const onModelChange = vi.fn();
    renderComposer({ fileCapability: FILES, onSelectFiles, onModelChange });
    const image = new File(["pixels"], "image.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("选择附件"), { target: { files: [image] } });

    const dialog = screen.getByRole("dialog", { name: "当前模型不支持图片上传" });
    expect(onSelectFiles).not.toHaveBeenCalled();
    expect(onModelChange).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent("当前模型不支持图片上传");
    expect(dialog).toHaveTextContent("请切换至GPT模型以继续");
    expect(within(dialog).getAllByRole("button")).toHaveLength(1);

    await user.click(within(dialog).getByRole("button", { name: "确认" }));

    expect(
      screen.queryByRole("dialog", { name: "当前模型不支持图片上传" }),
    ).not.toBeInTheDocument();
    expect(onSelectFiles).not.toHaveBeenCalled();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("keeps the composer read-only when vision input is unavailable", () => {
    const onChange = vi.fn();
    const onSelectFiles = vi.fn();
    renderComposer({
      value: "keep this",
      onChange,
      onSelectFiles,
      fileCapability: FILES,
      readOnly: true,
    });
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "changed" } });
    fireEvent.paste(textbox, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => new File(["x"], "x.png") }],
      },
    });

    expect(textbox).toHaveAttribute("readonly");
    expect(onChange).not.toHaveBeenCalled();
    expect(onSelectFiles).not.toHaveBeenCalled();
    expect(screen.getByLabelText("选择附件")).toBeDisabled();
  });

  it("does not switch models when removing draft images fails", async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    const onRemoveImages = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    renderComposer({
      models: MODELS,
      model: LUNA.id,
      attachments: [READY_IMAGE],
      onModelChange,
      onRemoveImages,
    });

    await user.click(screen.getByRole("button", { name: "模型与思考强度" }));
    await user.click(screen.getByRole("menuitem", { name: /^模型/ }));
    await user.click(screen.getByRole("menuitemradio", { name: FLASH.label }));
    await user.click(screen.getByRole("button", { name: "Remove all images and switch" }));

    await waitFor(() => expect(onRemoveImages).toHaveBeenCalledTimes(1));
    expect(onModelChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("leaves normal clipboard pastes untouched", () => {
    const onSelectFiles = vi.fn();
    renderComposer({ fileCapability: FILES, onSelectFiles });

    const pasteAccepted = fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        items: [
          {
            kind: "string",
            type: "text/plain",
            getAsFile: () => null,
          },
        ],
      },
    });

    expect(pasteAccepted).toBe(true);
    expect(onSelectFiles).not.toHaveBeenCalled();
  });

  it("does not intercept clipboard images when file uploads are unavailable", () => {
    const onSelectFiles = vi.fn();
    renderComposer({ fileCapability: FILES, fileUploadAllowed: false, onSelectFiles });
    const image = new File(["pixels"], "image.png", { type: "image/png" });

    const pasteAccepted = fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => image,
          },
        ],
      },
    });

    expect(pasteAccepted).toBe(true);
    expect(onSelectFiles).not.toHaveBeenCalled();
  });

  it("opens the tools menu below when there is room and closes it outside", async () => {
    const user = userEvent.setup();
    renderComposer({ fileCapability: FILES });

    const trigger = screen.getByRole("button", { name: "添加文件等" });
    await user.click(trigger);

    const menu = screen.getByRole("menu", { name: "添加和工具" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(menu).toHaveClass("fixed");
    expect(menu).toHaveStyle({ top: "8px" });
    expect(menu).toHaveStyle({ width: "768px" });
    const uploadItem = screen.getByRole("menuitem", { name: /添加照片和文件/ });
    const searchItem = screen.getByRole("menuitemcheckbox", { name: /网页搜索/ });
    expect(uploadItem).toHaveClass(
      "mx-1.5",
      "!w-[calc(100%-12px)]",
      "!leading-5",
      "bg-transparent",
      "hover:bg-hover",
    );
    expect(searchItem).toHaveClass("bg-transparent", "hover:bg-hover");
    expect(uploadItem).not.toHaveClass("focus:bg-hover", "focus-visible:bg-hover");
    expect(searchItem).not.toHaveClass("focus:bg-hover", "focus-visible:bg-hover");
    expect(document.activeElement).toBe(trigger);

    await user.click(screen.getByPlaceholderText("有问题，尽管问"));
    expect(screen.queryByRole("menu", { name: "添加和工具" })).toBeNull();
  });

  it("shows the model label and thinking level on the picker trigger", () => {
    renderComposer({ models: MODELS, model: FLASH.id, thinkingLevel: "max" });
    expect(
      screen.getByRole("button", { name: "模型与思考强度" }),
    ).toHaveTextContent("deepseek-v4-flash 极致");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows only the thinking level on the picker trigger on mobile", () => {
    renderComposer({
      models: MODELS,
      model: FLASH.id,
      thinkingLevel: "max",
      isMobile: true,
    });
    expect(screen.getByRole("button", { name: "模型与思考强度" })).toHaveTextContent(
      "极致",
    );
    expect(screen.queryByText("deepseek-v4-flash")).toBeNull();
  });

  it("shows only the thinking level before capabilities load", () => {
    renderComposer({ thinkingLevel: "high" });
    expect(screen.getByRole("button", { name: "模型与思考强度" })).toHaveTextContent("高");
  });

  it("opens a root menu with model and thinking rows showing current values", async () => {
    const user = userEvent.setup();
    renderComposer({ models: MODELS, model: LUNA.id, thinkingLevel: "xhigh" });

    const trigger = screen.getByRole("button", { name: "模型与思考强度" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const modelRow = screen.getByRole("menuitem", { name: /^模型/ });
    expect(modelRow).toHaveTextContent("gpt-5.6-luna");
    const levelRow = screen.getByRole("menuitem", { name: /^思考强度/ });
    expect(levelRow).toHaveTextContent("超高");
  });

  it("selects a model from the model submenu without the vendor prefix", async () => {
    const onModelChange = vi.fn();
    const user = userEvent.setup();
    renderComposer({ models: MODELS, model: FLASH.id, onModelChange });

    await user.click(screen.getByRole("button", { name: "模型与思考强度" }));
    await user.click(screen.getByRole("menuitem", { name: /^模型/ }));

    const luna = screen.getByRole("menuitemradio", { name: "gpt-5.6-luna" });
    expect(luna).toHaveTextContent("gpt-5.6-luna");
    expect(
      screen.getByRole("menuitemradio", { name: "deepseek-v4-flash" }),
    ).toHaveAttribute("aria-checked", "true");

    await user.click(luna);
    expect(onModelChange).toHaveBeenCalledWith("openai/gpt-5.6-luna");
    // Selection folds the flyout and returns to the root menu.
    expect(screen.queryByRole("menu", { name: "模型" })).toBeNull();
    expect(
      screen.getByRole("menu", { name: "模型与思考强度" }),
    ).toBeInTheDocument();
  });

  it("limits thinking levels to the selected model's tiers", async () => {
    const user = userEvent.setup();
    renderComposer({ models: MODELS, model: PRO.id, thinkingLevel: "high" });

    await user.click(screen.getByRole("button", { name: "模型与思考强度" }));
    await user.click(screen.getByRole("menuitem", { name: /^思考强度/ }));

    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent)).toEqual(["高", "极致"]);
  });

  it("offers all five tiers for gpt models and notifies on selection", async () => {
    const onThinkingLevelChange = vi.fn();
    const user = userEvent.setup();
    renderComposer({
      models: MODELS,
      model: LUNA.id,
      thinkingLevel: "low",
      onThinkingLevelChange,
    });

    await user.click(screen.getByRole("button", { name: "模型与思考强度" }));
    await user.click(screen.getByRole("menuitem", { name: /^思考强度/ }));

    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent)).toEqual([
      "快速",
      "中",
      "高",
      "超高",
      "极致",
    ]);

    await user.click(screen.getByRole("menuitemradio", { name: "超高" }));
    expect(onThinkingLevelChange).toHaveBeenCalledWith("xhigh");
    // Selection folds the flyout and returns to the root menu.
    expect(screen.queryByRole("menu", { name: "思考强度" })).toBeNull();
    expect(
      screen.getByRole("menu", { name: "模型与思考强度" }),
    ).toBeInTheDocument();
  });

  it("clamps an out-of-range level onto the model's tiers for display", () => {
    renderComposer({ models: MODELS, model: PRO.id, thinkingLevel: "low" });
    expect(
      screen.getByRole("button", { name: "模型与思考强度" }),
    ).toHaveTextContent("deepseek-v4-pro 高");
  });

  it("hides the thinking row for models without thinking tiers", async () => {
    const user = userEvent.setup();
    renderComposer({ models: MODELS, model: NO_THINKING.id });

    const trigger = screen.getByRole("button", { name: "模型与思考强度" });
    expect(trigger).toHaveTextContent("gpt-4.1-mini");
    await user.click(trigger);

    expect(screen.getByRole("menuitem", { name: /^模型/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^思考强度/ })).toBeNull();
  });

  it("keeps the root rows visible while a submenu is flown out", async () => {
    const user = userEvent.setup();
    renderComposer({ models: MODELS, model: FLASH.id });

    await user.click(screen.getByRole("button", { name: "模型与思考强度" }));
    const modelRow = screen.getByRole("menuitem", { name: /^模型/ });
    await user.click(modelRow);

    // Both root rows stay in place beside the flyout options.
    expect(modelRow).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: /^思考强度/ })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "模型" })).toBeInTheDocument();

    // Tapping the row again folds the flyout; tapping the other row swaps it.
    await user.click(modelRow);
    expect(screen.queryByRole("menu", { name: "模型" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: /^思考强度/ }));
    expect(screen.getByRole("menu", { name: "思考强度" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "模型" })).toBeNull();
  });

  it("unfolds thinking options above the row on mobile viewports", async () => {
    const user = userEvent.setup();
    // jsdom reports documentElement.clientWidth 0 → the mobile branch.
    renderComposer({ models: MODELS, model: LUNA.id });

    await user.click(screen.getByRole("button", { name: "模型与思考强度" }));
    const levelRow = screen.getByRole("menuitem", { name: /^思考强度/ });
    await user.click(levelRow);

    const list = screen.getByRole("menu", { name: "思考强度" });
    // The list precedes the row in DOM order, so the bottom-anchored panel
    // grows upward toward the 模型 row.
    expect(
      list.compareDocumentPosition(levelRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(list.className).not.toContain("absolute");
  });

  it("keeps the thinking flyout beside the row on desktop viewports", async () => {
    const user = userEvent.setup();
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: 1280,
      configurable: true,
    });
    try {
      renderComposer({ models: MODELS, model: LUNA.id });

      await user.click(screen.getByRole("button", { name: "模型与思考强度" }));
      const levelRow = screen.getByRole("menuitem", { name: /^思考强度/ });
      await user.click(levelRow);

      const list = screen.getByRole("menu", { name: "思考强度" });
      expect(
        levelRow.compareDocumentPosition(list) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(list.className).toContain("absolute");
    } finally {
      // Drop the own property so the prototype getter takes over again.
      Reflect.deleteProperty(document.documentElement, "clientWidth");
    }
  });

  it("closes the picker when clicking outside", async () => {
    const user = userEvent.setup();
    renderComposer({ models: MODELS, model: FLASH.id });

    await user.click(screen.getByRole("button", { name: "模型与思考强度" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(screen.getByPlaceholderText("有问题，尽管问"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

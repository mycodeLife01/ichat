import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

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
};
const PRO = {
  id: "deepseek-v4-pro",
  provider: "deepseek",
  label: "deepseek-v4-pro",
  thinking_levels: ["high", "max"],
  default: false,
};
const LUNA = {
  id: "openai/gpt-5.6-luna",
  provider: "openai",
  label: "gpt-5.6-luna",
  thinking_levels: ["low", "medium", "high", "xhigh", "max"],
  default: false,
};
const NO_THINKING = {
  id: "gpt-4.1-mini",
  provider: "openai",
  label: "gpt-4.1-mini",
  thinking_levels: [] as string[],
  default: false,
};
const MODELS = [FLASH, PRO, LUNA, NO_THINKING];

describe("Composer", () => {
  it("disables send when empty (idle)", () => {
    renderComposer();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("enables send with non-empty input (idle)", () => {
    renderComposer({ value: "hi" });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
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

  it("toggles the web search tool and disables it when unavailable", async () => {
    const onWebSearchEnabledChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderComposer({ onWebSearchEnabledChange });

    const searchButton = screen.getByRole("button", { name: "智能搜索" });
    expect(searchButton).toHaveAttribute("aria-pressed", "false");
    await user.click(searchButton);
    expect(onWebSearchEnabledChange).toHaveBeenCalledWith(true);

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
        webSearchAvailable={false}
        onWebSearchEnabledChange={onWebSearchEnabledChange}
      />,
    );
    expect(screen.getByRole("button", { name: "智能搜索" })).toBeDisabled();
  });

  it("exposes the web search toggle as pressed while enabled", () => {
    renderComposer({ webSearchEnabled: true });
    const searchButton = screen.getByRole("button", { name: "智能搜索" });
    expect(searchButton).toHaveAttribute("aria-pressed", "true");
    expect(searchButton).toHaveClass(
      "border-search-border",
      "bg-search-soft",
      "text-search-foreground",
      "hover:bg-search-soft-hover",
    );
  });

  it("shows the model label and thinking level on the picker trigger", () => {
    renderComposer({ models: MODELS, model: FLASH.id, thinkingLevel: "max" });
    expect(
      screen.getByRole("button", { name: "模型与思考强度" }),
    ).toHaveTextContent("deepseek-v4-flash 极致");
    expect(screen.queryByRole("menu")).toBeNull();
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

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ThinkingBlock } from "./ThinkingBlock";

function header() {
  return screen.getByRole("button");
}

function mode(container: HTMLElement) {
  return container.querySelector(".thinking")?.getAttribute("data-thinking-mode");
}

describe("ThinkingBlock", () => {
  it("rolls the latest headline into the header while streaming", () => {
    render(<ThinkingBlock content={"**第一段**\n后续想法"} streaming />);
    expect(screen.getByRole("button", { name: /第一段/ })).toBeInTheDocument();
    expect(screen.queryByText("正在思考")).toBeNull();
  });

  it("falls back to 正在思考 while streaming without reasoning text", () => {
    render(<ThinkingBlock content="" streaming />);
    expect(screen.getByText("正在思考")).toBeInTheDocument();
  });

  it("shows raw streaming reasoning in the viewport behind a generic label", () => {
    const { container } = render(
      <ThinkingBlock content="DeepSeek 正在逐步推理" streaming />,
    );

    expect(header()).toHaveTextContent("正在思考");
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(mode(container)).toBe("preview");
    const viewport = container.querySelector(".thinking-window");
    expect(viewport).toHaveTextContent("DeepSeek 正在逐步推理");
    // The live mirror is decorative; assistive tech follows the header.
    expect(viewport).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".thinking-body")).toBeNull();
  });

  it("drops summary headline markers from the viewport", () => {
    const { container } = render(
      <ThinkingBlock content={"**Planning**\n\n先整理需求。**Checking**\n\n再核对约束。"} streaming />,
    );
    const viewport = container.querySelector(".thinking-window");
    expect(viewport?.textContent).toBe("先整理需求。\n再核对约束。");
  });

  it("toggles between the viewport and the full content while streaming", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <ThinkingBlock content="第一段想法" streaming />,
    );

    await user.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(mode(container)).toBe("full");
    expect(container.querySelector(".thinking-window")).toBeNull();
    expect(container.querySelector(".thinking-body")).toHaveTextContent("第一段想法");

    // New deltas never override the user's choice.
    rerender(<ThinkingBlock content="第一段想法，继续推理" streaming />);
    expect(mode(container)).toBe("full");

    await user.click(header());
    expect(mode(container)).toBe("preview");
  });

  it("keeps the streaming header geometry stable across the first reasoning delta", () => {
    const { container, rerender } = render(<ThinkingBlock content={"\n"} streaming />);
    const block = container.querySelector(".thinking");
    const rowClassName = block?.firstElementChild?.className;
    expect(container.querySelector(".thinking-window")).toBeNull();

    rerender(<ThinkingBlock content="第一段想法" streaming />);

    // Header padding is unconditional: if the empty status used a different
    // vertical geometry, the first delta would nudge the label mid-stream.
    expect(block?.className).not.toContain("h-7");
    expect(block?.className).toContain("py-0.5");
    expect(block?.firstElementChild?.className).toBe(rowClassName);
  });

  it.each([
    ["the viewport", false],
    ["the full content", true],
  ])("collapses from %s when thinking ends", async (_name, expanded) => {
    const user = userEvent.setup();
    const { container, rerender } = render(<ThinkingBlock content="思考过程" streaming />);
    if (expanded) await user.click(header());

    rerender(<ThinkingBlock content="思考过程" streaming={false} />);

    expect(screen.getByRole("button", { name: /已思考/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(mode(container)).toBe("collapsed");
    expect(container.querySelector(".thinking-window")).toBeNull();
    expect(container.querySelector(".thinking-body")).toBeNull();
  });

  it("toggles only the full content after thinking ends", async () => {
    const user = userEvent.setup();
    const { container } = render(<ThinkingBlock content="推理内容" streaming={false} />);
    expect(mode(container)).toBe("collapsed");

    await user.click(header());
    expect(mode(container)).toBe("full");
    await user.click(header());
    expect(mode(container)).toBe("collapsed");
    expect(container.querySelector(".thinking-window")).toBeNull();
  });

  it("keeps a choice made after thinking ends across the handoff to history", async () => {
    const user = userEvent.setup();
    const { container, rerender, unmount } = render(
      <ThinkingBlock content="推理内容" streaming handoffKey="run-handoff" />,
    );
    rerender(<ThinkingBlock content="推理内容" streaming={false} handoffKey="run-handoff" />);
    await user.click(header());
    expect(mode(container)).toBe("full");
    unmount();

    const history = render(
      <ThinkingBlock content="推理内容" streaming={false} handoffKey="run-handoff" />,
    );
    expect(mode(history.container)).toBe("full");
  });

  it("renders summary headlines as headings in the full content", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ThinkingBlock
        content={"**Planning**\n\n先整理需求，结论是**方案 A**更好。**Checking**\n\n再核对约束。"}
        streaming={false}
      />,
    );
    await user.click(header());

    const headings = [...container.querySelectorAll(".thinking-body h4")].map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["Planning", "Checking"]);
    // Inline emphasis mid-sentence stays emphasis.
    expect(container.querySelector(".thinking-body strong")).toHaveTextContent("方案 A");
    expect(container.querySelector(".thinking-body")?.textContent).not.toContain("**");
  });

  it("prefers an explicit label over the reasoning preview", () => {
    render(<ThinkingBlock content="**推理标题**\n内容" streaming label="正在搜索 天气" />);
    expect(header()).toHaveTextContent("正在搜索 天气");
    expect(header()).not.toHaveTextContent("推理标题");
  });

  it("renders the full content without an internal scrollbar cap", async () => {
    const user = userEvent.setup();
    const { container } = render(<ThinkingBlock content="推理内容" streaming />);
    await user.click(header());
    const body = container.querySelector(".thinking-body");

    expect(body?.className).not.toContain("max-h");
    expect(body?.className).not.toContain("overflow-y-auto");
  });
});

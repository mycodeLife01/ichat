import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ThinkingBlock } from "./ThinkingBlock";

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

  it("auto-expands raw streaming reasoning behind a generic label", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ThinkingBlock
        content="DeepSeek 正在逐步推理"
        streaming
        showStreamingPreview={false}
        autoExpandWhileStreaming
      />,
    );

    const header = screen.getByRole("button", { name: /正在思考/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header).not.toHaveTextContent("DeepSeek 正在逐步推理");
    expect(screen.getByText("DeepSeek 正在逐步推理")).not.toHaveClass("hidden");

    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("DeepSeek 正在逐步推理")).toHaveClass("hidden");

    rerender(
      <ThinkingBlock
        content="DeepSeek 正在逐步推理，新增内容"
        streaming
        showStreamingPreview={false}
        autoExpandWhileStreaming
      />,
    );
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("prefers an explicit label over the reasoning preview", () => {
    render(<ThinkingBlock content="推理内容" streaming label="正在搜索 天气" />);
    // The collapsed body keeps the text in the DOM (hidden), so assert on the
    // header specifically.
    expect(
      screen.getByRole("button", { name: /正在搜索 天气/ }),
    ).not.toHaveTextContent("推理内容");
  });

  it("starts collapsed and shows the done label when not streaming", () => {
    render(<ThinkingBlock content="推理内容" streaming={false} />);
    expect(screen.getByRole("button", { name: /已思考/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps the rolling preview in the header when expanded", async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock content={"**第一段**\n\n推理内容"} streaming />);
    const header = screen.getByRole("button", { name: /第一段/ });
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    // Expanded: the body unfolds while the header keeps rolling the preview.
    expect(header).toHaveTextContent("第一段");
    expect(screen.queryByText("正在思考")).toBeNull();
    expect(screen.getByText(/推理内容/)).toBeInTheDocument();
  });

  it("stays expanded when streaming turns false", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <ThinkingBlock content="想法" streaming={true} />,
    );
    await user.click(screen.getByRole("button", { name: /想法/ }));
    expect(container.querySelector(".thinking")?.className).not.toContain("collapsed");

    rerender(<ThinkingBlock content="想法" streaming={false} />);
    expect(container.querySelector(".thinking")?.className).not.toContain("collapsed");
  });

  it("renders reasoning content without an internal scrollbar cap", () => {
    const { container } = render(<ThinkingBlock content="推理内容" streaming={true} />);
    const body = container.querySelector(".thinking-body");

    expect(body?.className).not.toContain("max-h");
    expect(body?.className).not.toContain("overflow-y-auto");
  });
});

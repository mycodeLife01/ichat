import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ThinkingBlock } from "./ThinkingBlock";

describe("ThinkingBlock", () => {
  it("starts expanded and shows the done label", () => {
    render(<ThinkingBlock content="推理内容" streaming={false} />);
    expect(screen.getByText("已思考")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /已思考/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("toggles closed on click", async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock content="推理内容" streaming={false} />);
    const header = screen.getByRole("button", { name: /已思考/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("stays expanded when streaming turns false", () => {
    const { container, rerender } = render(
      <ThinkingBlock content="想法" streaming={true} />,
    );
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

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ThinkingBlock } from "./ThinkingBlock";

describe("ThinkingBlock", () => {
  it("starts collapsed and shows the done label", () => {
    render(<ThinkingBlock content="推理内容" streaming={false} />);
    expect(screen.getByText("已思考")).toBeInTheDocument();
  });

  it("toggles open on click", async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock content="推理内容" streaming={false} />);
    const header = screen.getByRole("button", { name: /已思考/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
  });
});

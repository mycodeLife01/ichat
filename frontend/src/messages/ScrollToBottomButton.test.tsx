import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScrollToBottomButton } from "./ScrollToBottomButton";

describe("ScrollToBottomButton", () => {
  it("keeps the hidden control out of the accessibility tree", () => {
    const { container } = render(
      <ScrollToBottomButton visible={false} onClick={() => {}} />,
    );

    const button = container.querySelector(".scroll-to-bottom-button");
    expect(button).toHaveAttribute("data-visible", "false");
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveAttribute("tabindex", "-1");
  });

  it("becomes accessible and invokes the return-to-latest action", () => {
    const onClick = vi.fn();
    render(<ScrollToBottomButton visible onClick={onClick} />);

    const button = screen.getByRole("button", { name: "滚动到底部" });
    expect(button).toHaveAttribute("data-visible", "true");
    expect(button).not.toHaveAttribute("aria-hidden");
    expect(button).toHaveAttribute("tabindex", "0");
    expect(button.querySelector('[data-icon="scroll-to-bottom"]')).toBeInTheDocument();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

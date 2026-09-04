import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReplyQuote } from "./ReplyQuote";

describe("ReplyQuote", () => {
  it("makes the complete sent quote one native source button when resolvable", async () => {
    const user = userEvent.setup();
    const onReveal = vi.fn();
    render(<ReplyQuote excerpt="quoted answer" variant="message" onReveal={onReveal} />);

    const button = screen.getByRole("button", { name: "quoted answer" });
    await user.click(button);

    expect(onReveal).toHaveBeenCalledOnce();
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps an unresolved sent quote static", () => {
    render(<ReplyQuote excerpt="quoted answer" variant="message" />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("quoted answer")).toBeInTheDocument();
  });

  it("keeps Composer source details and removal as sibling buttons", async () => {
    const user = userEvent.setup();
    const onReveal = vi.fn();
    const onRemove = vi.fn();
    render(
      <ReplyQuote
        excerpt="quoted answer"
        variant="composer"
        onReveal={onReveal}
        onRemove={onRemove}
      />,
    );

    const details = screen.getByRole("button", { name: "有关回复内容的详情" });
    const remove = screen.getByRole("button", { name: "取消引用" });
    expect(details.parentElement).toBe(remove.parentElement);
    expect(details.contains(remove)).toBe(false);

    await user.click(details);
    expect(onReveal).toHaveBeenCalledOnce();
    expect(onRemove).not.toHaveBeenCalled();
  });
});

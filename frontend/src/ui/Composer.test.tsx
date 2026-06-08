import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

describe("Composer", () => {
  it("renders the placeholder and a disabled send button", () => {
    render(<Composer value="" onChange={() => {}} />);
    expect(screen.getByPlaceholderText("有问题，尽管问")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("calls onChange when typing", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="" onChange={onChange} />);
    await user.type(screen.getByPlaceholderText("有问题，尽管问"), "x");
    expect(onChange).toHaveBeenCalled();
  });

  it("does not submit on Enter this step", async () => {
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={() => {}} />);
    const textarea = screen.getByPlaceholderText("有问题，尽管问");
    textarea.focus();
    await user.keyboard("{Enter}");
    // No throw / no send handler exists; send button stays disabled.
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BottomSheet } from "./BottomSheet";

describe("BottomSheet", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <BottomSheet open={false} onClose={() => {}}>
        <button>复制</button>
      </BottomSheet>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the panel and children when open", () => {
    render(
      <BottomSheet open onClose={() => {}}>
        <button>复制</button>
      </BottomSheet>,
    );
    expect(screen.getByRole("button", { name: "复制" })).toBeInTheDocument();
    expect(document.querySelector(".sheet")).not.toBeNull();
    expect(document.querySelector(".sheet-handle")).not.toBeNull();
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <BottomSheet open onClose={onClose}>
        <button>复制</button>
      </BottomSheet>,
    );
    await user.click(container.querySelector(".sheet-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the panel content is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <BottomSheet open onClose={onClose}>
        <button>复制</button>
      </BottomSheet>,
    );
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

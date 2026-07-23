import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Icons } from "./icons";

describe("Icons", () => {
  it("exposes the icons used across the chat shell", () => {
    const names = [
      "More", "Pen", "Pencil", "Trash", "NewChat", "PanelLeft", "LogOut",
      "Menu", "Chevron", "Copy", "Check", "Refresh", "Share", "Loading",
      "ArrowUp", "Mic", "Stop", "Close",
    ] as const;
    for (const name of names) {
      expect(Icons[name]).toBeDefined();
    }
  });

  it("renders an icon", () => {
    const { container } = render(<Icons.NewChat size={20} />);
    const icon = container.querySelector('[data-icon="new-chat"]');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("viewBox", "0 0 20 20");
    expect(icon).toHaveAttribute("fill", "currentColor");
    expect(icon?.querySelectorAll("path")).toHaveLength(1);
  });

  it("provides the ChatGPT-style sidebar toggle icon", () => {
    const { container } = render(<Icons.PanelLeft size={18} />);
    const icon = container.querySelector('[data-icon="sidebar-toggle"]');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("viewBox", "0 0 20 20");
    expect(icon?.querySelectorAll("path")).toHaveLength(2);
  });
});

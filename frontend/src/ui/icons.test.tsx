import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Icons } from "./icons";

describe("Icons", () => {
  it("exposes the icons used across the chat shell", () => {
    const names = [
      "More", "Pen", "Pencil", "Trash", "NewChat", "PanelLeft", "LogOut",
      "Menu", "Chevron", "Copy", "Check", "Refresh", "Share", "Loading",
      "ArrowUp", "ArrowDown", "Mic", "Stop", "Close",
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
    expect(icon?.querySelectorAll("path")).toHaveLength(2);
  });

  it("provides the ChatGPT-style sidebar toggle icon", () => {
    const { container } = render(<Icons.PanelLeft size={18} />);
    const icon = container.querySelector('[data-icon="sidebar-toggle"]');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("viewBox", "0 0 20 20");
    expect(icon).toHaveAttribute("fill", "currentColor");
    expect(icon?.querySelectorAll("path")).toHaveLength(1);
  });

  it("provides the ChatGPT-style composer send icon", () => {
    const { container } = render(<Icons.ArrowUp size={20} />);
    const icon = container.querySelector('[data-icon="send-prompt"]');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("viewBox", "0 0 20 20");
    expect(icon).toHaveAttribute("fill", "currentColor");
    expect(icon?.querySelector("path")).toHaveAttribute(
      "d",
      "M9 16V6.414L5.707 9.707a1 1 0 1 1-1.414-1.414l5-5 .076-.069a1 1 0 0 1 1.338.069l5 5 .068.076a1 1 0 0 1-1.406 1.406l-.076-.068L11 6.414V16a1 1 0 1 1-2 0",
    );
  });

  it("provides the ChatGPT-style scroll-to-bottom icon", () => {
    const { container } = render(<Icons.ArrowDown size={20} />);
    const icon = container.querySelector('[data-icon="scroll-to-bottom"]');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("viewBox", "0 0 20 20");
    expect(icon).toHaveAttribute("fill", "currentColor");
    expect(icon?.querySelector("path")).toHaveAttribute(
      "d",
      "M10 2.668c.368 0 .665.298.665.665V15.06l4.698-4.698a.666.666 0 0 1 .94.942l-5.538 5.538a1.083 1.083 0 0 1-1.53 0l-5.54-5.538a.667.667 0 0 1 .942-.942l4.698 4.698V3.333c0-.367.298-.665.665-.665",
    );
  });
});

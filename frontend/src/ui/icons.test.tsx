import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Icons } from "./icons";

describe("Icons", () => {
  it("exposes the icons used across the chat shell", () => {
    const names = [
      "More", "Pen", "Pencil", "Trash", "Plus", "PanelLeft", "LogOut",
      "Menu", "Chevron", "Copy", "Check", "Refresh", "ArrowUp", "Mic", "Stop", "Close",
    ] as const;
    for (const name of names) {
      expect(Icons[name]).toBeDefined();
    }
  });

  it("renders an icon", () => {
    const { container } = render(<Icons.Plus size={14} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

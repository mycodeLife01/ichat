import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Topbar } from "./Topbar";

const noop = () => {};

describe("Topbar", () => {
  it("shows the title", () => {
    render(
      <Topbar
        title="我的对话"
        titlePending={false}
        isMobile={false}
        sidebarCollapsed={false}
        onOpenMobile={noop}
        onToggleSidebar={noop}
        onNewMobile={noop}
      />,
    );
    expect(screen.getByText("我的对话")).toBeInTheDocument();
  });

  it("falls back to 新对话 when title empty", () => {
    render(
      <Topbar
        title={null}
        titlePending={false}
        isMobile={false}
        sidebarCollapsed={false}
        onOpenMobile={noop}
        onToggleSidebar={noop}
        onNewMobile={noop}
      />,
    );
    expect(screen.getByText("新对话")).toBeInTheDocument();
  });

  it("shows a skeleton while title pending", () => {
    const { container } = render(
      <Topbar
        title={null}
        titlePending
        isMobile={false}
        sidebarCollapsed={false}
        onOpenMobile={noop}
        onToggleSidebar={noop}
        onNewMobile={noop}
      />,
    );
    expect(container.querySelector(".title-skeleton")).toBeInTheDocument();
  });
});

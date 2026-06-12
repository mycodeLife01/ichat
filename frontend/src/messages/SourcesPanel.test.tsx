import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { MessageSource } from "../api/types";
import { SourcesPanel } from "./SourcesPanel";

const sources: MessageSource[] = [
  {
    id: 1,
    title: "Release notes",
    url: "https://www.example.com/releases",
    snippet: "Version 1.2 shipped.",
    published_at: "2026-06-11",
    provider: "tavily",
  },
  {
    id: 2,
    title: "Changelog",
    url: "https://docs.example.org/changelog",
    snippet: null,
    published_at: null,
    provider: "tavily",
  },
];

describe("SourcesPanel", () => {
  it("lists every source as an external link with domain and snippet", () => {
    render(<SourcesPanel sources={sources} open onClose={() => {}} />);

    expect(screen.getByText("· 2")).toBeInTheDocument();

    const first = screen.getByRole("link", { name: /Release notes/ });
    expect(first).toHaveAttribute("href", "https://www.example.com/releases");
    expect(first).toHaveAttribute("target", "_blank");
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("Version 1.2 shipped.")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /Changelog/ })).toHaveAttribute(
      "href",
      "https://docs.example.org/changelog",
    );
  });

  it("collapses to a zero-width column when closed (desktop)", () => {
    const { container } = render(
      <SourcesPanel sources={sources} open={false} onClose={() => {}} />,
    );

    const aside = container.querySelector("aside.sources-panel");
    expect(aside).not.toBeNull();
    expect(aside!.className).toContain("w-0");
    expect(aside!.className).not.toContain("open");
  });

  it("closes via the close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SourcesPanel sources={sources} open onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "关闭来源" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes via the scrim on mobile", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <SourcesPanel sources={sources} open isMobile onClose={onClose} />,
    );

    const scrim = container.querySelector(".scrim");
    expect(scrim).not.toBeNull();
    await user.click(scrim!);
    expect(onClose).toHaveBeenCalled();
  });
});

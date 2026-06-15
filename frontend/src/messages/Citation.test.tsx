import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { MessageSource } from "../api/types";
import { Markdown } from "./Markdown";

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
    title: "Changelog detail",
    url: "https://docs.example.org/changelog",
    snippet: "Full changelog entry.",
    published_at: "2026-06-10",
    provider: "tavily",
  },
];

// Renders through the real Markdown → rehypeCitations → Citation path, which
// also verifies the custom <citation> element survives sanitize and the plugin
// passes citeIds via node.properties.
describe("Citation (via Markdown)", () => {
  it("renders a merged citation chip with the primary domain and +N", () => {
    render(<Markdown content={"结论[1][2]。"} sources={sources} />);
    const chip = screen.getByRole("button", { name: "查看 2 个引用来源" });
    // Chip shows the bare site name (TLD stripped), not the full domain.
    expect(chip).toHaveTextContent("example");
    expect(chip).not.toHaveTextContent("example.com");
    expect(chip).toHaveTextContent("+1");
  });

  it("opens a pageable overview card on hover and flips pages", async () => {
    const user = userEvent.setup();
    render(<Markdown content={"结论[1][2]。"} sources={sources} />);

    await user.hover(screen.getByRole("button", { name: "查看 2 个引用来源" }));
    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "下一个来源" }));
    expect(screen.getByText("Changelog detail")).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("toggles the card on click for mobile (no hover)", async () => {
    const user = userEvent.setup();
    render(<Markdown content={"结论[1]。"} sources={sources} isMobile />);

    const chip = screen.getByRole("button", { name: "查看 1 个引用来源" });
    expect(screen.queryByText("Release notes")).toBeNull();
    await user.click(chip);
    expect(screen.getByText("Release notes")).toBeInTheDocument();
    await user.click(chip);
    expect(screen.queryByText("Release notes")).toBeNull();
  });

  it("leaves an out-of-range marker as plain text (no chip)", () => {
    render(<Markdown content={"无来源[9]。"} sources={sources} />);
    expect(screen.queryByRole("button", { name: /引用来源/ })).toBeNull();
    expect(screen.getByText(/无来源\[9\]。/)).toBeInTheDocument();
  });
});

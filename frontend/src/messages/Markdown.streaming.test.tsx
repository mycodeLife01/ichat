import { act, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  completedPrefixText,
  streamingMarkdownFixtures,
} from "../test/streamingMarkdownFixtures";
import { Markdown } from "./Markdown";

describe.each(streamingMarkdownFixtures)("Markdown streaming prefix: $label", (fixture) => {
  it("renders every cumulative prefix safely without swallowing completed prose", () => {
    const complete = fixture.prefixes.at(-1) ?? "";
    const { container, rerender } = render(<Markdown content="" streaming />);

    for (const prefix of fixture.prefixes) {
      expect(complete.startsWith(prefix)).toBe(true);
      expect(() => rerender(<Markdown content={prefix} streaming />)).not.toThrow();
      if (prefix.includes(completedPrefixText)) {
        expect(container).toHaveTextContent(completedPrefixText);
      }
      expect(container.querySelector(".katex-error")).toBeNull();
      expect(container.querySelector("script, [onclick], [onerror]")).toBeNull();
    }
  });

  it("settles into the expected semantic surface when the prefix completes", () => {
    const complete = fixture.prefixes.at(-1) ?? "";
    const { container, rerender } = render(<Markdown content={complete} streaming />);

    const streamingSurface = fixture.completedSelector
      ? container.querySelector(fixture.completedSelector)
      : container;
    expect(streamingSurface).not.toBeNull();
    expect(streamingSurface).toHaveTextContent(fixture.completedText);

    rerender(<Markdown content={complete} />);

    const surface = fixture.completedSelector
      ? container.querySelector(fixture.completedSelector)
      : container;
    expect(surface).not.toBeNull();
    expect(surface).toBe(streamingSurface);
    expect(surface).toHaveTextContent(fixture.completedText);
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.querySelector("script, [onclick], [onerror]")).toBeNull();
  });
});

describe("Markdown closed streaming blocks", () => {
  it("preserves code and table interaction state when later deltas append", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const closedBlocks = [
      "```typescript",
      "const answer: number = 42;",
      "```",
      "",
      "| Surface | State |",
      "| --- | --- |",
      "| Markdown | stable |",
    ].join("\n");
    const { container, rerender } = render(<Markdown content={closedBlocks} streaming />);
    const codeBlock = container.querySelector<HTMLElement>("[data-code-block]")!;
    const codeViewport = codeBlock.querySelector<HTMLElement>("[data-code-viewport]")!;
    const tableBlock = container.querySelector<HTMLElement>("[data-table-block]")!;
    const tableViewport = tableBlock.querySelector<HTMLElement>("[data-table-viewport]")!;

    codeViewport.scrollLeft = 37;
    tableViewport.scrollLeft = 29;
    await user.click(within(codeBlock).getByRole("button", { name: "复制代码" }));
    await user.click(within(tableBlock).getByRole("button", { name: "复制表格" }));

    await act(async () => {
      rerender(<Markdown content={`${closedBlocks}\n\n后续 delta`} streaming />);
    });

    expect(container.querySelector("[data-code-block]")).toBe(codeBlock);
    expect(container.querySelector("[data-table-block]")).toBe(tableBlock);
    expect(codeViewport.scrollLeft).toBe(37);
    expect(tableViewport.scrollLeft).toBe(29);
    expect(within(codeBlock).getByRole("button", { name: "已复制" })).toBeInTheDocument();
    expect(
      within(tableBlock).getByRole("button", { name: "已复制表格" }),
    ).toBeInTheDocument();

    vi.restoreAllMocks();
  });
});

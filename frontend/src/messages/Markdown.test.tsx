import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders GFM content", () => {
    const { container } = render(<Markdown content={"# 标题\n\n- 一\n- 二"} />);
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("does not render raw/dangerous html", () => {
    // react-markdown ignores raw HTML by default (no rehype-raw), and
    // rehype-sanitize is a second guard; the dangerous <img> must not appear.
    const { container } = render(
      <Markdown content={"<img src=x onerror=alert(1) />\n\n正常文本"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("正常文本")).toBeInTheDocument();
  });

  it("renders a resident copy button on code blocks and copies their text", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    render(<Markdown content={"```\nconst a = 1;\n```"} />);

    const copyBtn = screen.getByRole("button", { name: "复制代码" });
    await user.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("const a = 1;\n");
    // Feedback: the accessible name flips to 已复制.
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  it("does not render a copy button without code blocks", () => {
    render(<Markdown content={"普通段落,`行内代码`不算"} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders citation chips only when sources are provided", () => {
    const sources = [
      {
        id: 1,
        title: "Doc",
        url: "https://www.example.com/a",
        snippet: "s",
        published_at: null,
        provider: "tavily",
      },
    ];
    // Without sources: marker stays plain text.
    const { rerender } = render(<Markdown content={"看[1]"} />);
    expect(screen.queryByRole("button", { name: /引用来源/ })).toBeNull();
    expect(screen.getByText(/看\[1\]/)).toBeInTheDocument();

    // With sources: marker becomes a chip.
    rerender(<Markdown content={"看[1]"} sources={sources} />);
    expect(screen.getByRole("button", { name: "查看 1 个引用来源" })).toBeInTheDocument();
  });
});

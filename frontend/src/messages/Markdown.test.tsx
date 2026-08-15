import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("keeps the legacy hooks inside the assistant typography scope", () => {
    const { container } = render(<Markdown content="正文" />);

    expect(container.querySelector(".assistant-markdown.body.md")).not.toBeNull();
  });

  it("renders GFM content", () => {
    const { container } = render(<Markdown content={"# 标题\n\n- 一\n- 二"} />);
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders source line breaks inside a paragraph as visible breaks", () => {
    const { container } = render(<Markdown content={"第一行\n第二行"} />);

    const paragraph = container.querySelector("p");
    expect(paragraph?.querySelector("br")).not.toBeNull();
    expect(paragraph?.textContent).toBe("第一行\n第二行");
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

  it("renders fenced code in a labeled surface with a separate source viewport", () => {
    const { container } = render(
      <Markdown content={"```ts\nconst answer: number = 42;\n```"} />,
    );

    const surface = container.querySelector<HTMLElement>("[data-code-block]");
    const viewport = surface?.querySelector<HTMLElement>("[data-code-viewport]");

    expect(surface).not.toBeNull();
    expect(within(surface!).getByText("TypeScript")).toBeInTheDocument();
    expect(viewport).not.toBeNull();
    expect(viewport).toHaveTextContent("const answer: number = 42;");
    expect(viewport?.textContent).toBe("const answer: number = 42;");
    expect(viewport?.contains(within(surface!).getByText("TypeScript"))).toBe(false);
  });

  it("removes only the parser newline from an unlabeled fence", () => {
    const source = "  first\tline\n\n  third  ";
    const { container } = render(<Markdown content={`\`\`\`\n${source}\n\`\`\``} />);

    expect(container.querySelector(".code-block-plain")).not.toBeNull();
    expect(container.querySelector(".code-block-header")).toBeNull();
    expect(container.querySelector("[data-code-viewport]")?.textContent).toBe(source);
  });

  it("renders syntax tokens for a supported fenced-code language", async () => {
    const { container } = render(
      <Markdown content={"```typescript\nconst answer: number = 42;\n```"} />,
    );

    await waitFor(() => {
      expect(container.querySelector(".code-block .token.keyword")).toHaveTextContent(
        "const",
      );
      expect(container.querySelector(".code-block .token.number")).toHaveTextContent("42");
    });
  });

  it("preserves an unknown language label and renders its source as plaintext", async () => {
    const { container } = render(
      <Markdown content={"```not-a-language\nunknown_call(42)\n```"} />,
    );

    expect(screen.getByText("not-a-language")).toBeInTheDocument();
    expect(container.querySelector("[data-code-viewport]")).toHaveTextContent("unknown_call(42)");
    await waitFor(() => expect(container.querySelector("[data-code-viewport] .token")).toBeNull());
    expect(container.querySelector("[data-code-viewport] .token.keyword")).toBeNull();
  });

  it("keeps HTML, citation markers, and math delimiters inert inside code", () => {
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
    const source = '<script>alert("x")</script> [1] \\(x\\)';
    const { container } = render(
      <Markdown content={`\`\`\`html\n${source}\n\`\`\``} sources={sources} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".katex")).toBeNull();
    expect(screen.queryByRole("button", { name: /引用来源/ })).toBeNull();
    expect(container.querySelector("[data-code-viewport]")?.textContent).toBe(source);
  });

  it("shows the ChatGPT-style Python run affordance without claiming local execution", () => {
    const { container } = render(<Markdown content={"```python\nprint('hello')\n```"} />);

    const surface = container.querySelector<HTMLElement>("[data-code-block]");
    const runButton = within(surface!).getByRole("button", { name: "运行代码" });

    expect(surface).toHaveAttribute("data-language", "python");
    expect(runButton).toHaveTextContent("运行");
    expect(runButton).toHaveAttribute("aria-disabled", "true");
    expect(within(surface!).getByRole("button", { name: "复制代码" })).toBeInTheDocument();
  });

  it("switches an HTML fence between code and a sandboxed preview", async () => {
    const user = userEvent.setup();
    const source = "<!doctype html><h1>Safe preview</h1><script>alert('blocked')</script>";
    const { container } = render(
      <Markdown content={`\`\`\`html\n${source}\n\`\`\``} />,
    );

    const surface = container.querySelector<HTMLElement>("[data-code-block]")!;
    const codeButton = within(surface).getByRole("button", { name: "代码" });
    const previewButton = within(surface).getByRole("button", { name: "预览" });

    expect(surface).toHaveAttribute("data-code-view", "code");
    expect(codeButton).toHaveAttribute("aria-pressed", "true");
    expect(previewButton).toHaveAttribute("aria-pressed", "false");
    expect(surface.querySelector("iframe")).toBeNull();
    expect(surface.querySelector("[data-code-viewport]")).toHaveTextContent(source);

    await user.click(previewButton);

    const iframe = within(surface).getByTitle<HTMLIFrameElement>("预览");
    expect(surface).toHaveAttribute("data-code-view", "preview");
    expect(codeButton).toHaveAttribute("aria-pressed", "false");
    expect(previewButton).toHaveAttribute("aria-pressed", "true");
    expect(surface.querySelector("[data-code-viewport]")).toBeNull();
    expect(iframe).toHaveAttribute("sandbox", "");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(iframe).toHaveAttribute("srcdoc", source);
    expect(within(surface).getByRole("button", { name: "全屏" })).toBeInTheDocument();
    expect(within(surface).queryByRole("button", { name: "复制代码" })).toBeNull();

    await user.click(codeButton);
    expect(surface).toHaveAttribute("data-code-view", "code");
    expect(surface.querySelector("iframe")).toBeNull();
    expect(surface.querySelector("[data-code-viewport]")).toHaveTextContent(source);
  });

  it("keeps an unfinished fence visible and updates the same code surface when it closes", async () => {
    const prefix = "正文保持可见。\n\n```typescript\nconst answer: number = 42;";
    const { container, rerender } = render(<Markdown content={prefix} streaming />);

    const surface = container.querySelector("[data-code-block]");
    expect(screen.getByText("正文保持可见。")).toBeInTheDocument();
    expect(surface).not.toBeNull();
    expect(surface?.querySelector("[data-code-viewport]")).toHaveTextContent(
      "const answer: number = 42;",
    );

    rerender(<Markdown content={`${prefix}\n\`\`\``} />);

    expect(container.querySelector("[data-code-block]")).toBe(surface);
    await waitFor(() =>
      expect(surface?.querySelector(".token.keyword")).toHaveTextContent("const"),
    );
  });

  it("keeps math delimiters inside an unfinished code fence as source text", () => {
    const prefix = "已完成正文。\n\n```bash\necho $$\nstill code";
    const { container } = render(<Markdown content={prefix} streaming />);

    expect(screen.getByText("已完成正文。")).toBeInTheDocument();
    expect(container.querySelector("[data-code-viewport]")?.textContent).toBe(
      "echo $$\nstill code",
    );
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("renders a resident copy button on code blocks and copies their text", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    render(<Markdown content={"```\nconst a = 1;\n```"} />);

    const copyBtn = screen.getByRole("button", { name: "复制代码" });
    await user.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
    // Feedback: the accessible name flips to 已复制.
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  it("keeps copying retryable and announces a Clipboard failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new DOMException("Clipboard denied", "NotAllowedError"),
    );

    render(<Markdown content={"```js\nconst answer = 42;\n```"} />);

    await user.click(screen.getByRole("button", { name: "复制代码" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Copy failed. Try again.");
    expect(screen.getByRole("button", { name: "复制代码" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已复制" })).toBeNull();

    vi.restoreAllMocks();
  });

  it("keeps the latest result when repeated copy attempts settle out of order", async () => {
    const user = userEvent.setup();
    let resolveFirst!: () => void;
    let rejectFirst!: (reason: unknown) => void;
    let resolveSecond!: () => void;
    const first = new Promise<void>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    render(<Markdown content={"```js\nconst answer = 42;\n```"} />);

    const copyButton = screen.getByRole("button", { name: "复制代码" });
    await user.click(copyButton);
    await user.click(copyButton);

    await act(async () => resolveSecond());
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();

    await act(async () => rejectFirst(new DOMException("Late failure", "NotAllowedError")));
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(2);

    resolveFirst();
    vi.restoreAllMocks();
  });

  it("clears copy feedback timers when its code surface unmounts", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = render(<Markdown content={"```js\nconst answer = 42;\n```"} />);

    await user.click(screen.getByRole("button", { name: "复制代码" }));
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();

    clearTimeout.mockClear();
    unmount();
    expect(clearTimeout).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it("does not render a copy button without code blocks", () => {
    render(<Markdown content={"普通段落,`行内代码`不算"} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("copies a rendered table as row-ordered TSV", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const content = [
      "| 名称 | Value | 备注 |",
      "| --- | --- | --- |",
      "| 中文 | English | |",
      "| 第二行 | 42 | 完成 |",
    ].join("\n");

    render(<Markdown content={content} />);

    const viewport = screen.getByRole("region", { name: "表格（可横向滚动）" });
    expect(within(viewport).getByRole("table")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "复制表格" }));

    expect(writeText).toHaveBeenCalledWith(
      "名称\tValue\t备注\n中文\tEnglish\t\n第二行\t42\t完成",
    );
    expect(screen.getByRole("button", { name: "已复制表格" })).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  it("keeps table copying retryable and announces a Clipboard failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new DOMException("Clipboard denied", "NotAllowedError"),
    );

    render(<Markdown content={"| A | B |\n| --- | --- |\n| 1 | 2 |"} />);

    await user.click(screen.getByRole("button", { name: "复制表格" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Copy failed. Try again.");
    expect(screen.getByRole("button", { name: "复制表格" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已复制表格" })).toBeNull();

    vi.restoreAllMocks();
  });

  it("keeps copy state and scroll position independent across tables", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const content = [
      "| First | Value |",
      "| --- | --- |",
      "| A | 1 |",
      "",
      "| Second | Value |",
      "| --- | --- |",
      "| B | 2 |",
    ].join("\n");

    const { container } = render(<Markdown content={content} />);
    const surfaces = Array.from(container.querySelectorAll<HTMLElement>("[data-table-block]"));
    const viewports = Array.from(
      container.querySelectorAll<HTMLElement>("[data-table-viewport]"),
    );

    expect(surfaces).toHaveLength(2);
    viewports[0].scrollLeft = 24;
    expect(viewports[0].scrollLeft).toBe(24);
    expect(viewports[1].scrollLeft).toBe(0);

    await user.click(within(surfaces[0]).getByRole("button", { name: "复制表格" }));

    expect(
      within(surfaces[0]).getByRole("button", { name: "已复制表格" }),
    ).toBeInTheDocument();
    expect(
      within(surfaces[1]).getByRole("button", { name: "复制表格" }),
    ).toBeInTheDocument();

    vi.restoreAllMocks();
  });

  it("opens HTTP links outside the current iChat browsing context", () => {
    render(
      <Markdown
        content={"[HTTPS](https://example.com/path) [HTTP](http://example.org/path)"}
      />,
    );

    for (const name of ["HTTPS", "HTTP"]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("target", "_new");
      expect(link).toHaveAttribute("rel", "noopener");
      expect(link.querySelector(".external-link-icon")).not.toBeNull();
    }
  });

  it("keeps relative, hash, and same-origin links in the current context", () => {
    const sameOrigin = `${window.location.origin}/c/conversation-id`;
    render(
      <Markdown
        content={`[Root](/help) [Relative](docs/help) [Hash](#section) [Same origin](${sameOrigin}) [Empty]()`}
      />,
    );

    for (const name of ["Root", "Relative", "Hash", "Same origin"]) {
      const link = screen.getByRole("link", { name });
      expect(link).not.toHaveAttribute("target");
      expect(link).not.toHaveAttribute("rel");
    }

    const emptyDestination = screen.getByText("Empty").closest("a");
    expect(emptyDestination).toHaveAttribute("href", "");
    expect(emptyDestination).not.toHaveAttribute("target");
    expect(emptyDestination).not.toHaveAttribute("rel");
  });

  it("does not restore a dangerous href removed by the Markdown security pipeline", () => {
    const { container } = render(
      <Markdown content={"[Dangerous](javascript:alert('unsafe'))"} />,
    );

    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor).not.toHaveAttribute("href");
    expect(anchor).not.toHaveAttribute("target");
    expect(anchor).not.toHaveAttribute("rel");
  });

  it("preserves task, nested-list, loose-list, and blockquote GFM semantics", () => {
    const content = [
      "- [x] Completed",
      "- [ ] Pending",
      "",
      "## Nested",
      "- Parent",
      "  1. Ordered child",
      "     - Deep child",
      "",
      "## Loose",
      "- First paragraph",
      "",
      "  Second paragraph",
      "",
      "> Quote with ***bold italic*** and ~~removed~~.",
      ">",
      "> Second quoted paragraph.",
    ].join("\n");

    const { container } = render(<Markdown content={content} />);
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeDisabled();
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeDisabled();
    expect(checkboxes[1]).not.toBeChecked();

    const parentItem = screen.getByText("Parent").closest("li");
    expect(parentItem?.querySelector("ol ul")).toHaveTextContent("Deep child");
    expect(screen.getByText("First paragraph").tagName).toBe("P");
    expect(screen.getByText("Second paragraph").tagName).toBe("P");

    const quote = container.querySelector("blockquote");
    expect(quote?.querySelectorAll(":scope > p")).toHaveLength(2);
    expect(quote?.querySelector("strong em, em strong")).toHaveTextContent("bold italic");
    expect(quote?.querySelector("del")).toHaveTextContent("removed");
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

describe("Markdown math", () => {
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

  it("renders inline \\(…\\) math with KaTeX", () => {
    const { container } = render(<Markdown content={"行内 \\(E=mc^2\\) 公式"} />);
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("renders display \\[…\\] math with KaTeX", () => {
    const { container } = render(<Markdown content={"块级 \\[\\int_0^1 x\\,dx\\] 结束"} />);
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("renders $$…$$ math with KaTeX", () => {
    const { container } = render(<Markdown content={"美元 $$a^2+b^2=c^2$$ 在此"} />);
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("does not treat single-$ currency text as math", () => {
    // singleDollarTextMath is disabled, so "$5 ... $10" stays plain text.
    const { container } = render(<Markdown content={"花费 $5 到 $10 之间"} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(screen.getByText(/花费 \$5 到 \$10 之间/)).toBeInTheDocument();
  });

  it("leaves backslash math inside code spans untouched", () => {
    const { container } = render(<Markdown content={"行内代码 `\\(x\\)` 原样"} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(screen.getByText("\\(x\\)")).toBeInTheDocument();
  });

  it("renders math and a citation chip together", () => {
    const { container } = render(
      <Markdown content={"由 \\(x=1\\) 得证[1]。"} sources={sources} />,
    );
    // Formula renders, and the citation marker still becomes a chip.
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(screen.getByRole("button", { name: "查看 1 个引用来源" })).toBeInTheDocument();
  });

  it("renders an asymmetric display block (own-line $$ opener, inline closer)", () => {
    // micromark would leave such a block's flow open and render the swallowed
    // tail as a red error; normalize reflows it to a proper flow block so it
    // parses AND renders centered (.katex-display), with the trailing prose kept.
    const content =
      "由 $$f$$ 可得\n\n$$\n\\begin{cases} 2^{x}, & x<0 \\end{cases}$$ 直观看 $$g$$ 在区间上";
    const { container } = render(<Markdown content={content} />);
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.innerHTML).not.toContain("$$");
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(screen.getByText(/直观看/)).toBeInTheDocument();
  });

  it("hides an in-progress formula while streaming instead of showing a red error", () => {
    // Mid-stream prefix cut inside a display block (closing $$ not yet streamed).
    const midStream = "由 $$f$$ 可得\n\n$$\n\\begin{cases} 2^{x}, & x<0,";
    const { container, rerender } = render(<Markdown content={midStream} streaming />);
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.innerHTML).not.toContain("$$");
    expect(screen.getByText(/由/)).toBeInTheDocument();

    // Once the closer arrives, the final (non-streaming) render shows the block.
    const complete = midStream + " 0, & x=0 \\end{cases}$$ 直观看";
    rerender(<Markdown content={complete} />);
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.querySelectorAll(".katex").length).toBeGreaterThan(1);
  });
});

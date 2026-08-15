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

    expect(screen.getByText("代码")).toBeInTheDocument();
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
    await waitFor(() =>
      expect(container.querySelector("[data-code-viewport] .token.plain")).toHaveTextContent(
        "unknown_call(42)",
      ),
    );
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

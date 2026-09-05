import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";
import { ConversationSearch } from "./ConversationSearch";
import type { SearchItem } from "./types";

const row: SearchItem = {
  conversation_id: "1",
  title: "中文历史",
  updated_at: new Date().toISOString(),
  title_match: null,
  snippet: null,
  target: null,
};
const props = {
  onClose: vi.fn(),
  onChoose: vi.fn(async () => {}),
  onStale: vi.fn(),
};

describe("history search", () => {
  it("debounces queries, cancels stale requests and never loads all chat details", async () => {
    let oldResolve: (value: {
      items: SearchItem[];
      next_cursor: null;
    }) => void = () => {};
    const search = vi.fn(async ({ q }: { q: string }) =>
      q === "旧"
        ? new Promise<{ items: SearchItem[]; next_cursor: null }>((r) => {
            oldResolve = r;
          })
        : { items: q ? [{ ...row, title: q }] : [], next_cursor: null },
    );
    render(<ConversationSearch {...props} open search={search} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "旧" } });
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith({ q: "旧" }, expect.any(AbortSignal)),
    );
    fireEvent.change(input, { target: { value: "新" } });
    await screen.findByText("新");
    await act(async () =>
      oldResolve({ items: [{ ...row, title: "旧" }], next_cursor: null }),
    );
    expect(screen.queryByText("旧")).not.toBeInTheDocument();
    expect(props.onChoose).not.toHaveBeenCalled();
  });

  it("does not request partially composed Chinese or overlong queries", async () => {
    const search = vi.fn(async () => ({ items: [], next_cursor: null }));
    render(<ConversationSearch {...props} open search={search} />);
    await waitFor(() => expect(search).toHaveBeenCalled());
    search.mockClear();
    const input = screen.getByRole("combobox");
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "zhong" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(search).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "中文" } });
    fireEvent.compositionEnd(input);
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        { q: "中文" },
        expect.any(AbortSignal),
      ),
    );
    search.mockClear();
    fireEvent.change(input, { target: { value: "😀".repeat(201) } });
    expect(
      await screen.findByText("搜索内容不能超过 200 个字符"),
    ).toBeVisible();
    await new Promise((r) => setTimeout(r, 300));
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps cached pages when reopening an unchanged search", async () => {
    const search = vi.fn(
      async ({ q, cursor }: { q: string; cursor?: string }) => ({
        items: [
          {
            ...row,
            conversation_id: cursor ? "2" : "1",
            title: cursor ? "第二页" : "第一页",
          },
        ],
        next_cursor: q && !cursor ? "next" : null,
      }),
    );
    const view = render(<ConversationSearch {...props} open search={search} />);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "中文" },
    });
    await screen.findByText("第一页");
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findByText("第二页");
    view.rerender(
      <ConversationSearch {...props} open={false} search={search} />,
    );
    view.rerender(<ConversationSearch {...props} open search={search} />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(4));
    expect(screen.getByText("第二页")).toBeVisible();
  });

  it("retains results on a network navigation error, removes a deleted result", async () => {
    const search = vi.fn(async () => ({ items: [row], next_cursor: null }));
    const choose = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network"))
      .mockRejectedValueOnce(new ApiError({ status: 404, message: "Gone" }));
    const stale = vi.fn();
    render(
      <ConversationSearch
        {...props}
        open
        search={search}
        onChoose={choose}
        onStale={stale}
      />,
    );
    fireEvent.click(await screen.findByRole("option"));
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("option")).toBeVisible();
    fireEvent.click(screen.getByRole("option"));
    await waitFor(() => expect(stale).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });
});

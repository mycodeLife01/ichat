import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConversationResponse } from "../api/types";
import { conversationResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { FavoritesDialog } from "./FavoritesDialog";

const row = (id: string, title: string): ConversationResponse => ({
  ...conversationResponse,
  id,
  title,
  favorited_at: "2026-10-24T00:00:00Z",
});

function renderDialog(
  list: () => Promise<ConversationResponse[]>,
  onToggleFavorite = vi.fn(async () => false as boolean | null),
) {
  const listMock = vi.fn(list);
  const props = { selectedId: null, onClose: vi.fn(), onChoose: vi.fn(), onToggleFavorite };
  const Wrapper = makeWrapper(createFakeServices({}, { list: listMock }));
  render(
    <Wrapper>
      <FavoritesDialog {...props} />
    </Wrapper>,
  );
  return { props, listMock };
}

describe("FavoritesDialog", () => {
  it("loads favorites, filters by title, and opens one", async () => {
    const user = userEvent.setup();
    const { props, listMock } = renderDialog(async () => [
      row("a", "旅行计划"),
      row("b", "周报草稿"),
    ]);

    const list = await screen.findByRole("list", { name: "收藏的对话" });
    expect(listMock).toHaveBeenCalledWith({ view: "favorites" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    await user.type(screen.getByRole("textbox", { name: "在收藏中查找" }), "周报");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /周报草稿/ }));
    expect(props.onChoose).toHaveBeenCalledWith("b");
  });

  it("keeps an un-starred row in place until close, and restores it on failure", async () => {
    const user = userEvent.setup();
    const onToggleFavorite = vi
      .fn<() => Promise<boolean | null>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(null);
    renderDialog(async () => [row("a", "旅行计划")], onToggleFavorite);

    await user.click(await screen.findByRole("button", { name: "取消收藏" }));
    const restar = screen.getByRole("button", { name: "重新收藏" });
    expect(restar).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("旅行计划")).toBeInTheDocument();

    await user.click(restar);
    expect(await screen.findByRole("button", { name: "重新收藏" })).toBeInTheDocument();
  });

  it("shows the empty state when nothing is favorited", async () => {
    renderDialog(async () => []);
    expect(await screen.findByText("还没有收藏的对话")).toBeInTheDocument();
  });

  it("shows only the no-match title when the filter finds nothing", async () => {
    const user = userEvent.setup();
    renderDialog(async () => [row("a", "旅行计划")]);

    await screen.findByRole("list", { name: "收藏的对话" });
    await user.type(screen.getByRole("textbox", { name: "在收藏中查找" }), "不存在");
    expect(screen.getByRole("status")).toHaveTextContent(/^没有匹配的收藏$/);
  });

  it("offers a retry when loading fails", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { listMock } = renderDialog(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return [row("a", "旅行计划")];
    });

    await user.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("旅行计划")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(2);
  });
});

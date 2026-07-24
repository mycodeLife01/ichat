import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ShareLinkResponse } from "../api/types";
import { useAppState } from "../app/context";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { ShareDialog } from "./ShareDialog";

function ToastProbe() {
  const { ui } = useAppState();
  return (
    <output data-testid="toast" data-tone={ui.toast?.tone ?? ""}>
      {ui.toast?.message ?? ""}
    </output>
  );
}

function renderDialog(shareOverrides: Parameters<typeof createFakeServices>[4]) {
  const services = createFakeServices({}, {}, {}, {}, shareOverrides);
  const onClose = vi.fn();
  render(
    <>
      <ShareDialog conversationId="conv-1" onClose={onClose} />
      <ToastProbe />
    </>,
    { wrapper: makeWrapper(services) },
  );
  return { onClose };
}

describe("ShareDialog", () => {
  it("renders as a labelled modal dialog and closes on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog({ list: async () => [] });

    expect(screen.getByRole("dialog", { name: "分享对话" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses an animated loading icon while the share link request is pending", () => {
    renderDialog({ list: () => new Promise(() => {}) });

    const loading = screen.getByRole("status", { name: "加载中" });
    expect(loading).toBeInTheDocument();
    expect(loading.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("加载中…")).toBeNull();
  });

  it("creates a link when none is active yet", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
    const created: ShareLinkResponse = {
      token: "new-token",
      expires_at: null,
      revoked_at: null,
      created_at: "2026-05-24T11:00:00Z",
    };
    const create = vi.fn(async () => created);

    // No active link -> the create form is shown.
    renderDialog({ list: async () => [], create });

    const button = await screen.findByRole("button", { name: /创建链接/ });
    await user.click(button);

    expect(create).toHaveBeenCalledWith("conv-1", 7);
    // The new link replaces the create form.
    expect(await screen.findByText(/new-token/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /创建链接/ })).toBeNull();
    expect(screen.getByTestId("toast")).toHaveTextContent("链接已复制");
    expect(screen.getByTestId("toast")).toHaveAttribute("data-tone", "success");
  });

  it("shows the single active link with copy + revoke, hiding the create form", async () => {
    const link: ShareLinkResponse = {
      token: "existing-token",
      expires_at: null,
      revoked_at: null,
      created_at: "2026-05-24T10:00:00Z",
    };

    renderDialog({ list: async () => [link] });

    expect(await screen.findByText(/existing-token/)).toBeInTheDocument();
    // With an active link present, creating is not offered.
    expect(screen.queryByRole("button", { name: /创建链接/ })).toBeNull();
    expect(screen.getByRole("button", { name: "撤销链接" })).toBeInTheDocument();
  });

  it("revokes the active link and reveals the create form again", async () => {
    const user = userEvent.setup();
    const link: ShareLinkResponse = {
      token: "to-revoke",
      expires_at: null,
      revoked_at: null,
      created_at: "2026-05-24T10:00:00Z",
    };
    const revoke = vi.fn(async () => ({ status: "ok" }));

    renderDialog({ list: async () => [link], revoke });

    await screen.findByText(/to-revoke/);
    await user.click(screen.getByRole("button", { name: "撤销链接" }));

    expect(revoke).toHaveBeenCalledWith("conv-1", "to-revoke");
    // The link is gone and the create form returns.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /创建链接/ })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/to-revoke/)).toBeNull();
    expect(screen.getByTestId("toast")).toHaveTextContent("已撤销分享");
    expect(screen.getByTestId("toast")).toHaveAttribute("data-tone", "success");
  });

  it("classifies share loading failures as errors", async () => {
    renderDialog({
      list: async () => {
        throw new Error("network");
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId("toast")).toHaveTextContent("加载分享链接失败"),
    );
    expect(screen.getByTestId("toast")).toHaveAttribute("data-tone", "error");
  });

  it("blocks repeat submits while creating, keeping an understandable label", async () => {
    const user = userEvent.setup();
    const create = vi.fn(() => new Promise<ShareLinkResponse>(() => {}));

    renderDialog({ list: async () => [], create });

    await user.click(await screen.findByRole("button", { name: /创建链接/ }));

    const pending = screen.getByRole("button", { name: "正在创建链接" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    await user.click(pending);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("blocks repeat submits while revoking", async () => {
    const user = userEvent.setup();
    const link: ShareLinkResponse = {
      token: "slow-revoke",
      expires_at: null,
      revoked_at: null,
      created_at: "2026-05-24T10:00:00Z",
    };
    const revoke = vi.fn(() => new Promise<{ status: "ok" }>(() => {}));

    renderDialog({ list: async () => [link], revoke });

    await screen.findByText(/slow-revoke/);
    const button = screen.getByRole("button", { name: "撤销链接" });
    await user.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await user.click(button);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("classifies create failures as errors", async () => {
    const user = userEvent.setup();
    renderDialog({
      list: async () => [],
      create: async () => {
        throw new Error("boom");
      },
    });

    await user.click(await screen.findByRole("button", { name: /创建链接/ }));

    await waitFor(() =>
      expect(screen.getByTestId("toast")).toHaveTextContent("创建分享失败"),
    );
    expect(screen.getByTestId("toast")).toHaveAttribute("data-tone", "error");
  });

  it("classifies revoke failures as errors and keeps the link", async () => {
    const user = userEvent.setup();
    const link: ShareLinkResponse = {
      token: "keep-me",
      expires_at: null,
      revoked_at: null,
      created_at: "2026-05-24T10:00:00Z",
    };

    renderDialog({
      list: async () => [link],
      revoke: async () => {
        throw new Error("boom");
      },
    });

    await screen.findByText(/keep-me/);
    await user.click(screen.getByRole("button", { name: "撤销链接" }));

    await waitFor(() =>
      expect(screen.getByTestId("toast")).toHaveTextContent("撤销失败"),
    );
    expect(screen.getByTestId("toast")).toHaveAttribute("data-tone", "error");
    expect(screen.getByText(/keep-me/)).toBeInTheDocument();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ShareLinkResponse } from "../api/types";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { ShareDialog } from "./ShareDialog";

function renderDialog(shareOverrides: Parameters<typeof createFakeServices>[4]) {
  const services = createFakeServices({}, {}, {}, {}, shareOverrides);
  const onClose = vi.fn();
  render(<ShareDialog conversationId="conv-1" onClose={onClose} />, {
    wrapper: makeWrapper(services),
  });
  return { onClose };
}

describe("ShareDialog", () => {
  it("creates a link when none is active yet", async () => {
    const user = userEvent.setup();
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
  });
});

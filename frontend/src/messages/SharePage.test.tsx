import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { App } from "../app/App";

function servicesWithShare(overrides: Parameters<typeof createFakeServices>[4]) {
  return createFakeServices({}, {}, {}, {}, overrides);
}

describe("SharePage", () => {
  it("renders a read-only snapshot without completed reasoning", async () => {
    const services = servicesWithShare({
      getPublic: async () => ({
        title: "Shared chat",
        messages: [
          { role: "user", content: "ask something", sources: [] },
          {
            role: "assistant",
            content: "the answer",
            reasoning: "let me think",
            sources: [{ id: 1, title: "Src", url: "https://example.com" }],
          },
        ],
        created_at: "2026-05-24T10:05:00Z",
      }),
    });

    const { container } = renderWithApp(<App />, services, undefined, ["/share/tok123"]);

    expect(await screen.findByText("ask something")).toBeInTheDocument();
    expect(screen.getByText("the answer")).toBeInTheDocument();
    expect(screen.queryByText("let me think")).toBeNull();
    expect(container.querySelector(".assistant-content > .assistant-markdown")).not.toBeNull();
    expect(container.querySelector(".thread-inner")).toHaveClass(
      "max-w-[calc(var(--assistant-content-width)+64px)]",
    );
    // The snapshot is read-only — no composer / edit affordances.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders shared tables and external links through the shared Markdown surface", async () => {
    const content = [
      "| Surface | State |",
      "| --- | --- |",
      "| Table | shared |",
      "",
      "[External](https://example.com/shared)",
    ].join("\n");
    const services = servicesWithShare({
      getPublic: async () => ({
        title: "Shared rich content",
        messages: [{ role: "assistant", content, sources: [] }],
        created_at: "2026-08-15T10:05:00Z",
      }),
    });

    const { container } = renderWithApp(<App />, services, undefined, ["/share/tok123"]);

    expect(await screen.findByRole("region", { name: "表格（可横向滚动）" })).toBeVisible();
    expect(container.querySelector(".assistant-markdown [data-table-block]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "External" })).toHaveAttribute(
      "target",
      "_new",
    );
  });

  it("shows an icon-based loading status while the snapshot is pending", () => {
    const services = servicesWithShare({
      getPublic: () => new Promise(() => {}),
    });

    renderWithApp(<App />, services, undefined, ["/share/tok123"]);

    const loading = screen.getByRole("status", { name: "加载中" });
    expect(loading.querySelector("svg")).not.toBeNull();
  });

  it("shows a not-found state when the token is unknown/revoked/expired", async () => {
    const services = servicesWithShare({
      getPublic: async () => {
        throw new ApiError({ status: 404, detail: "Share not found" });
      },
    });

    renderWithApp(<App />, services, undefined, ["/share/missing"]);

    // Inaccessible shares surface as a persistent inline state with an icon,
    // not a transient notification.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("分享不存在或已失效");
    expect(alert.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("link", { name: "前往 Piko" })).toBeInTheDocument();
  });

  it("keeps legacy snapshots without a ref unreadable", async () => {
    const services = servicesWithShare({
      getPublic: async () => ({
        title: "Shared files",
        messages: [
          {
            role: "user",
            content: "See attached",
            sources: [],
            attachments: [
              {
                name: "private-report.pdf",
                media_type: "application/pdf",
                size_bytes: 1024,
                category: "pdf",
                model_input_kind: "document",
                warning: ["Some pages were not read."],
                preview_available: false,
              },
            ],
          },
        ],
        created_at: "2026-08-01T10:00:00Z",
      }),
    });

    renderWithApp(<App />, services, undefined, ["/share/tok123"]);

    expect(await screen.findByText("private-report.pdf")).toBeInTheDocument();
    // Snapshots minted before public reads existed carry no ref, so the card
    // renders with the shared visual but its read control stays inert.
    expect(screen.getByRole("button", { name: "Download original file" })).toBeDisabled();
  });

  it("renders shared attachments with the live thread's layout and read controls", async () => {
    const readAttachment = vi.fn(async () => ({
      url: "https://cdn.example.com/shared-preview.png",
      expires_at: "2026-08-14T10:05:00Z",
    }));
    const services = servicesWithShare({
      readAttachment,
      getPublic: async () => ({
        title: "Shared files",
        messages: [
          {
            role: "user",
            content: "See attached",
            sources: [],
            attachments: [
              {
                name: "diagram.png",
                media_type: "image/png",
                size_bytes: 2048,
                category: "image",
                model_input_kind: "image",
                preview_available: true,
                ref: "0-0",
                position: 0,
                stats: { width: 800, height: 400 },
              },
              {
                name: "report.pdf",
                media_type: "application/pdf",
                size_bytes: 1024,
                category: "pdf",
                model_input_kind: "document",
                preview_available: false,
                ref: "0-1",
                position: 1,
              },
            ],
          },
        ],
        created_at: "2026-08-01T10:00:00Z",
      }),
    });

    renderWithApp(<App />, services, undefined, ["/share/tok123"]);

    // The image resolves a signed preview through the share token, and the two
    // kinds land in the same image/file groups the live thread renders.
    const image = await screen.findByAltText("diagram.png");
    expect(image).toHaveAttribute("src", "https://cdn.example.com/shared-preview.png");
    expect(readAttachment).toHaveBeenCalledWith("tok123", "0-0", "preview");
    expect(document.querySelector('[data-attachment-group="images"]')).not.toBeNull();
    expect(document.querySelector('[data-attachment-group="files"]')).not.toBeNull();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download original file" })).toBeEnabled();
  });
});

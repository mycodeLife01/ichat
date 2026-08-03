import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

    renderWithApp(<App />, services, undefined, ["/share/tok123"]);

    expect(await screen.findByText("ask something")).toBeInTheDocument();
    expect(screen.getByText("the answer")).toBeInTheDocument();
    expect(screen.queryByText("let me think")).toBeNull();
    // The snapshot is read-only — no composer / edit affordances.
    expect(screen.queryByRole("textbox")).toBeNull();
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
    expect(screen.getByRole("link", { name: "前往 iChat" })).toBeInTheDocument();
  });

  it("renders attachment placeholders without preview or download controls", async () => {
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
    expect(screen.queryByText(/application\/pdf/)).toBeNull();
    expect(screen.queryByText(/1\.0 KiB/)).toBeNull();
    expect(screen.getByText("Some pages were not read.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download original file" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview image" })).toBeNull();
  });
});

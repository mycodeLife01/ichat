import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApiError } from "../api/errors";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { App } from "../app/App";

function servicesWithShare(overrides: Parameters<typeof createFakeServices>[4]) {
  return createFakeServices({}, {}, {}, {}, overrides);
}

describe("SharePage", () => {
  it("renders a read-only snapshot with reasoning and sources", async () => {
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
    // The snapshot is read-only — no composer / edit affordances.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows a not-found state when the token is unknown/revoked/expired", async () => {
    const services = servicesWithShare({
      getPublic: async () => {
        throw new ApiError({ status: 404, detail: "Share not found" });
      },
    });

    renderWithApp(<App />, services, undefined, ["/share/missing"]);

    expect(await screen.findByText("分享不存在或已失效")).toBeInTheDocument();
  });
});

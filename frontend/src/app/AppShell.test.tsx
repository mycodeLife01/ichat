import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { conversationDetailResponse, conversationResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("loads and lists conversations on mount", async () => {
    const services = createFakeServices(
      {},
      { list: async () => [conversationResponse] },
    );
    renderWithApp(<AppShell />, services);

    expect(await screen.findByText(conversationResponse.title as string)).toBeInTheDocument();
  });

  it("loads detail when a conversation is selected", async () => {
    const services = createFakeServices(
      {},
      {
        list: async () => [conversationResponse],
        detail: async () => conversationDetailResponse,
      },
    );
    const user = userEvent.setup();
    renderWithApp(<AppShell />, services);

    await user.click(await screen.findByText(conversationResponse.title as string));

    // user message content from the detail fixture
    expect(await screen.findByText("Hello")).toBeInTheDocument();
  });

  it("shows the welcome heading in the empty state", async () => {
    const services = createFakeServices({}, { list: async () => [] });
    renderWithApp(<AppShell />, services);

    expect(await screen.findByText("我们先从哪里开始呢？")).toBeInTheDocument();
  });
});

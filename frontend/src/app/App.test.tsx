import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { createAuthSession, tokenStore } from "../auth/tokenStore";
import { App } from "./App";

describe("App auth gate", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("shows the auth screen when unauthenticated", async () => {
    renderWithApp(<App />, createFakeServices());

    expect(await screen.findByRole("tab", { name: "登录" })).toBeInTheDocument();
  });

  it("shows the authenticated placeholder when a session is restored", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));

    renderWithApp(<App />, createFakeServices());

    expect(await screen.findByText("已登录：alice")).toBeInTheDocument();
  });

  it("returns to the auth screen after logout", async () => {
    const user = userEvent.setup();
    tokenStore.save(createAuthSession(authTokenResponse));

    renderWithApp(<App />, createFakeServices());

    await user.click(await screen.findByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("tab", { name: "登录" })).toBeInTheDocument();
    expect(tokenStore.read()).toBeNull();
  });
});

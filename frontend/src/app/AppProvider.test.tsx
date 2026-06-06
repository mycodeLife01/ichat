import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { createAuthSession, tokenStore } from "../auth/tokenStore";
import { useAppState } from "./context";

function AuthProbe() {
  const { auth } = useAppState();
  return (
    <div>
      <span>bootstrapped:{String(auth.bootstrapped)}</span>
      <span>user:{auth.session?.user.username ?? "none"}</span>
    </div>
  );
}

describe("AppProvider", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("restores no session when storage is empty", async () => {
    renderWithApp(<AuthProbe />, createFakeServices());

    expect(await screen.findByText("bootstrapped:true")).toBeInTheDocument();
    expect(screen.getByText("user:none")).toBeInTheDocument();
  });

  it("restores a persisted session on mount", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));

    renderWithApp(<AuthProbe />, createFakeServices());

    expect(await screen.findByText("user:alice")).toBeInTheDocument();
    expect(screen.getByText("bootstrapped:true")).toBeInTheDocument();
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { createAuthSession, tokenStore } from "./tokenStore";
import { authTokenResponse } from "../test/apiFixtures";

describe("tokenStore", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("saves and reads an auth session", () => {
    const session = createAuthSession(authTokenResponse, 1_000);

    tokenStore.save(session);

    expect(tokenStore.read()).toEqual(session);
    expect(tokenStore.getAccessToken()).toBe("access-token");
    expect(tokenStore.getRefreshToken()).toBe("refresh-token");
  });

  it("clears the stored session", () => {
    tokenStore.save(createAuthSession(authTokenResponse, 1_000));

    tokenStore.clear();

    expect(tokenStore.read()).toBeNull();
  });

  it("clears invalid JSON and returns null", () => {
    localStorage.setItem("ichat.auth", "{bad json");

    expect(tokenStore.read()).toBeNull();
    expect(localStorage.getItem("ichat.auth")).toBeNull();
  });
});

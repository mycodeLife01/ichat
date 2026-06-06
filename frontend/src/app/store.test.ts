import { describe, expect, it } from "vitest";

import { authTokenResponse } from "../test/apiFixtures";
import { createAuthSession } from "../auth/tokenStore";
import { initialState, rootReducer } from "./store";

describe("rootReducer auth slice", () => {
  it("marks bootstrapped on auth/restored with a session", () => {
    const session = createAuthSession(authTokenResponse);
    const next = rootReducer(initialState, { type: "auth/restored", session });

    expect(next.auth.session).toEqual(session);
    expect(next.auth.bootstrapped).toBe(true);
  });

  it("marks bootstrapped on auth/restored with no session", () => {
    const next = rootReducer(initialState, { type: "auth/restored", session: null });

    expect(next.auth.session).toBeNull();
    expect(next.auth.bootstrapped).toBe(true);
  });

  it("toggles submitting status", () => {
    const submitting = rootReducer(initialState, { type: "auth/submitStarted" });
    expect(submitting.auth.status).toBe("submitting");

    const failed = rootReducer(submitting, { type: "auth/submitFailed" });
    expect(failed.auth.status).toBe("idle");
  });

  it("stores the session and clears submitting on auth/loggedIn", () => {
    const session = createAuthSession(authTokenResponse);
    const submitting = rootReducer(initialState, { type: "auth/submitStarted" });
    const next = rootReducer(submitting, { type: "auth/loggedIn", session });

    expect(next.auth.session).toEqual(session);
    expect(next.auth.status).toBe("idle");
  });
});

describe("rootReducer app/reset", () => {
  it("clears every slice but keeps bootstrapped true", () => {
    const session = createAuthSession(authTokenResponse);
    const dirty = rootReducer(initialState, { type: "auth/loggedIn", session });

    const reset = rootReducer(dirty, { type: "app/reset" });

    expect(reset.auth.session).toBeNull();
    expect(reset.auth.status).toBe("idle");
    expect(reset.auth.bootstrapped).toBe(true);
    expect(reset.conversationIndex).toEqual(initialState.conversationIndex);
    expect(reset.conversationDetail).toEqual(initialState.conversationDetail);
    expect(reset.activeRun).toBeNull();
    expect(reset.composer).toEqual(initialState.composer);
    expect(reset.ui).toEqual(initialState.ui);
  });
});

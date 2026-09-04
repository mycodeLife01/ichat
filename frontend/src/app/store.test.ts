import { describe, expect, it } from "vitest";

import { authTokenResponse } from "../test/apiFixtures";
import { createAuthSession } from "../auth/tokenStore";
import { initialState, rootReducer } from "./store";

describe("rootReducer auth slice", () => {
  it("restores a session before marking bootstrap complete", () => {
    const session = createAuthSession(authTokenResponse);
    const restoring = rootReducer(initialState, { type: "auth/restored", session });
    const next = rootReducer(restoring, { type: "auth/bootstrapCompleted" });

    expect(next.auth.session).toEqual(session);
    expect(next.auth.bootstrapped).toBe(true);
  });

  it("completes bootstrap with no restored session", () => {
    const restoring = rootReducer(initialState, { type: "auth/restored", session: null });
    const next = rootReducer(restoring, { type: "auth/bootstrapCompleted" });

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

describe("rootReducer composer reply quote", () => {
  it("sets, replaces, clears, and restores a reply quote", () => {
    const first = { source_message_id: "assistant-1", excerpt: "first" };
    const second = { source_message_id: "assistant-2", excerpt: "second" };

    const added = rootReducer(initialState, { type: "composer/replyQuoteSet", replyQuote: first });
    const replaced = rootReducer(added, { type: "composer/replyQuoteSet", replyQuote: second });
    const cleared = rootReducer(replaced, { type: "composer/replyQuoteCleared" });
    const restored = rootReducer(cleared, {
      type: "composer/replyQuoteRestored",
      replyQuote: first,
    });

    expect(added.composer.replyQuote).toEqual(first);
    expect(replaced.composer.replyQuote).toEqual(second);
    expect(cleared.composer.replyQuote).toBeNull();
    expect(restored.composer.replyQuote).toEqual(first);
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

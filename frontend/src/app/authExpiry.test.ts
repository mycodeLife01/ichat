import { describe, expect, it, vi } from "vitest";

import { createAuthExpiryHandler } from "./authExpiry";

describe("createAuthExpiryHandler", () => {
  it("aborts the active stream then dispatches app/reset", () => {
    const calls: string[] = [];
    const abort = vi.fn(() => calls.push("abort"));
    const dispatch = vi.fn(() => calls.push("dispatch"));

    const handler = createAuthExpiryHandler({ dispatch, abort });
    handler();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "app/reset" });
    expect(calls).toEqual(["abort", "dispatch"]);
  });
});

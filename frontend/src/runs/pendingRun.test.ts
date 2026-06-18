import { describe, expect, it } from "vitest";

import type { MessageResponse } from "../api/types";
import { findPendingRunId } from "./pendingRun";

function message(overrides: Partial<MessageResponse>): MessageResponse {
  return {
    id: "1",
    conversation_id: "10",
    run_id: null,
    role: "user",
    content: "hi",
    reasoning: null,
    position: 1,
    created_at: "t",
    ...overrides,
  };
}

describe("findPendingRunId", () => {
  it("returns null for an empty thread", () => {
    expect(findPendingRunId([])).toBeNull();
  });

  it("returns the run id when the last user message has no assistant reply", () => {
    const messages = [message({ id: "1", run_id: "100", role: "user" })];
    expect(findPendingRunId(messages)).toBe("100");
  });

  it("returns null when the run already materialized an assistant reply", () => {
    const messages = [
      message({ id: "1", run_id: "100", role: "user", position: 1 }),
      message({ id: "2", run_id: "100", role: "assistant", position: 2 }),
    ];
    expect(findPendingRunId(messages)).toBeNull();
  });

  it("finds the pending run of the last turn in a longer thread", () => {
    const messages = [
      message({ id: "1", run_id: "100", role: "user", position: 1 }),
      message({ id: "2", run_id: "100", role: "assistant", position: 2 }),
      message({ id: "3", run_id: "101", role: "user", position: 3 }),
    ];
    expect(findPendingRunId(messages)).toBe("101");
  });

  it("ignores user messages without a run id", () => {
    const messages = [
      message({ id: "1", run_id: "100", role: "user", position: 1 }),
      message({ id: "2", run_id: "100", role: "assistant", position: 2 }),
      message({ id: "3", run_id: null, role: "user", position: 3 }),
    ];
    expect(findPendingRunId(messages)).toBeNull();
  });
});

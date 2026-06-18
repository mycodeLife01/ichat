import type { MessageResponse } from "../api/types";

// A run is "pending" when the last user message carries a run_id but the thread
// has no materialized assistant reply for that run — the run is either still
// generating, or finished without materializing (failed/cancelled). Used on
// conversation entry to decide whether to recover from the server's run state.
export function findPendingRunId(messages: MessageResponse[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate.role !== "user" || candidate.run_id == null) continue;
    const materialized = messages.some(
      (m) => m.role === "assistant" && m.run_id === candidate.run_id,
    );
    return materialized ? null : candidate.run_id;
  }
  return null;
}

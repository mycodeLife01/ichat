// frontend/sse.js
import { ApiError } from "./api.js";

const TERMINAL_TYPES = new Set(["run_succeeded", "run_failed", "run_cancelled"]);

/**
 * Stream SSE events for a run. Returns when the stream closes (terminal event
 * or server EOF). Throws on HTTP / network failure (other than abort).
 *
 * @param {{ runId: number, afterSeq?: number, token: string, signal?: AbortSignal,
 *           onEvent: (event: { seq: number, type: string, payload: any }) => void }} opts
 */
export async function streamRunEvents({ runId, afterSeq = 0, token, signal, onEvent }) {
  const response = await fetch(`/api/v1/runs/${runId}/events?after_seq=${afterSeq}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "text/event-stream",
    },
    signal,
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {}
    throw new ApiError(response.status, detail);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE records are separated by a blank line (\n\n). The server uses \n
      // (per format_sse_event in app/api/v1/runs.py).
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const record = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseRecord(record);
        if (parsed) {
          onEvent(parsed);
          if (TERMINAL_TYPES.has(parsed.type)) return;
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

function parseRecord(record) {
  let type = null;
  let seq = null;
  const dataLines = [];
  for (const line of record.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("id:")) seq = Number(line.slice(3).trim());
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!type || dataLines.length === 0) return null;
  let payload = {};
  try {
    const parsed = JSON.parse(dataLines.join("\n"));
    // backend ships the full RunEventResponse json — pull payload field if present.
    payload = parsed.payload ?? parsed;
    if (typeof parsed.seq === "number") seq = parsed.seq;
  } catch {}
  return { seq: seq ?? 0, type, payload };
}

export { TERMINAL_TYPES };

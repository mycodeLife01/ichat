import { getDefaultApiClient, type ApiClient, type ApiRequestOptions } from "./client";
import { decodeSseStream } from "./sse";
import type {
  CommandStatusResponse,
  RunEventResponse,
  RunEventType,
  RunStateResponse,
  RunStreamEvent,
} from "./types";

const TERMINAL_EVENT_TYPES = new Set<RunEventType>([
  "run_succeeded",
  "run_failed",
  "run_cancelled",
]);

export function createRunApi(
  client?: Pick<ApiClient, "request" | "fetchRaw">,
) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    state(runId: string): Promise<RunStateResponse> {
      return resolveClient().request<RunStateResponse>(`/runs/${runId}/state`);
    },
    cancel(runId: string): Promise<CommandStatusResponse> {
      return resolveClient().request<CommandStatusResponse>(`/runs/${runId}/cancel`, {
        method: "POST",
      });
    },
    async *streamEvents(
      runId: string,
      afterSeq: number,
      options: Pick<ApiRequestOptions, "signal"> = {},
    ): AsyncGenerator<RunStreamEvent> {
      const response = await resolveClient().fetchRaw(`/runs/${runId}/events`, {
        query: { after_seq: afterSeq },
        headers: { Accept: "text/event-stream" },
        signal: options.signal,
      });

      if (!response.body) {
        throw new Error("SSE response body is empty");
      }

      for await (const event of decodeSseStream(response.body)) {
        const data = JSON.parse(event.data) as RunEventResponse;
        const streamEvent = {
          seq: data.seq,
          type: data.type,
          data,
        };

        yield streamEvent;

        if (TERMINAL_EVENT_TYPES.has(streamEvent.type)) {
          return;
        }
      }
    },
  };
}

export type RunApi = ReturnType<typeof createRunApi>;

export const runApi = createRunApi();

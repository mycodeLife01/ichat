import { describe, expect, it, vi } from "vitest";

import { createRunApi } from "./runs";
import type { ApiClient } from "./client";
import {
  runStateResponse,
  succeededEvent,
  textDeltaEvent,
} from "../test/apiFixtures";
import { readableTextStream } from "../test/stream";

async function collectAsync<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of source) {
    items.push(item);
  }

  return items;
}

function mockClient() {
  return {
    request: vi.fn(),
    fetchRaw: vi.fn(),
  } as unknown as Pick<ApiClient, "request" | "fetchRaw">;
}

describe("runApi", () => {
  it("loads run state and cancels runs", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValueOnce(runStateResponse);
    vi.mocked(client.request).mockResolvedValueOnce({ status: "ok" });
    const api = createRunApi(client);

    await api.state(100);
    await api.cancel(100);

    expect(client.request).toHaveBeenNthCalledWith(1, "/runs/100/state");
    expect(client.request).toHaveBeenNthCalledWith(2, "/runs/100/cancel", {
      method: "POST",
    });
  });

  it("streams run events with after_seq query and text/event-stream accept", async () => {
    const client = mockClient();
    vi.mocked(client.fetchRaw).mockResolvedValue(
      new Response(
        readableTextStream([
          `id: 1\nevent: text_delta\ndata: ${JSON.stringify(textDeltaEvent)}\n\n`,
          `id: 2\nevent: run_succeeded\ndata: ${JSON.stringify(succeededEvent)}\n\n`,
        ]),
        { status: 200 },
      ),
    );
    const api = createRunApi(client);

    await expect(collectAsync(api.streamEvents(100, 7))).resolves.toEqual([
      { seq: 1, type: "text_delta", data: textDeltaEvent },
      { seq: 2, type: "run_succeeded", data: succeededEvent },
    ]);

    expect(client.fetchRaw).toHaveBeenCalledWith("/runs/100/events", {
      query: { after_seq: 7 },
      headers: { Accept: "text/event-stream" },
    });
  });
});

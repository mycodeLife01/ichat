import { describe, expect, it } from "vitest";

import { SseParser, decodeSseStream } from "./sse";
import { readableTextStream } from "../test/stream";

async function collectAsync<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of source) {
    items.push(item);
  }

  return items;
}

describe("SseParser", () => {
  it("parses a complete event", () => {
    const parser = new SseParser();

    expect(
      parser.push('id: 1\nevent: text_delta\ndata: {"seq":1}\n\n'),
    ).toEqual([{ id: "1", event: "text_delta", data: '{"seq":1}' }]);
  });

  it("parses multiple events from one chunk", () => {
    const parser = new SseParser();

    expect(parser.push("id: 1\ndata: a\n\nid: 2\ndata: b\n\n")).toEqual([
      { id: "1", data: "a" },
      { id: "2", data: "b" },
    ]);
  });

  it("keeps buffer across chunk boundaries", () => {
    const parser = new SseParser();

    expect(parser.push("id: 1\nevent: text")).toEqual([]);
    expect(parser.push('_delta\ndata: {"seq":1}\n\n')).toEqual([
      { id: "1", event: "text_delta", data: '{"seq":1}' },
    ]);
  });

  it("joins multiple data lines and ignores comments", () => {
    const parser = new SseParser();

    expect(parser.push(": keepalive\ndata: line1\ndata: line2\n\n")).toEqual([
      { data: "line1\nline2" },
    ]);
  });
});

describe("decodeSseStream", () => {
  it("decodes text stream chunks into parsed events", async () => {
    const stream = readableTextStream(["id: 1\n", "data: hello\n\n"]);

    await expect(collectAsync(decodeSseStream(stream))).resolves.toEqual([
      { id: "1", data: "hello" },
    ]);
  });
});

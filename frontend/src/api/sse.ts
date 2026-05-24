export type ParsedSseEvent = {
  id?: string;
  event?: string;
  data: string;
};

export class SseParser {
  private buffer = "";

  push(chunk: string): ParsedSseEvent[] {
    this.buffer += chunk;
    const events: ParsedSseEvent[] = [];

    while (true) {
      const boundary = this.findBoundary();
      if (boundary === -1) break;

      const rawEvent = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);

      const event = parseEvent(rawEvent);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  private findBoundary(): { index: number; length: number } | -1 {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");

    if (lf === -1 && crlf === -1) return -1;
    if (lf === -1) return { index: crlf, length: 4 };
    if (crlf === -1) return { index: lf, length: 2 };
    return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
  }
}

export async function* decodeSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedSseEvent> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      for (const event of parser.push(text)) {
        yield event;
      }
    }

    const remaining = decoder.decode();
    if (remaining) {
      for (const event of parser.push(remaining)) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(rawEvent: string): ParsedSseEvent | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  let id: string | undefined;
  let event: string | undefined;

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "id") id = value;
    if (field === "event") event = value;
    if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;

  return {
    ...(id === undefined ? {} : { id }),
    ...(event === undefined ? {} : { event }),
    data: dataLines.join("\n"),
  };
}

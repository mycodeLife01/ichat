import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFilesApi,
  putFileToUpload,
  type PutFileOptions,
  type StoragePut,
  type StoragePutRequest,
  xhrStoragePut,
} from "./files";
import type { ApiClient } from "./client";

function mockClient() {
  return { request: vi.fn() } as unknown as Pick<ApiClient, "request">;
}

describe("filesApi", () => {
  it("uses the attachment upload, status, cancel, and signed-read contracts", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue({});
    const api = createFilesApi(client);

    await api.createUpload({
      filename: "notes.txt",
      content_type: "text/plain",
      size_bytes: 5,
    });
    await api.confirm("upload-1", '"etag-1"');
    await api.status(["upload-1", "upload-2"]);
    await api.cancel("upload-2");
    await api.cancelMany(["upload-1", "upload-2"]);
    await api.readUrl("file-1", "download");

    expect(client.request).toHaveBeenNthCalledWith(1, "/files/uploads", {
      method: "POST",
      body: {
        filename: "notes.txt",
        content_type: "text/plain",
        size_bytes: 5,
        multipart_supported: true,
      },
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "/files/uploads/upload-1/confirm", {
      method: "POST",
      body: { etag: '"etag-1"' },
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "/files/uploads/status", {
      method: "POST",
      body: { upload_ids: ["upload-1", "upload-2"] },
    });
    expect(client.request).toHaveBeenNthCalledWith(4, "/files/uploads/upload-2", {
      method: "DELETE",
    });
    expect(client.request).toHaveBeenNthCalledWith(5, "/files/uploads/cancel", {
      method: "POST",
      body: { upload_ids: ["upload-1", "upload-2"] },
    });
    expect(client.request).toHaveBeenNthCalledWith(6, "/files/file-1/read-url", {
      method: "POST",
      body: { role: "download" },
    });
  });
});

describe("putFileToUpload", () => {
  const session = {
    upload_id: "upload-1",
    upload_url: "https://uploads.example.test/upload-1",
    upload_headers: { "x-upload-header": "value" },
    upload_url_expires_at: "2026-08-01T10:05:00Z",
    session_expires_at: "2026-08-01T10:30:00Z",
  };
  const partSize = 5 * 1024 * 1024;
  const multipartSession = (partCount: number) => ({
    ...session,
    upload_method: "multipart" as const,
    upload_url: null,
    part_size_bytes: partSize,
    upload_parts: Array.from({ length: partCount }, (_, index) => ({
      part_number: index + 1,
      upload_url: `https://uploads.example.test/part-${index + 1}`,
      upload_headers: {},
    })),
  });
  const partNumber = (request: StoragePutRequest) => Number(request.url.split("part-")[1]);

  it("uploads directly to storage, reports progress, and returns the exposed ETag", async () => {
    const put = vi.fn<StoragePut>(async (request) => {
      request.onProgress?.(2);
      request.onProgress?.(5);
      return { ok: true, etag: '"r2-etag"' };
    });
    const onProgress = vi.fn();
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    await expect(putFileToUpload(session, file, { put, onProgress })).resolves.toEqual({
      etag: '"r2-etag"',
    });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        url: session.upload_url,
        headers: session.upload_headers,
        body: file,
        signal: undefined,
      }),
    );
    expect(onProgress.mock.calls).toEqual([
      [2, 5],
      [5, 5],
      [5, 5],
    ]);
  });

  it("uploads multipart plans with at most three concurrent requests and ordered ETags", async () => {
    let active = 0;
    let maxActive = 0;
    const put = vi.fn<StoragePut>(async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { ok: true, etag: `"etag-${partNumber(request)}"` };
    });
    const file = new File([new Uint8Array(partSize * 3 + 1)], "large.bin");

    await expect(putFileToUpload(multipartSession(4), file, { put })).resolves.toEqual({
      parts: [1, 2, 3, 4].map((part_number) => ({
        part_number,
        etag: `"etag-${part_number}"`,
      })),
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("aggregates multipart progress and discounts a retried part", async () => {
    const attempts = new Map<number, number>();
    const put = vi.fn<StoragePut>(async (request) => {
      const number = partNumber(request);
      const attempt = (attempts.get(number) ?? 0) + 1;
      attempts.set(number, attempt);
      request.onProgress?.(1_000);
      if (number === 2 && attempt === 1) throw new TypeError("network");
      request.onProgress?.(request.body.size);
      return { ok: true, etag: `"etag-${number}"` };
    });
    const totals: number[] = [];
    const file = new File([new Uint8Array(partSize + 2_000)], "large.bin");

    await putFileToUpload(multipartSession(2), file, {
      put,
      wait: async () => undefined,
      onProgress: (loaded, total) => {
        expect(total).toBe(file.size);
        totals.push(loaded);
      },
    });

    // The failed part's 1000 bytes are withdrawn before it is retried.
    expect(Math.max(...totals)).toBe(file.size);
    expect(totals.at(-1)).toBe(file.size);
    expect(totals.every((loaded) => loaded <= file.size)).toBe(true);
    const drop = totals.findIndex((loaded, index) => index > 0 && loaded < totals[index - 1]);
    expect(drop).toBeGreaterThan(0);
    expect(totals[drop - 1] - totals[drop]).toBe(1_000);
  });

  it("backs off between multipart retries with bounded jitter", async () => {
    const put = vi.fn<StoragePut>(async () => ({ ok: false, etag: null }));
    const wait = vi.fn<NonNullable<PutFileOptions["wait"]>>(async () => undefined);
    const file = new File([new Uint8Array(partSize)], "large.bin");

    await expect(
      putFileToUpload(multipartSession(1), file, { put, wait, random: () => 1 }),
    ).rejects.toThrow("A multipart upload part failed after retries");
    expect(put).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([750, 1500]);

    wait.mockClear();
    await expect(
      putFileToUpload(multipartSession(1), file, { put, wait, random: () => 0 }),
    ).rejects.toThrow();
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([500, 1000]);
  });

  it("stops a multipart retry when the upload is aborted during backoff", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const put = vi.fn<StoragePut>(async () => ({ ok: false, etag: null }));
      const file = new File([new Uint8Array(partSize)], "large.bin");

      const upload = putFileToUpload(multipartSession(1), file, {
        put,
        signal: controller.signal,
        random: () => 0,
      });
      const assertion = expect(upload).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await assertion;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a response without an exposed ETag", async () => {
    const put = vi.fn<StoragePut>(async () => ({ ok: true, etag: null }));
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    await expect(putFileToUpload(session, file, { put })).rejects.toThrow(
      "Storage did not return an upload confirmation",
    );
  });
});

describe("xhrStoragePut", () => {
  class FakeXhr {
    static last: FakeXhr;
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    status = 0;
    method = "";
    url = "";
    headers: Record<string, string> = {};
    body: unknown = null;
    aborted = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() {
      FakeXhr.last = this;
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    getResponseHeader(name: string) {
      return name === "ETag" ? '"xhr-etag"' : null;
    }
    send(body: unknown) {
      this.body = body;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }

  afterEach(() => vi.unstubAllGlobals());

  it("reports upload progress and resolves with the response ETag", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const onProgress = vi.fn();
    const body = new Blob(["hello"]);

    const pending = xhrStoragePut({
      url: "https://uploads.example.test/u",
      headers: { "x-upload-header": "value" },
      body,
      onProgress,
    });
    const xhr = FakeXhr.last;
    xhr.upload.onprogress?.({ loaded: 3 });
    xhr.status = 200;
    xhr.onload?.();

    await expect(pending).resolves.toEqual({ ok: true, etag: '"xhr-etag"' });
    expect(xhr).toMatchObject({
      method: "PUT",
      url: "https://uploads.example.test/u",
      headers: { "x-upload-header": "value" },
      body,
    });
    expect(onProgress).toHaveBeenCalledWith(3);
  });

  it("maps an abort signal to xhr.abort and an AbortError", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const controller = new AbortController();

    const pending = xhrStoragePut({
      url: "https://uploads.example.test/u",
      body: new Blob(["hello"]),
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.last.aborted).toBe(true);
  });
});

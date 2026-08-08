import { describe, expect, it, vi } from "vitest";

import { createFilesApi, putFileToUpload } from "./files";
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

  it("uploads directly to storage and returns the exposed ETag", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200, headers: { ETag: '"r2-etag"' } }),
    );
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    await expect(putFileToUpload(session, file, undefined, fetchImpl)).resolves.toEqual({
      etag: '"r2-etag"',
    });
    expect(fetchImpl).toHaveBeenCalledWith(session.upload_url, {
      method: "PUT",
      headers: session.upload_headers,
      body: file,
      signal: undefined,
    });
  });

  it("uploads multipart plans with at most three concurrent requests and ordered ETags", async () => {
    const partSize = 5 * 1024 * 1024;
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      const partNumber = Number(String(url).split("part-")[1]);
      return new Response(null, { status: 200, headers: { ETag: `"etag-${partNumber}"` } });
    }) as unknown as typeof fetch;
    const multipartSession = {
      ...session,
      upload_method: "multipart" as const,
      upload_url: null,
      part_size_bytes: partSize,
      upload_parts: [1, 2, 3, 4].map((part_number) => ({
        part_number,
        upload_url: `https://uploads.example.test/part-${part_number}`,
        upload_headers: {},
      })),
    };
    const file = new File([new Uint8Array(partSize * 3 + 1)], "large.bin");

    await expect(
      putFileToUpload(multipartSession, file, undefined, fetchImpl),
    ).resolves.toEqual({
      parts: [1, 2, 3, 4].map((part_number) => ({
        part_number,
        etag: `"etag-${part_number}"`,
      })),
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("rejects a response without an exposed ETag", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    await expect(putFileToUpload(session, file, undefined, fetchImpl)).rejects.toThrow(
      "Storage did not return an upload confirmation",
    );
  });
});

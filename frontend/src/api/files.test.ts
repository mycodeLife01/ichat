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
    await api.readUrl("file-1", "download");

    expect(client.request).toHaveBeenNthCalledWith(1, "/files/uploads", {
      method: "POST",
      body: { filename: "notes.txt", content_type: "text/plain", size_bytes: 5 },
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
    expect(client.request).toHaveBeenNthCalledWith(5, "/files/file-1/read-url", {
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

    await expect(putFileToUpload(session, file, undefined, fetchImpl)).resolves.toBe('"r2-etag"');
    expect(fetchImpl).toHaveBeenCalledWith(session.upload_url, {
      method: "PUT",
      headers: session.upload_headers,
      body: file,
      signal: undefined,
    });
  });

  it("rejects a response without an exposed ETag", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    await expect(putFileToUpload(session, file, undefined, fetchImpl)).rejects.toThrow(
      "Storage did not return an upload confirmation",
    );
  });
});

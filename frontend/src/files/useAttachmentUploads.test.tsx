import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FilesApi } from "../api/files";
import { attachmentDraftStore } from "./draftStore";
import { useAttachmentUploads } from "./useAttachmentUploads";
import type { FileUploadRecord, FilesCapability } from "./types";

const capability: FilesCapability = {
  enabled: true,
  allowed_extensions: ["txt", "png"],
  category_max_bytes: { text: 32, image: 64 },
  max_attachments_per_message: 2,
  max_message_bytes: 80,
  quota_bytes: 1024,
  target_turn_tokens: 128_000,
  context_budget_tokens: 256_000,
  image_model_input: false,
};

const session = {
  upload_id: "upload-1",
  upload_url: "https://uploads.example.test/upload-1",
  upload_headers: { "content-type": "text/plain" },
  upload_url_expires_at: "2026-08-01T10:05:00Z",
  session_expires_at: "2026-08-01T10:30:00Z",
};

const readyRecord: FileUploadRecord = {
  upload_id: "upload-1",
  status: "succeeded",
  error_code: null,
  file: {
    id: "file-1",
    name: "notes.txt",
    media_type: "text/plain",
    size_bytes: 5,
    category: "text",
    model_consumable: true,
    warning: [],
    preview_available: false,
  },
};

function makeApi(overrides: Partial<FilesApi> = {}): FilesApi {
  return {
    createUpload: vi.fn(async () => session),
    confirm: vi.fn(async () => readyRecord),
    status: vi.fn(async () => []),
    cancel: vi.fn(async (uploadId) => ({
      upload_id: uploadId,
      status: "cancelled" as const,
      error_code: null,
      file: null,
    })),
    readUrl: vi.fn(async () => ({
      url: "https://downloads.example.test/file-1",
      expires_at: "2026-08-01T10:05:00Z",
    })),
    ...overrides,
  };
}

afterEach(() => {
  localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.restoreAllMocks();
});

describe("useAttachmentUploads", () => {
  it("creates, directly PUTs, confirms, and persists a ready attachment", async () => {
    const filesApi = makeApi();
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200, headers: { ETag: '"r2-etag"' } }),
    );
    const { result } = renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability,
        filesApi,
        fetchImpl,
      }),
    );

    act(() => result.current.setDraftContent("please read this"));
    act(() => result.current.addFiles([new File(["hello"], "notes.txt", { type: "text/plain" })]));

    await waitFor(() => expect(result.current.readyAttachmentIds).toEqual(["file-1"]));
    expect(filesApi.createUpload).toHaveBeenCalledWith({
      filename: "notes.txt",
      content_type: "text/plain",
      size_bytes: 5,
    });
    expect(filesApi.confirm).toHaveBeenCalledWith("upload-1", '"r2-etag"');
    expect(fetchImpl).toHaveBeenCalledWith(session.upload_url, expect.objectContaining({ method: "PUT" }));
    expect(attachmentDraftStore.read(7, "conversation-1")).toMatchObject({
      content: "please read this",
      attachments: [{ upload_id: "upload-1", status: "succeeded" }],
    });
  });

  it("blocks unsupported files and enforces the local count limit before creating uploads", () => {
    const filesApi = makeApi();
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability: { ...capability, max_attachments_per_message: 1 },
        filesApi,
        onError,
      }),
    );

    act(() =>
      result.current.addFiles([
        new File(["ignored"], "script.exe", { type: "application/octet-stream" }),
        new File(["one"], "one.txt", { type: "text/plain" }),
        new File(["two"], "two.txt", { type: "text/plain" }),
      ]),
    );

    expect(onError).toHaveBeenCalledWith("This file type is not supported.");
    expect(onError).toHaveBeenCalledWith("You can attach at most 1 files to one message.");
    expect(filesApi.createUpload).toHaveBeenCalledTimes(1);
  });

  it("restores queued upload ids and resumes consolidated status polling", async () => {
    attachmentDraftStore.write(7, "conversation-1", {
      content: "saved text",
      attachments: [
        {
          client_id: "local-1",
          upload_id: "upload-1",
          status: "queued",
          error_code: null,
          file: null,
          name: "notes.txt",
          media_type: "text/plain",
          size_bytes: 5,
          category: "text",
        },
      ],
    });
    const filesApi = makeApi({ status: vi.fn(async () => [readyRecord]) });
    const onRestoredContent = vi.fn();

    const { result } = renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability,
        filesApi,
        onRestoredContent,
      }),
    );

    await waitFor(() => expect(onRestoredContent).toHaveBeenCalledWith("saved text"));
    await waitFor(() => expect(filesApi.status).toHaveBeenCalledWith(["upload-1"]));
    await waitFor(() => expect(result.current.readyAttachmentIds).toEqual(["file-1"]));
  });

  it("cancels a durable upload and removes its draft card", async () => {
    const filesApi = makeApi({
      createUpload: vi.fn(async () => session),
    });
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const { result } = renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability,
        filesApi,
        fetchImpl,
      }),
    );

    act(() => result.current.addFiles([new File(["hello"], "notes.txt", { type: "text/plain" })]));
    await waitFor(() => expect(result.current.attachments[0]?.upload_id).toBe("upload-1"));
    const clientId = result.current.attachments[0]?.client_id;
    expect(clientId).toBeTruthy();

    await act(async () => {
      await result.current.cancelAttachment(clientId as string);
    });

    expect(filesApi.cancel).toHaveBeenCalledWith("upload-1");
    expect(result.current.attachments).toEqual([]);
  });

  it("pauses batch polling while the page is hidden and resumes on visibility", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    attachmentDraftStore.write(7, "conversation-1", {
      content: "",
      attachments: [
        {
          client_id: "local-1",
          upload_id: "upload-1",
          status: "queued",
          error_code: null,
          file: null,
          name: "notes.txt",
          media_type: "text/plain",
          size_bytes: 5,
          category: "text",
        },
      ],
    });
    const filesApi = makeApi({ status: vi.fn(async () => [readyRecord]) });

    renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability,
        filesApi,
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(filesApi.status).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(filesApi.status).toHaveBeenCalledWith(["upload-1"]));
  });

  it("does not treat a ready image as a standalone model-readable attachment", () => {
    attachmentDraftStore.write(7, "conversation-1", {
      content: "",
      attachments: [
        {
          client_id: "local-image",
          upload_id: "upload-image",
          status: "succeeded",
          error_code: null,
          file: {
            id: "file-image",
            name: "photo.png",
            media_type: "image/png",
            size_bytes: 5,
            category: "image",
            // Keep this intentionally true: display-only images must still
            // never unlock an otherwise empty message.
            model_consumable: true,
            warning: [],
            preview_available: true,
          },
          name: "photo.png",
          media_type: "image/png",
          size_bytes: 5,
          category: "image",
        },
      ],
    });

    const { result } = renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability,
        filesApi: makeApi(),
      }),
    );

    expect(result.current.hasModelConsumableAttachment).toBe(false);
  });
});

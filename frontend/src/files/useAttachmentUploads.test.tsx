import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FilesApi } from "../api/files";
import { attachmentDraftStore } from "./draftStore";
import {
  FILE_UPLOAD_FAILURE_MESSAGE,
  useAttachmentUploads,
} from "./useAttachmentUploads";
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
    model_input_kind: "document",
    warning: [],
    preview_available: false,
  },
};

// `response_model_exclude_none=True` omits `file` from non-terminal wire payloads.
const queuedRecordWithoutFile: FileUploadRecord = {
  upload_id: "upload-1",
  status: "queued",
  error_code: null,
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
    cancelMany: vi.fn(async (uploadIds: string[]) =>
      uploadIds.map((uploadId) => ({
        upload_id: uploadId,
        status: "cancelled" as const,
        error_code: null,
        file: null,
      })),
    ),
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

  it("handles a queued response without file before polling the ready attachment", async () => {
    const filesApi = makeApi({
      confirm: vi.fn(async () => queuedRecordWithoutFile),
      status: vi.fn(async () => [readyRecord]),
    });
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

    act(() => result.current.addFiles([new File(["hello"], "notes.txt", { type: "text/plain" })]));

    await waitFor(() => expect(filesApi.status).toHaveBeenCalledWith(["upload-1"]));
    await waitFor(() => expect(result.current.readyAttachmentIds).toEqual(["file-1"]));
    expect(result.current.attachments[0]?.file).toEqual(readyRecord.file);
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

    expect(onError).toHaveBeenCalledWith(FILE_UPLOAD_FAILURE_MESSAGE);
    expect(onError).toHaveBeenCalledWith("You can attach at most 1 files to one message.");
    expect(filesApi.createUpload).toHaveBeenCalledTimes(1);
  });

  it("ejects a file and shows the ChatGPT-style toast when upload creation fails", async () => {
    const filesApi = makeApi({
      createUpload: vi.fn(async () => {
        throw new Error("backend detail must not leak into the toast");
      }),
    });
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability,
        filesApi,
        onError,
      }),
    );

    act(() => result.current.addFiles([new File(["hello"], "notes.txt", { type: "text/plain" })]));

    await waitFor(() => expect(result.current.attachments).toEqual([]));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(FILE_UPLOAD_FAILURE_MESSAGE);
    expect(attachmentDraftStore.read(7, "conversation-1").attachments).toEqual([]);
  });

  it("ejects a file when confirmation returns a terminal processing failure", async () => {
    const failedRecord: FileUploadRecord = {
      upload_id: "upload-1",
      status: "rejected",
      error_code: "unsupported_file_type",
      message: "server-specific detail",
      file: null,
    };
    const filesApi = makeApi({ confirm: vi.fn(async () => failedRecord) });
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200, headers: { ETag: '"r2-etag"' } }),
    );
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability,
        filesApi,
        fetchImpl,
        onError,
      }),
    );

    act(() => result.current.addFiles([new File(["hello"], "notes.txt", { type: "text/plain" })]));

    await waitFor(() => expect(result.current.attachments).toEqual([]));
    expect(onError).toHaveBeenCalledWith(FILE_UPLOAD_FAILURE_MESSAGE);
  });

  it("ejects a restored file when polling reports a terminal processing failure", async () => {
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
    const filesApi = makeApi({
      status: vi.fn(async () => [
        {
          upload_id: "upload-1",
          status: "failed" as const,
          error_code: "processing_failed",
          file: null,
        },
      ]),
    });
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability,
        filesApi,
        onError,
      }),
    );

    await waitFor(() => expect(result.current.attachments).toEqual([]));
    expect(onError).toHaveBeenCalledWith(FILE_UPLOAD_FAILURE_MESSAGE);
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

  it("ejects a failed attachment restored from an older draft", async () => {
    attachmentDraftStore.write(7, "conversation-1", {
      content: "keep this text",
      attachments: [
        {
          client_id: "failed-local",
          upload_id: "failed-upload",
          status: "failed",
          error_code: "processing_failed",
          file: null,
          name: "broken.txt",
          media_type: "text/plain",
          size_bytes: 5,
          category: "text",
        },
      ],
    });
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability,
        filesApi: makeApi(),
        onError,
      }),
    );

    expect(result.current.attachments).toEqual([]);
    expect(attachmentDraftStore.read(7, "conversation-1")).toEqual({
      content: "keep this text",
      attachments: [],
    });
    expect(onError).toHaveBeenCalledWith(FILE_UPLOAD_FAILURE_MESSAGE);
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

  it("rejects removeImages when any image cancellation fails", async () => {
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
            model_input_kind: "image",
            warning: [],
            preview_available: true,
          },
          name: "photo.png",
          media_type: "image/png",
          size_bytes: 5,
          category: "image",
        },
        {
          client_id: "local-image-2",
          upload_id: "upload-image-2",
          status: "succeeded",
          error_code: null,
          file: {
            id: "file-image-2",
            name: "photo-2.png",
            media_type: "image/png",
            size_bytes: 5,
            category: "image",
            model_input_kind: "image",
            warning: [],
            preview_available: true,
          },
          name: "photo-2.png",
          media_type: "image/png",
          size_bytes: 5,
          category: "image",
        },
      ],
    });
    const onError = vi.fn();
    const filesApi = makeApi({
      cancelMany: vi.fn(async () => {
        throw new Error("cancel failed");
      }),
    });
    const { result } = renderHook(() =>
      useAttachmentUploads({
        userId: 7,
        conversationId: "conversation-1",
        capability,
        filesApi,
        onError,
      }),
    );

    await expect(result.current.removeImages()).rejects.toThrow("cancel failed");
    expect(filesApi.cancelMany).toHaveBeenCalledWith(["upload-image", "upload-image-2"]);
    expect(result.current.attachments).toHaveLength(2);
    expect(onError).toHaveBeenCalledWith("The uploads could not be cancelled. Please try again.");
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
            model_input_kind: "image",
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

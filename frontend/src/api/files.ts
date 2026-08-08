import { getDefaultApiClient, type ApiClient } from "./client";
import type {
  FileReadRole,
  FileReadUrl,
  FileUploadRecord,
  FileUploadSession,
} from "../files/types";

export type CreateFileUploadRequest = {
  filename: string;
  content_type: string;
  size_bytes: number;
  multipart_supported?: boolean;
};

export type UploadConfirmation =
  | { etag: string }
  | { parts: Array<{ part_number: number; etag: string }> };

type FilesClient = Pick<ApiClient, "request">;

export function createFilesApi(client?: FilesClient) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    createUpload(body: CreateFileUploadRequest): Promise<FileUploadSession> {
      return resolveClient().request<FileUploadSession>("/files/uploads", {
        method: "POST",
        body: { ...body, multipart_supported: body.multipart_supported ?? true },
      });
    },
    confirm(
      uploadId: string,
      confirmation: string | UploadConfirmation,
    ): Promise<FileUploadRecord> {
      return resolveClient().request<FileUploadRecord>(`/files/uploads/${uploadId}/confirm`, {
        method: "POST",
        body: typeof confirmation === "string" ? { etag: confirmation } : confirmation,
      });
    },
    status(uploadIds: string[]): Promise<FileUploadRecord[]> {
      return resolveClient().request<FileUploadRecord[]>("/files/uploads/status", {
        method: "POST",
        body: { upload_ids: uploadIds },
      });
    },
    cancel(uploadId: string): Promise<FileUploadRecord> {
      return resolveClient().request<FileUploadRecord>(`/files/uploads/${uploadId}`, {
        method: "DELETE",
      });
    },
    cancelMany(uploadIds: string[]): Promise<FileUploadRecord[]> {
      return resolveClient().request<FileUploadRecord[]>("/files/uploads/cancel", {
        method: "POST",
        body: { upload_ids: uploadIds },
      });
    },
    readUrl(fileId: string, role: FileReadRole): Promise<FileReadUrl> {
      return resolveClient().request<FileReadUrl>(`/files/${fileId}/read-url`, {
        method: "POST",
        body: { role },
      });
    },
  };
}

export type FilesApi = ReturnType<typeof createFilesApi>;

export const filesApi = createFilesApi();

export async function putFileToUpload(
  session: FileUploadSession,
  file: File,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadConfirmation> {
  if (session.upload_method === "multipart") {
    return putMultipartFile(session, file, signal, fetchImpl);
  }
  if (!session.upload_url) {
    throw new Error("Storage did not provide an upload URL. Please try again.");
  }
  let response: Response;
  try {
    response = await fetchImpl(session.upload_url, {
      method: "PUT",
      headers: session.upload_headers,
      body: file,
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("The upload could not reach storage. Check your connection and try again.", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error("The file upload was rejected by storage. Please try again.");
  }
  const etag = response.headers.get("ETag");
  if (!etag) {
    throw new Error("Storage did not return an upload confirmation. Please try again.");
  }
  return { etag };
}

async function putMultipartFile(
  session: FileUploadSession,
  file: File,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<UploadConfirmation> {
  const parts = session.upload_parts ?? [];
  const partSize = session.part_size_bytes ?? 0;
  if (parts.length === 0 || partSize < 5 * 1024 * 1024) {
    throw new Error("Storage returned an invalid multipart upload plan. Please try again.");
  }
  const completed: Array<{ part_number: number; etag: string }> = [];
  let cursor = 0;

  const uploadNext = async () => {
    while (cursor < parts.length) {
      const index = cursor++;
      const part = parts[index];
      const start = index * partSize;
      const body = file.slice(start, Math.min(start + partSize, file.size));
      let response: Response | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        try {
          response = await fetchImpl(part.upload_url, {
            method: "PUT",
            headers: part.upload_headers,
            body,
            signal,
          });
          if (response.ok && response.headers.get("ETag")) break;
          lastError = new Error(`Multipart upload part ${part.part_number} failed`);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          lastError = error;
        }
      }
      const etag = response?.ok ? response.headers.get("ETag") : null;
      if (!etag) {
        throw new Error("A multipart upload part failed after retries. Please try again.", {
          cause: lastError,
        });
      }
      completed.push({ part_number: part.part_number, etag });
    }
  };

  await Promise.all(Array.from({ length: Math.min(3, parts.length) }, () => uploadNext()));
  completed.sort((left, right) => left.part_number - right.part_number);
  return { parts: completed };
}

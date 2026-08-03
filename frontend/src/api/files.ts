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
};

type FilesClient = Pick<ApiClient, "request">;

export function createFilesApi(client?: FilesClient) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    createUpload(body: CreateFileUploadRequest): Promise<FileUploadSession> {
      return resolveClient().request<FileUploadSession>("/files/uploads", {
        method: "POST",
        body,
      });
    },
    confirm(uploadId: string, etag: string): Promise<FileUploadRecord> {
      return resolveClient().request<FileUploadRecord>(`/files/uploads/${uploadId}/confirm`, {
        method: "POST",
        body: { etag },
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
): Promise<string> {
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
  return etag;
}

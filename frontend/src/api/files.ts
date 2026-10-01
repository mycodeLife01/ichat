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

export type StoragePutRequest = {
  url: string;
  headers?: Record<string, string>;
  body: Blob;
  signal?: AbortSignal;
  onProgress?: (loadedBytes: number) => void;
};

export type StoragePutResponse = { ok: boolean; etag: string | null };

/** Sends one presigned storage PUT. Injectable so tests need no real network. */
export type StoragePut = (request: StoragePutRequest) => Promise<StoragePutResponse>;

export type PutFileOptions = {
  signal?: AbortSignal;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
  put?: StoragePut;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

const MULTIPART_CONCURRENCY = 3;
const MULTIPART_ATTEMPTS = 3;
const MULTIPART_RETRY_BASE_DELAY_MS = 500;

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// fetch cannot observe request-body progress, so storage PUTs go through XHR.
export const xhrStoragePut: StoragePut = ({ url, headers, body, signal, onProgress }) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const settle = (callback: () => void) => {
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    if (onProgress) xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () =>
      settle(() =>
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          etag: xhr.getResponseHeader("ETag"),
        }),
      );
    xhr.onerror = () => settle(() => reject(new TypeError("Storage request failed")));
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => settle(() => reject(abortError()));
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });

export function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function putFileToUpload(
  session: FileUploadSession,
  file: File,
  options: PutFileOptions = {},
): Promise<UploadConfirmation> {
  const { signal, onProgress, put = xhrStoragePut } = options;
  if (session.upload_method === "multipart") {
    return putMultipartFile(session, file, options);
  }
  if (!session.upload_url) {
    throw new Error("Storage did not provide an upload URL. Please try again.");
  }
  let response: StoragePutResponse;
  try {
    response = await put({
      url: session.upload_url,
      headers: session.upload_headers,
      body: file,
      signal,
      onProgress: onProgress && ((loaded) => onProgress(Math.min(loaded, file.size), file.size)),
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error("The upload could not reach storage. Check your connection and try again.", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error("The file upload was rejected by storage. Please try again.");
  }
  if (!response.etag) {
    throw new Error("Storage did not return an upload confirmation. Please try again.");
  }
  onProgress?.(file.size, file.size);
  return { etag: response.etag };
}

async function putMultipartFile(
  session: FileUploadSession,
  file: File,
  {
    signal,
    onProgress,
    put = xhrStoragePut,
    wait = abortableDelay,
    random = Math.random,
  }: PutFileOptions,
): Promise<UploadConfirmation> {
  const parts = session.upload_parts ?? [];
  const partSize = session.part_size_bytes ?? 0;
  if (parts.length === 0 || partSize < 5 * 1024 * 1024) {
    throw new Error("Storage returned an invalid multipart upload plan. Please try again.");
  }
  const completed: Array<{ part_number: number; etag: string }> = [];
  // Bytes currently counted per part; a retried part starts again from zero.
  const partLoaded = new Array<number>(parts.length).fill(0);
  const reportProgress = (index: number, loaded: number) => {
    partLoaded[index] = loaded;
    if (!onProgress) return;
    const total = partLoaded.reduce((sum, value) => sum + value, 0);
    onProgress(Math.min(total, file.size), file.size);
  };
  let cursor = 0;

  const uploadNext = async () => {
    while (cursor < parts.length) {
      const index = cursor++;
      const part = parts[index];
      const start = index * partSize;
      const body = file.slice(start, Math.min(start + partSize, file.size));
      let etag: string | null = null;
      let lastError: unknown;
      for (let attempt = 0; attempt < MULTIPART_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) throw abortError();
        if (attempt > 0) {
          reportProgress(index, 0);
          // Exponential backoff with 0-50% jitter so concurrent parts spread out.
          const baseDelay = MULTIPART_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          await wait(Math.round(baseDelay * (1 + random() * 0.5)), signal);
        }
        try {
          const response = await put({
            url: part.upload_url,
            headers: part.upload_headers,
            body,
            signal,
            onProgress: (loaded) => reportProgress(index, Math.min(loaded, body.size)),
          });
          if (response.ok && response.etag) {
            etag = response.etag;
            break;
          }
          lastError = new Error(`Multipart upload part ${part.part_number} failed`);
        } catch (error) {
          if (isAbortError(error)) throw error;
          lastError = error;
        }
      }
      if (!etag) {
        throw new Error("A multipart upload part failed after retries. Please try again.", {
          cause: lastError,
        });
      }
      reportProgress(index, body.size);
      completed.push({ part_number: part.part_number, etag });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MULTIPART_CONCURRENCY, parts.length) }, () => uploadNext()),
  );
  completed.sort((left, right) => left.part_number - right.part_number);
  return { parts: completed };
}

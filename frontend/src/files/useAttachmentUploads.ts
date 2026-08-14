import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { putFileToUpload, type FilesApi } from "../api/files";
import { attachmentDraftStore } from "./draftStore";
import {
  categoryForFileName,
  categoryLimit,
  draftFromUpload,
  isPollingStatus,
  isUploadFailed,
  isUploadInProgress,
  isUploadReady,
} from "./utils";
import type {
  DraftAttachment,
  FileUploadRecord,
  FilesCapability,
} from "./types";
import type { ChatModelCapability } from "../api/types";

const FAST_POLL_DELAY_MS = 250;
const FAST_POLL_WINDOW_MS = 10_000;
const INITIAL_BACKOFF_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 5_000;
export const FILE_UPLOAD_FAILURE_MESSAGE = "文件上传失败，请稍后再试";

type AttachmentUploadOptions = {
  userId: number | string | null;
  conversationId: string | null;
  capability?: FilesCapability;
  selectedModel?: ChatModelCapability | null;
  canCreate?: boolean;
  filesApi: FilesApi;
  onRestoredContent?: (content: string) => void;
  onError?: (message: string) => void;
  onImagesBlocked?: (files: File[]) => void;
  fetchImpl?: typeof fetch;
};

type DetachedImagePreview = {
  clientId: string;
  fileId: string;
  url: string;
};

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function sameAttachment(left: DraftAttachment, right: DraftAttachment): boolean {
  const leftFile = left.file ?? null;
  const rightFile = right.file ?? null;
  const sameFile =
    leftFile === rightFile ||
    (leftFile !== null &&
      rightFile !== null &&
      leftFile.id === rightFile.id &&
      leftFile.name === rightFile.name &&
      leftFile.media_type === rightFile.media_type &&
      leftFile.size_bytes === rightFile.size_bytes &&
      leftFile.category === rightFile.category &&
      leftFile.model_input_kind === rightFile.model_input_kind &&
      leftFile.preview_available === rightFile.preview_available &&
      leftFile.upload_expires_at === rightFile.upload_expires_at &&
      JSON.stringify(leftFile.warning ?? leftFile.warnings ?? []) ===
        JSON.stringify(rightFile.warning ?? rightFile.warnings ?? []));
  return (
    left.client_id === right.client_id &&
    left.upload_id === right.upload_id &&
    left.status === right.status &&
    left.error_code === right.error_code &&
    left.error_message === right.error_message &&
    sameFile &&
    left.name === right.name &&
    left.media_type === right.media_type &&
    left.size_bytes === right.size_bytes &&
    left.category === right.category &&
    left.local_preview_url === right.local_preview_url &&
    left.session_expires_at === right.session_expires_at
  );
}

function sameAttachmentList(left: DraftAttachment[], right: DraftAttachment[]): boolean {
  return left.length === right.length && left.every((item, index) => sameAttachment(item, right[index]));
}

/**
 * Owns only unsent composer attachments. The server remains the source of
 * truth for upload state; local storage preserves upload ids and order so a
 * reload can resume batch status polling, never an interrupted PUT.
 */
export function useAttachmentUploads({
  userId,
  conversationId,
  capability,
  selectedModel = null,
  canCreate = true,
  filesApi,
  onRestoredContent,
  onError,
  onImagesBlocked,
  fetchImpl,
}: AttachmentUploadOptions) {
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  const contentRef = useRef("");
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const sourcesRef = useRef(new Map<string, File>());
  const previewUrlsRef = useRef(new Map<string, string>());
  const scopeVersionRef = useRef(0);
  const restoredContentRef = useRef(onRestoredContent);
  const errorRef = useRef(onError);
  restoredContentRef.current = onRestoredContent;
  errorRef.current = onError;

  const persist = useCallback(
    (next: DraftAttachment[]) => {
      if (userId == null) return;
      attachmentDraftStore.write(userId, conversationId, {
        content: contentRef.current,
        attachments: next,
      });
    },
    [conversationId, userId],
  );

  const commit = useCallback(
    (updater: (current: DraftAttachment[]) => DraftAttachment[]) => {
      setAttachments((current) => {
        const next = updater(current);
        if (sameAttachmentList(current, next)) return current;
        attachmentsRef.current = next;
        persist(next);
        return next;
      });
    },
    [persist],
  );

  // Drafts are scoped to the current authenticated user and conversation. A
  // user switch must not expose a previous account's file ids or text.
  useEffect(() => {
    scopeVersionRef.current += 1;
    abortControllersRef.current.forEach((controller) => controller.abort());
    abortControllersRef.current.clear();
    sourcesRef.current.clear();
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();

    if (userId == null) {
      attachmentsRef.current = [];
      setAttachments([]);
      contentRef.current = "";
      return;
    }

    attachmentDraftStore.clearOtherUsers(userId);
    const restored = attachmentDraftStore.read(userId, conversationId);
    const restoredAttachments = restored.attachments.filter(
      (attachment) => !isUploadFailed(attachment.status),
    );
    attachmentsRef.current = restoredAttachments;
    contentRef.current = restored.content;
    setAttachments(restoredAttachments);
    if (restoredAttachments.length !== restored.attachments.length) {
      attachmentDraftStore.write(userId, conversationId, {
        content: restored.content,
        attachments: restoredAttachments,
      });
      errorRef.current?.(FILE_UPLOAD_FAILURE_MESSAGE);
    }
    restoredContentRef.current?.(restored.content);
  }, [conversationId, userId]);

  useEffect(
    () => () => {
      abortControllersRef.current.forEach((controller) => controller.abort());
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  const setDraftContent = useCallback(
    (content: string) => {
      contentRef.current = content;
      persist(attachmentsRef.current);
    },
    [persist],
  );

  const discardLocalAttachment = useCallback((clientId: string) => {
    abortControllersRef.current.get(clientId)?.abort();
    abortControllersRef.current.delete(clientId);
    sourcesRef.current.delete(clientId);
    const previewUrl = previewUrlsRef.current.get(clientId);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrlsRef.current.delete(clientId);
  }, []);

  const updateUploadRecord = useCallback(
    (record: FileUploadRecord, clientId: string) => {
      if (
        record.status === "rejected" ||
        record.status === "failed" ||
        record.status === "expired" ||
        record.status === "cancelled"
      ) {
        const failedClientIds = new Set([
          clientId,
          ...attachmentsRef.current
            .filter((attachment) => attachment.upload_id === record.upload_id)
            .map((attachment) => attachment.client_id),
        ]);
        failedClientIds.forEach(discardLocalAttachment);
        commit((current) =>
          current.filter(
            (attachment) =>
              attachment.client_id !== clientId && attachment.upload_id !== record.upload_id,
          ),
        );
        if (record.status !== "cancelled") errorRef.current?.(FILE_UPLOAD_FAILURE_MESSAGE);
        return;
      }
      commit((current) =>
        current.map((attachment) =>
          attachment.upload_id === record.upload_id
            ? draftFromUpload(attachment, {
                status: record.status,
                error_code: record.error_code ?? null,
                message: record.message,
                file: record.file,
              })
            : attachment,
        ),
      );
    },
    [commit, discardLocalAttachment],
  );

  const startFile = useCallback(
    async (file: File): Promise<void> => {
      const scopeVersion = scopeVersionRef.current;
      const isCurrentScope = () => scopeVersion === scopeVersionRef.current;
      const clientId = randomId();
      const category = categoryForFileName(file.name);
      const localPreviewUrl =
        category === "image" && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined;
      if (localPreviewUrl) previewUrlsRef.current.set(clientId, localPreviewUrl);
      const initial: DraftAttachment = {
        client_id: clientId,
        upload_id: null,
        status: "creating",
        error_code: null,
        error_message: null,
        file: null,
        name: file.name,
        media_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        category,
        model_input_kind: category === "image" ? "image" : null,
        local_preview_url: localPreviewUrl,
      };
      sourcesRef.current.set(clientId, file);
      commit((current) => [...current, initial]);

      try {
        const session = await filesApi.createUpload({
          filename: file.name,
          content_type: file.type || "application/octet-stream",
          size_bytes: file.size,
        });
        if (!isCurrentScope()) return;
        commit((current) =>
          current.map((attachment) =>
            attachment.client_id === clientId
              ? {
                  ...attachment,
                  upload_id: session.upload_id,
                  status: "uploading",
                  session_expires_at: session.session_expires_at,
                }
              : attachment,
          ),
        );

        const controller = new AbortController();
        abortControllersRef.current.set(clientId, controller);
        const confirmation = await putFileToUpload(session, file, controller.signal, fetchImpl);
        abortControllersRef.current.delete(clientId);
        if (!isCurrentScope()) return;
        const record = await filesApi.confirm(session.upload_id, confirmation);
        if (!isCurrentScope()) return;
        updateUploadRecord(record, clientId);
      } catch (error) {
        abortControllersRef.current.delete(clientId);
        if (!isCurrentScope() || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        discardLocalAttachment(clientId);
        commit((current) => current.filter((attachment) => attachment.client_id !== clientId));
        errorRef.current?.(FILE_UPLOAD_FAILURE_MESSAGE);
      }
    },
    [commit, discardLocalAttachment, fetchImpl, filesApi, updateUploadRecord],
  );

  const addFiles = useCallback(
    (input: FileList | File[]) => {
      const selected = Array.from(input);
      if (selected.length === 0) return;
      if (!capability?.enabled || !canCreate) {
        errorRef.current?.(
          canCreate
            ? "File uploads are currently unavailable."
            : "Verify your email before uploading files.",
        );
        return;
      }

      const hasImage = selected.some((file) => categoryForFileName(file.name) === "image");
      if (hasImage && selectedModel?.supports_image_input !== true) {
        onImagesBlocked?.(selected);
        return;
      }

      const allowedExtensions = new Set(capability.allowed_extensions.map((item) => item.toLowerCase()));
      const existingCount = attachmentsRef.current.length;
      const maxCount = capability.max_attachments_per_message;
      const accepted: File[] = [];
      let totalSize = attachmentsRef.current.reduce((sum, item) => sum + item.size_bytes, 0);

      for (const file of selected) {
        const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
        if (!extension || !allowedExtensions.has(extension)) {
          errorRef.current?.(FILE_UPLOAD_FAILURE_MESSAGE);
          continue;
        }
        if (existingCount + accepted.length >= maxCount) {
          errorRef.current?.(`You can attach at most ${maxCount} files to one message.`);
          break;
        }
        const limit = categoryLimit(capability.category_max_bytes, file.name);
        if (limit != null && file.size > limit) {
          errorRef.current?.("This file is larger than the allowed limit.");
          continue;
        }
        if (totalSize + file.size > capability.max_message_bytes) {
          errorRef.current?.("The selected files exceed the message size limit.");
          continue;
        }
        totalSize += file.size;
        accepted.push(file);
      }

      for (const file of accepted) void startFile(file);
    },
    [canCreate, capability, onImagesBlocked, selectedModel, startFile],
  );

  const cancelAttachment = useCallback(
    async (clientId: string, options?: { throwOnError?: boolean }): Promise<void> => {
      const attachment = attachmentsRef.current.find((item) => item.client_id === clientId);
      if (!attachment) return;
      abortControllersRef.current.get(clientId)?.abort();
      abortControllersRef.current.delete(clientId);
      try {
        if (attachment.upload_id) await filesApi.cancel(attachment.upload_id);
        discardLocalAttachment(clientId);
        commit((current) => current.filter((item) => item.client_id !== clientId));
      } catch (error) {
        errorRef.current?.("The upload could not be cancelled. Please try again.");
        if (options?.throwOnError) throw error;
      }
    },
    [commit, discardLocalAttachment, filesApi],
  );

  const retryAttachment = useCallback(
    (clientId: string) => {
      const file = sourcesRef.current.get(clientId);
      if (!file) {
        errorRef.current?.("Please select the file again to retry this upload.");
        return;
      }
      commit((current) => current.filter((item) => item.client_id !== clientId));
      discardLocalAttachment(clientId);
      void startFile(file);
    },
    [commit, discardLocalAttachment, startFile],
  );

  const moveAttachment = useCallback(
    (clientId: string, direction: -1 | 1) => {
      commit((current) => {
        const index = current.findIndex((item) => item.client_id === clientId);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= current.length) return current;
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
    },
    [commit],
  );

  // Hand the already-decoded composer object URL to the sent message. Removing
  // it from this hook's ownership prevents clear/scope cleanup from revoking it
  // during the composer-to-thread transition.
  const detachImagePreviews = useCallback(
    (fileIds: readonly string[]): DetachedImagePreview[] => {
      const selectedIds = new Set(fileIds);
      const detached: DetachedImagePreview[] = [];
      for (const attachment of attachmentsRef.current) {
        const fileId = attachment.file?.id;
        if (!fileId || !selectedIds.has(fileId) || attachment.category !== "image") continue;
        const url = previewUrlsRef.current.get(attachment.client_id);
        if (!url) continue;
        previewUrlsRef.current.delete(attachment.client_id);
        detached.push({ clientId: attachment.client_id, fileId, url });
      }
      return detached;
    },
    [],
  );

  // A failed send leaves the attachments in the composer, so return ownership
  // to the upload hook. If the user removed one meanwhile, release its orphaned
  // object URL here instead.
  const restoreImagePreviews = useCallback((previews: readonly DetachedImagePreview[]) => {
    for (const preview of previews) {
      const attachment = attachmentsRef.current.find(
        (item) =>
          item.client_id === preview.clientId &&
          item.file?.id === preview.fileId &&
          item.local_preview_url === preview.url,
      );
      if (attachment) previewUrlsRef.current.set(preview.clientId, preview.url);
      else URL.revokeObjectURL(preview.url);
    }
  }, []);

  const clear = useCallback(() => {
    if (userId != null) attachmentDraftStore.clear(userId, conversationId);
    abortControllersRef.current.forEach((controller) => controller.abort());
    abortControllersRef.current.clear();
    sourcesRef.current.clear();
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
    attachmentsRef.current = [];
    setAttachments([]);
  }, [conversationId, userId]);

  const pollingKey = attachments
    .filter((attachment) => attachment.upload_id && isPollingStatus(attachment.status))
    .map((attachment) => `${attachment.upload_id}:${attachment.status}`)
    .join(",");

  // A visible tab restarts the polling effect immediately. While hidden, the
  // effect has no timer at all, rather than merely slowing its cadence.
  const [visibilityVersion, setVisibilityVersion] = useState(0);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") setVisibilityVersion((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (pollingKey === "" || document.visibilityState === "hidden") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pollingStartedAt = performance.now();
    let backoffDelay = INITIAL_BACKOFF_POLL_DELAY_MS;

    const poll = async () => {
      const uploadIds = attachmentsRef.current
        .filter((attachment) => attachment.upload_id && isPollingStatus(attachment.status))
        .map((attachment) => attachment.upload_id as string);
      if (uploadIds.length === 0 || cancelled || document.visibilityState === "hidden") return;

      try {
        const records = await filesApi.status(uploadIds);
        if (cancelled) return;
        const byId = new Map(records.map((record) => [record.upload_id, record]));
        const failedUploadIds = new Set(
          records
            .filter(
              (record) =>
                record.status === "rejected" ||
                record.status === "failed" ||
                record.status === "expired",
            )
            .map((record) => record.upload_id),
        );
        const cancelledUploadIds = new Set(
          records
            .filter((record) => record.status === "cancelled")
            .map((record) => record.upload_id),
        );
        const removedUploadIds = new Set([...failedUploadIds, ...cancelledUploadIds]);
        const removed = attachmentsRef.current.filter(
          (attachment) => attachment.upload_id && removedUploadIds.has(attachment.upload_id),
        );
        removed.forEach((attachment) => discardLocalAttachment(attachment.client_id));
        commit((current) =>
          current
            .filter(
              (attachment) =>
                !attachment.upload_id || !removedUploadIds.has(attachment.upload_id),
            )
            .map((attachment) => {
              const record = attachment.upload_id ? byId.get(attachment.upload_id) : undefined;
              return record
                ? draftFromUpload(attachment, {
                    status: record.status,
                    error_code: record.error_code ?? null,
                    message: record.message,
                    file: record.file,
                  })
                : attachment;
            }),
        );
        if (failedUploadIds.size > 0) errorRef.current?.(FILE_UPLOAD_FAILURE_MESSAGE);
      } catch {
        // Keep the card in its durable state. A later poll can recover from a
        // transient API failure without inventing a failed upload terminal state.
      }

      if (!cancelled && document.visibilityState === "visible") {
        const fastPolling = performance.now() - pollingStartedAt < FAST_POLL_WINDOW_MS;
        const nextDelay = fastPolling ? FAST_POLL_DELAY_MS : backoffDelay;
        if (!fastPolling) {
          backoffDelay = Math.min(Math.round(backoffDelay * 1.5), MAX_POLL_DELAY_MS);
        }
        timer = setTimeout(() => void poll(), nextDelay);
      }
    };

    timer = setTimeout(() => void poll(), 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [commit, discardLocalAttachment, filesApi, pollingKey, visibilityVersion]);

  const readyAttachmentIds = useMemo(
    () =>
      attachments
        .filter((attachment) => isUploadReady(attachment.status) && attachment.file)
        .map((attachment) => attachment.file?.id)
        .filter((id): id is string => Boolean(id)),
    [attachments],
  );
  const hasPendingAttachments = attachments.some((attachment) => isUploadInProgress(attachment.status));
  const hasFailedAttachments = attachments.some((attachment) => isUploadFailed(attachment.status));
  const hasModelConsumableAttachment = attachments.some(
    (attachment) =>
      isUploadReady(attachment.status) &&
      (attachment.file?.model_input_kind === "document" ||
        (attachment.file?.model_input_kind === "image" &&
          selectedModel?.supports_image_input === true)),
  );
  const hasReadyImageAttachment = attachments.some(
    (attachment) =>
      isUploadReady(attachment.status) &&
      (attachment.file?.category ?? attachment.category) === "image",
  );
  const removeImages = useCallback(async (): Promise<void> => {
    const images = attachmentsRef.current.filter(
      (attachment) =>
        (attachment.file?.model_input_kind ?? attachment.model_input_kind) === "image" ||
        (attachment.file?.category ?? attachment.category) === "image",
    );
    const uploadIds = images
      .map((attachment) => attachment.upload_id)
      .filter((uploadId): uploadId is string => uploadId !== null);
    try {
      if (uploadIds.length > 0) await filesApi.cancelMany(uploadIds);
    } catch (error) {
      errorRef.current?.("The uploads could not be cancelled. Please try again.");
      throw error;
    }
    const imageClientIds = new Set(images.map((attachment) => attachment.client_id));
    imageClientIds.forEach(discardLocalAttachment);
    commit((current) => current.filter((item) => !imageClientIds.has(item.client_id)));
  }, [commit, discardLocalAttachment, filesApi]);

  return {
    attachments,
    readyAttachmentIds,
    hasPendingAttachments,
    hasFailedAttachments,
    hasModelConsumableAttachment,
    hasReadyImageAttachment,
    removeImages,
    addFiles,
    cancelAttachment,
    retryAttachment,
    moveAttachment,
    detachImagePreviews,
    restoreImagePreviews,
    clear,
    setDraftContent,
  };
}

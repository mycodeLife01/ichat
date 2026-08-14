export type FileCategory =
  | "image"
  | "pdf"
  | "office"
  | "text"
  | "data"
  | "code"
  | (string & {});

export type FileUploadStatus =
  | "pending"
  | "queued"
  | "processing"
  | "succeeded"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

export type FileAttachment = {
  id: string;
  name: string;
  media_type: string;
  size_bytes: number;
  category: FileCategory;
  model_input_kind: "document" | "image" | null;
  position?: number;
  /** The API contract uses `warning`; `warnings` is accepted for old payloads. */
  warning?: string[];
  warnings?: string[];
  preview_available: boolean;
  stats?: Record<string, number | string>;
  upload_expires_at?: string | null;
  unbound_expires_at?: string | null;
};

/**
 * Public-share attachment metadata. It carries no file id: `ref` is an opaque
 * share-scoped handle the anonymous read route exchanges for a signed URL, and
 * the server resolves it against the stored snapshot.
 */
export type SharedAttachmentPlaceholder = {
  name: string;
  media_type: string;
  size_bytes: number;
  category: FileCategory;
  warning?: string[];
  warnings?: string[];
  // These are optional for backwards-compatible snapshots; their absence must
  // never be treated as permission to preview or download.
  model_input_kind?: "document" | "image" | null;
  preview_available?: boolean;
  /** Absent on snapshots minted before public attachment reads existed. */
  ref?: string;
  position?: number;
  stats?: Record<string, number | string>;
};

export type FileUploadRecord = {
  upload_id: string;
  status: FileUploadStatus;
  error_code: string | null;
  message?: string | null;
  file?: FileAttachment | null;
};

export type FileUploadSession = {
  upload_id: string;
  upload_method?: "single" | "multipart";
  upload_url?: string | null;
  upload_headers: Record<string, string>;
  upload_parts?: Array<{
    part_number: number;
    upload_url: string;
    upload_headers: Record<string, string>;
  }>;
  part_size_bytes?: number | null;
  upload_url_expires_at: string;
  session_expires_at: string;
};

export type FileReadRole = "preview" | "download";

export type FileReadUrl = {
  url: string;
  expires_at: string;
};

export type FilesCapability = {
  enabled: boolean;
  allowed_extensions: string[];
  category_max_bytes: Record<string, number>;
  max_attachments_per_message: number;
  max_message_bytes: number;
  quota_bytes: number;
  target_turn_tokens: number;
  context_budget_tokens: number;
};

/**
 * A composer attachment deliberately has client-side status in addition to the
 * durable API status. `uploading` is only the direct browser-to-R2 phase and
 * is never sent to the server.
 */
export type DraftAttachmentStatus = FileUploadStatus | "creating" | "uploading";

export type DraftAttachment = {
  client_id: string;
  upload_id: string | null;
  status: DraftAttachmentStatus;
  error_code: string | null;
  error_message?: string | null;
  file: FileAttachment | null;
  name: string;
  media_type: string;
  size_bytes: number;
  category: FileCategory;
  model_input_kind?: "document" | "image" | null;
  /** Ephemeral object URL for an image selected in this browser tab. */
  local_preview_url?: string;
  session_expires_at?: string | null;
};

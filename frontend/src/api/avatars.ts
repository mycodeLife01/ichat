import type { ApiClient } from "./client";

export type AvatarUploadStatus =
  | "pending"
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "expired";

export type CreateAvatarUploadResponse = {
  upload_id: string;
  upload_url: string;
  upload_headers: Record<string, string>;
  upload_url_expires_at: string;
  session_expires_at: string;
};

export type AvatarUploadResponse = {
  upload_id: string;
  status: AvatarUploadStatus;
  error_code?: string | null;
  message?: string | null;
  avatar_url?: string | null;
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export async function uploadAvatar(client: ApiClient, blob: Blob): Promise<string> {
  const session = await client.request<CreateAvatarUploadResponse>(
    "/auth/me/avatar-uploads",
    { method: "POST", body: { size_bytes: blob.size } },
  );
  const uploadResponse = await fetch(session.upload_url, {
    method: "PUT",
    headers: session.upload_headers,
    body: blob,
  });
  if (!uploadResponse.ok) throw new Error("Avatar upload failed");
  const etag = uploadResponse.headers.get("ETag");
  if (!etag) throw new Error("Avatar upload response did not expose ETag");

  let state = await client.request<AvatarUploadResponse>(
    `/auth/me/avatar-uploads/${session.upload_id}/confirm`,
    { method: "POST", body: { etag } },
  );
  const deadline = Date.now() + 120_000;
  while (state.status === "pending" || state.status === "queued" || state.status === "processing") {
    if (Date.now() >= deadline) throw new Error("Avatar processing timed out");
    await wait(1_000);
    state = await client.request<AvatarUploadResponse>(
      `/auth/me/avatar-uploads/${session.upload_id}`,
    );
  }
  if (state.status !== "succeeded" || !state.avatar_url) {
    throw new Error(state.message || "Avatar processing failed");
  }
  return state.avatar_url;
}

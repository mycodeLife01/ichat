import { getDefaultApiClient, type ApiClient } from "./client";
import type { FileReadRole, FileReadUrl } from "../files/types";
import type {
  CommandStatusResponse,
  PublicShareResponse,
  ShareLinkResponse,
  UserShareResponse,
} from "./types";

export function createShareApi(client?: Pick<ApiClient, "request">) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    create(
      conversationId: string,
      expiresInDays?: number | null,
      confirmAttachmentPrivacy?: boolean,
    ): Promise<ShareLinkResponse> {
      return resolveClient().request<ShareLinkResponse>(
        `/conversations/${conversationId}/shares`,
        {
          method: "POST",
          body: {
            expires_in_days: expiresInDays ?? null,
            ...(confirmAttachmentPrivacy === undefined
              ? {}
              : { confirm_attachment_privacy: confirmAttachmentPrivacy }),
          },
        },
      );
    },
    list(conversationId: string): Promise<ShareLinkResponse[]> {
      return resolveClient().request<ShareLinkResponse[]>(
        `/conversations/${conversationId}/shares`,
      );
    },
    listMine(): Promise<UserShareResponse[]> {
      return resolveClient().request<UserShareResponse[]>("/shares");
    },
    revoke(conversationId: string, token: string): Promise<CommandStatusResponse> {
      return resolveClient().request<CommandStatusResponse>(
        `/conversations/${conversationId}/shares/${token}`,
        { method: "DELETE" },
      );
    },
    // Public read of a shared snapshot. No Authorization header: this is an
    // anonymous endpoint and a logged-in owner must not leak their token here.
    getPublic(token: string): Promise<PublicShareResponse> {
      return resolveClient().request<PublicShareResponse>(`/share/${token}`, {
        auth: false,
        retryOnUnauthorized: false,
      });
    },
    // Exchanges a share-scoped attachment ref for a short-lived signed URL.
    // Anonymous like getPublic: the share token is the whole capability.
    readAttachment(
      token: string,
      ref: string,
      role: FileReadRole,
    ): Promise<FileReadUrl> {
      return resolveClient().request<FileReadUrl>(
        `/share/${token}/attachments/${encodeURIComponent(ref)}/read-url`,
        {
          method: "POST",
          body: { role },
          auth: false,
          retryOnUnauthorized: false,
        },
      );
    },
  };
}

export type ShareApi = ReturnType<typeof createShareApi>;

export const shareApi = createShareApi();

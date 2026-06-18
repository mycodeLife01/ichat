import { getDefaultApiClient, type ApiClient } from "./client";
import type {
  CommandStatusResponse,
  PublicShareResponse,
  ShareLinkResponse,
} from "./types";

export function createShareApi(client?: Pick<ApiClient, "request">) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    create(conversationId: string, expiresInDays?: number | null): Promise<ShareLinkResponse> {
      return resolveClient().request<ShareLinkResponse>(
        `/conversations/${conversationId}/shares`,
        {
          method: "POST",
          body: { expires_in_days: expiresInDays ?? null },
        },
      );
    },
    list(conversationId: string): Promise<ShareLinkResponse[]> {
      return resolveClient().request<ShareLinkResponse[]>(
        `/conversations/${conversationId}/shares`,
      );
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
  };
}

export type ShareApi = ReturnType<typeof createShareApi>;

export const shareApi = createShareApi();

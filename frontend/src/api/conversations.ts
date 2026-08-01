import { getDefaultApiClient, type ApiClient } from "./client";
import type { RunOptionsRequest } from "../runs/thinkingLevel";
import type {
  CommandStatusResponse,
  ConversationCreateWithMessageResponse,
  ConversationDetailResponse,
  ConversationResponse,
  SendMessageResponse,
} from "./types";

export type ConversationListParams = {
  limit?: number;
  skip?: number;
};

export type ConversationDeletionResponse = CommandStatusResponse & {
  deletion_due_at?: string | null;
};

export function createConversationApi(client?: Pick<ApiClient, "request">) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    list(params?: ConversationListParams): Promise<ConversationResponse[]> {
      if (params === undefined) {
        return resolveClient().request<ConversationResponse[]>("/conversations");
      }
      return resolveClient().request<ConversationResponse[]>("/conversations", {
        query: params,
      });
    },
    create(title?: string): Promise<ConversationResponse> {
      return resolveClient().request<ConversationResponse>("/conversations", {
        method: "POST",
        body: { title: title ?? null },
      });
    },
    createWithMessage(
      content: string,
      options?: RunOptionsRequest,
      title?: string,
      attachmentIds?: string[],
    ): Promise<ConversationCreateWithMessageResponse> {
      return resolveClient().request<ConversationCreateWithMessageResponse>(
        "/conversations/with-message",
        {
          method: "POST",
          body: {
            title: title ?? null,
            content,
            ...options,
            ...(attachmentIds === undefined ? {} : { attachment_ids: attachmentIds }),
          },
        },
      );
    },
    detail(conversationId: string): Promise<ConversationDetailResponse> {
      return resolveClient().request<ConversationDetailResponse>(
        `/conversations/${conversationId}`,
      );
    },
    rename(conversationId: string, title: string): Promise<ConversationResponse> {
      return resolveClient().request<ConversationResponse>(`/conversations/${conversationId}`, {
        method: "PATCH",
        body: { title },
      });
    },
    remove(conversationId: string): Promise<ConversationDeletionResponse> {
      return resolveClient().request<ConversationDeletionResponse>(
        `/conversations/${conversationId}`,
        { method: "DELETE" },
      );
    },
    listDeleted(): Promise<ConversationResponse[]> {
      return resolveClient().request<ConversationResponse[]>("/conversations/deleted");
    },
    restore(conversationId: string): Promise<ConversationResponse> {
      return resolveClient().request<ConversationResponse>(
        `/conversations/${conversationId}/restore`,
        { method: "POST" },
      );
    },
    sendMessage(
      conversationId: string,
      content: string,
      options?: RunOptionsRequest,
      attachmentIds?: string[],
    ): Promise<SendMessageResponse> {
      return resolveClient().request<SendMessageResponse>(
        `/conversations/${conversationId}/messages`,
        {
          method: "POST",
          body: {
            content,
            ...options,
            ...(attachmentIds === undefined ? {} : { attachment_ids: attachmentIds }),
          },
        },
      );
    },
    editAndRegenerate(
      conversationId: string,
      messageId: string,
      content: string,
      options?: RunOptionsRequest,
      attachmentIds?: string[],
    ): Promise<SendMessageResponse> {
      return resolveClient().request<SendMessageResponse>(
        `/conversations/${conversationId}/messages/${messageId}/edit-and-regenerate`,
        {
          method: "POST",
          body: {
            content,
            ...options,
            ...(attachmentIds === undefined ? {} : { attachment_ids: attachmentIds }),
          },
        },
      );
    },
    regenerate(
      conversationId: string,
      messageId: string,
      options?: RunOptionsRequest,
    ): Promise<SendMessageResponse> {
      return resolveClient().request<SendMessageResponse>(
        `/conversations/${conversationId}/messages/${messageId}/regenerate`,
        options === undefined
          ? { method: "POST" }
          : { method: "POST", body: options },
      );
    },
  };
}

export type ConversationApi = ReturnType<typeof createConversationApi>;

export const conversationApi = createConversationApi();

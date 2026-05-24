import { getDefaultApiClient, type ApiClient } from "./client";
import type {
  CommandStatusResponse,
  ConversationDetailResponse,
  ConversationResponse,
  SendMessageResponse,
} from "./types";

export function createConversationApi(client?: Pick<ApiClient, "request">) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    list(): Promise<ConversationResponse[]> {
      return resolveClient().request<ConversationResponse[]>("/conversations");
    },
    create(title?: string): Promise<ConversationResponse> {
      return resolveClient().request<ConversationResponse>("/conversations", {
        method: "POST",
        body: { title: title ?? null },
      });
    },
    detail(conversationId: number): Promise<ConversationDetailResponse> {
      return resolveClient().request<ConversationDetailResponse>(
        `/conversations/${conversationId}`,
      );
    },
    rename(conversationId: number, title: string): Promise<ConversationResponse> {
      return resolveClient().request<ConversationResponse>(`/conversations/${conversationId}`, {
        method: "PATCH",
        body: { title },
      });
    },
    remove(conversationId: number): Promise<CommandStatusResponse> {
      return resolveClient().request<CommandStatusResponse>(
        `/conversations/${conversationId}`,
        { method: "DELETE" },
      );
    },
    sendMessage(conversationId: number, content: string): Promise<SendMessageResponse> {
      return resolveClient().request<SendMessageResponse>(
        `/conversations/${conversationId}/messages`,
        { method: "POST", body: { content } },
      );
    },
    editAndRegenerate(
      conversationId: number,
      messageId: number,
      content: string,
    ): Promise<SendMessageResponse> {
      return resolveClient().request<SendMessageResponse>(
        `/conversations/${conversationId}/messages/${messageId}/edit-and-regenerate`,
        { method: "POST", body: { content } },
      );
    },
    regenerate(
      conversationId: number,
      messageId: number,
    ): Promise<SendMessageResponse> {
      return resolveClient().request<SendMessageResponse>(
        `/conversations/${conversationId}/messages/${messageId}/regenerate`,
        { method: "POST" },
      );
    },
  };
}

export const conversationApi = createConversationApi();

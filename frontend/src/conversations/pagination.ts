export const CONVERSATION_PAGE_SIZE = 30;

export function hasMoreConversationPages(receivedCount: number): boolean {
  return receivedCount === CONVERSATION_PAGE_SIZE;
}

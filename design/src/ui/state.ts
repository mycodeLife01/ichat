export type ConfirmDialogState = {
  kind: "deleteConversation";
  conversationId: string;
};

export type ShareDialogState = {
  conversationId: string;
};

export type ToastTone = "neutral" | "success" | "error" | "warning";
export type ToastHandler = (message: string, tone: ToastTone) => void;

// A monotonic id (not the message) keys the Toast component so that triggering
// the same message twice re-mounts and re-animates it.
export type ToastState = {
  id: number;
  message: string;
  tone: ToastTone;
} | null;

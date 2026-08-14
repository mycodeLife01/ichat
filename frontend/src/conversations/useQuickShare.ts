import { useCallback } from "react";

import { useAppActions } from "../app/context";

function shareUrl(token: string): string {
  return `${window.location.origin}/share/${token}`;
}

// Chat-page sharing has no dialog: the link is permanent, an already-active link
// is reused (the API allows at most one per conversation), and the URL lands on
// the clipboard with a single confirmation toast.
export function useQuickShare() {
  const { services, dispatch } = useAppActions();

  return useCallback(
    async (conversationId: string, hasAttachments: boolean) => {
      let token: string;
      try {
        const existing = await services.shareApi.list(conversationId);
        token =
          existing[0]?.token ??
          (
            await services.shareApi.create(
              conversationId,
              null,
              hasAttachments ? true : undefined,
            )
          ).token;
      } catch {
        dispatch({ type: "ui/showToast", message: "创建分享失败", tone: "error" });
        return;
      }

      try {
        if (!navigator.clipboard) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(shareUrl(token));
      } catch {
        dispatch({ type: "ui/showToast", message: "复制失败", tone: "error" });
        return;
      }
      dispatch({
        type: "ui/showToast",
        message: "公开链接已复制到剪贴板",
        tone: "success",
      });
    },
    [dispatch, services],
  );
}

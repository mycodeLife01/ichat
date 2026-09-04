import { useCallback } from "react";

import { useAppActions } from "../app/context";
import { copyText, startDeferredTextCopy } from "../ui/clipboard";

function shareUrl(token: string): string {
  return `${window.location.origin}/share/${token}`;
}

// Chat-page sharing has no dialog: the link is permanent, an already-active link
// is reused (the API allows at most one per conversation), and the URL lands on
// the clipboard with a single confirmation toast on both desktop and mobile.
export function useQuickShare() {
  const { services, dispatch } = useAppActions();

  return useCallback(
    async (conversationId: string, hasAttachments: boolean) => {
      const url = (async () => {
        const existing = await services.shareApi.list(conversationId);
        const token =
          existing[0]?.token ??
          (
            await services.shareApi.create(
              conversationId,
              null,
              hasAttachments ? true : undefined,
            )
          ).token;
        return shareUrl(token);
      })();
      // This must run before the first await. Safari/WebKit otherwise considers
      // the eventual clipboard call detached from the user's share tap.
      const deferredCopy = startDeferredTextCopy(url);

      let resolvedUrl: string;
      try {
        resolvedUrl = await url;
      } catch {
        dispatch({ type: "ui/showToast", message: "创建分享失败", tone: "error" });
        return;
      }

      const copied =
        (deferredCopy !== null && (await deferredCopy)) || (await copyText(resolvedUrl));
      if (!copied) {
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

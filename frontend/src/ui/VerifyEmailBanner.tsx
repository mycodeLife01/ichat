import { useState } from "react";

import { ApiError } from "../api/errors";
import { useAppActions } from "../app/context";
import { useAuthSession } from "../auth/useAuthSession";

// Persistent, non-blocking reminder shown in the authed shell while the current
// user's email is unverified. Does not gate any feature — only prompts.
export function VerifyEmailBanner() {
  const { user } = useAuthSession();
  const { services, dispatch } = useAppActions();
  const [sending, setSending] = useState(false);

  if (!user || user.email_verified) return null;

  const onResend = async () => {
    if (sending) return;
    setSending(true);
    try {
      await services.authApi.resendVerificationEmail();
      dispatch({ type: "ui/showToast", message: "验证邮件已发送，请检查邮箱。" });
    } catch (error) {
      const tooMany = error instanceof ApiError && error.status === 429;
      dispatch({
        type: "ui/showToast",
        message: tooMany ? "请稍后再试" : "发送失败，请稍后重试",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-bg-raised px-4 py-2 text-[13px] text-fg-muted">
      <span>请验证你的邮箱，确保账号安全。</span>
      <span className="text-fg-subtle">{user.email}</span>
      <button
        type="button"
        onClick={() => void onResend()}
        disabled={sending}
        className="ml-auto rounded-md border border-border bg-bg px-2.5 py-1 text-[12.5px] font-medium text-fg transition-[background,border-color] duration-[120ms] hover:border-border-strong disabled:opacity-60"
      >
        {sending ? "发送中…" : "重新发送验证邮件"}
      </button>
    </div>
  );
}

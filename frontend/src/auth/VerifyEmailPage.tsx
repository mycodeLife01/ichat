import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { ApiError } from "../api/errors";
import { useAppActions } from "../app/context";
import { Wordmark } from "../ui/Wordmark";
import { useAuthSession } from "./useAuthSession";

type Status = "loading" | "success" | "error";
type ResendStatus = "idle" | "sending" | "sent" | "error";

// Public page (outside AuthGate): a logged-out user clicking the email link must
// still be able to verify. On success, if a session exists we refresh the user
// mirror so the unverified banner disappears.
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const { services } = useAppActions();
  const { isAuthenticated, user, refreshUser } = useAuthSession();
  const [status, setStatus] = useState<Status>("loading");
  const [resend, setResend] = useState<ResendStatus>("idle");

  useEffect(() => {
    let active = true;
    if (!token) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    void (async () => {
      try {
        await services.authApi.verifyEmail(token);
        if (isAuthenticated) {
          try {
            await refreshUser();
          } catch {
            // Verification already succeeded; a failed mirror refresh is fine.
          }
        }
        if (active) setStatus("success");
      } catch (error) {
        if (!(error instanceof ApiError)) {
          if (active) setStatus("error");
          throw error;
        }
        // Friendly idempotency: the public endpoint returns a generic failure
        // even when the email was already verified. If we have a session, ask
        // /me and treat an already-verified account as success.
        if (isAuthenticated) {
          try {
            const refreshed = await refreshUser();
            if (refreshed.email_verified) {
              if (active) setStatus("success");
              return;
            }
          } catch {
            // fall through to generic failure
          }
        }
        if (active) setStatus("error");
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, services]);

  const onResend = async () => {
    if (resend === "sending") return;
    setResend("sending");
    try {
      await services.authApi.resendVerificationEmail();
      setResend("sent");
    } catch {
      setResend("error");
    }
  };

  const showResend = isAuthenticated && user != null && !user.email_verified;

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-[52px] shrink-0 items-center border-b border-border bg-bg">
        <div className="mx-auto flex w-full max-w-[var(--reading-width)] items-center px-8 max-[760px]:px-[18px]">
          <Link to="/" className="flex items-center" aria-label="iChat 首页">
            <Wordmark size={18} />
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[var(--reading-width)] px-8 pt-16 text-center max-[760px]:px-[18px]">
        {status === "loading" && (
          <p className="text-[14px] text-fg-subtle">验证中…</p>
        )}

        {status === "success" && (
          <>
            <h1 className="mb-2 text-lg font-medium text-fg">邮箱验证成功</h1>
            <p className="text-[14px] leading-[1.6] text-fg-muted">
              你的邮箱已验证，账号更安全了。
            </p>
            <Link
              to="/"
              className="mt-5 inline-block rounded-md bg-accent px-3.5 py-2 text-[13.5px] font-medium text-accent-fg transition-opacity duration-[120ms] hover:opacity-90"
            >
              返回 iChat
            </Link>
          </>
        )}

        {status === "error" && (
          <>
            <h1 className="mb-2 text-lg font-medium text-fg">验证链接已失效或不可用</h1>
            <p className="text-[14px] leading-[1.6] text-fg-muted">
              该验证链接可能已过期、已被使用，或不正确。
            </p>
            {showResend ? (
              <div className="mt-5 flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onResend()}
                  disabled={resend === "sending"}
                  className="rounded-md bg-accent px-3.5 py-2 text-[13.5px] font-medium text-accent-fg transition-opacity duration-[120ms] hover:opacity-90 disabled:opacity-60"
                >
                  {resend === "sending" ? "发送中…" : "重新发送验证邮件"}
                </button>
                {resend === "sent" && (
                  <span className="text-[13px] text-fg-subtle">
                    验证邮件已发送，请检查邮箱。
                  </span>
                )}
                {resend === "error" && (
                  <span className="text-[13px] text-fg-subtle">发送失败，请稍后再试。</span>
                )}
              </div>
            ) : (
              <Link
                to="/"
                className="mt-5 inline-block rounded-md bg-accent px-3.5 py-2 text-[13.5px] font-medium text-accent-fg transition-opacity duration-[120ms] hover:opacity-90"
              >
                前往 iChat
              </Link>
            )}
          </>
        )}
      </div>
    </div>
  );
}

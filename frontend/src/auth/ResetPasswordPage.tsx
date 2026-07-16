import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { toApiError } from "../api/errors";
import { useAppActions } from "../app/context";
import { Wordmark } from "../ui/Wordmark";

type Status = "form" | "success";

const field = "mb-3.5 flex flex-col gap-1.5";
const fieldLabel = "text-[12.5px] font-medium text-fg-muted";
const fieldInput =
  "rounded-[10px] border border-border-strong bg-bg px-3.5 py-[11px] text-[14.5px] text-fg " +
  "outline-none transition-[border-color] duration-[140ms] placeholder:text-fg-faint " +
  "focus:border-fg-subtle focus-visible:outline-none";
const fieldErr = "mt-0.5 text-xs text-danger";

// Public page (outside AuthGate): the reset link in the email points here with a
// `?token=` param, so a logged-out visitor must be able to set a new password.
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const { services } = useAppActions();
  const [status, setStatus] = useState<Status>("form");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formMessage, setFormMessage] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !token) return;

    const errors: { password?: string; confirm?: string } = {};
    if (password.length < 8 || password.length > 128) {
      errors.password = "密码长度需为 8–128 位";
    }
    if (confirm !== password) {
      errors.confirm = "两次输入的密码不一致";
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setFormMessage(undefined);
      return;
    }

    setFieldErrors({});
    setFormMessage(undefined);
    setSubmitting(true);
    try {
      await services.authApi.resetPassword(token, password);
      setStatus("success");
    } catch (error) {
      const apiError = toApiError(error);
      // A bad/expired token comes back as 400 (or 422 for a malformed one); show
      // the same friendly hint and route the user back to request a fresh link.
      setFormMessage(
        apiError.status === 400 || apiError.status === 422
          ? "重置链接无效或已过期，请重新申请。"
          : apiError.message,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex h-full flex-col bg-bg">
      <header className="flex h-[52px] shrink-0 items-center border-b border-border px-6">
        <Link to="/" aria-label="iChat 首页">
          <Wordmark size={18} />
        </Link>
      </header>

      <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center px-6">
        {!token ? (
          <div className="text-center">
            <h1 className="text-xl font-semibold text-fg">重置链接无效</h1>
            <p className="mt-3 text-[13px] leading-6 text-fg-muted">
              链接缺少必要的参数，可能已损坏。请重新申请重置密码。
            </p>
            <Link
              to="/"
              className="mt-6 inline-block rounded-full bg-accent px-5 py-2.5 text-[13px] font-medium text-accent-fg transition-opacity duration-[120ms] hover:opacity-90"
            >
              返回登录
            </Link>
          </div>
        ) : status === "success" ? (
          <div className="text-center">
            <h1 className="text-xl font-semibold text-fg">密码已重置</h1>
            <p className="mt-3 text-[13px] leading-6 text-fg-muted">
              你的密码已更新，所有设备上的登录状态已失效。请使用新密码重新登录。
            </p>
            <Link
              to="/"
              className="mt-6 inline-block rounded-full bg-accent px-5 py-2.5 text-[13px] font-medium text-accent-fg transition-opacity duration-[120ms] hover:opacity-90"
            >
              返回登录
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-[26px]">
              <h1 className="text-xl font-semibold tracking-[-0.01em] text-fg">设置新密码</h1>
              <p className="mt-2.5 mb-0 text-[13px] leading-[1.55] text-fg-muted">
                请输入并确认你的新密码。
              </p>
            </div>

            <form className="flex flex-col" onSubmit={handleSubmit} noValidate>
              <div className={field}>
                <label className={fieldLabel} htmlFor="reset-password">
                  新密码
                </label>
                <input
                  id="reset-password"
                  className={fieldInput}
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="至少 8 位"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {fieldErrors.password ? (
                  <div className={fieldErr}>{fieldErrors.password}</div>
                ) : null}
              </div>

              <div className={field}>
                <label className={fieldLabel} htmlFor="reset-confirm">
                  确认新密码
                </label>
                <input
                  id="reset-confirm"
                  className={fieldInput}
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
                {fieldErrors.confirm ? (
                  <div className={fieldErr}>{fieldErrors.confirm}</div>
                ) : null}
              </div>

              {formMessage ? (
                <p
                  className="mt-0.5 mb-0 rounded-lg bg-danger-soft px-3 py-[9px] text-[12.5px] text-danger"
                  role="alert"
                >
                  {formMessage}
                </p>
              ) : null}

              <button
                type="submit"
                className="mt-2 w-full cursor-pointer rounded-[10px] border-none bg-accent p-3 text-sm font-medium text-accent-fg transition-[opacity_120ms,transform_80ms] hover:opacity-[0.92] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
                disabled={submitting}
              >
                {submitting ? "提交中…" : "重置密码"}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

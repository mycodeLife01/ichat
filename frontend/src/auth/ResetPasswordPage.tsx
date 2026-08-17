import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { toApiError } from "../api/errors";
import { useAppActions } from "../app/context";
import {
  controlText,
  formHelp,
  primaryButton,
  surfaceTitle,
} from "../ui/classes";
import { InlineStatus } from "../ui/InlineStatus";
import { LoadingButtonContent } from "../ui/LoadingButtonContent";
import { Wordmark } from "../ui/Wordmark";
import { authCtaLink, authField, authFieldInput, authFieldLabel, AuthFieldError } from "./authFields";

type Status = "form" | "success";

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
    <main className="flex h-full flex-col bg-bg font-ui text-type-primary">
      <header className="flex h-[52px] shrink-0 items-center border-b border-border px-6">
        <Link to="/" className="flex min-h-11 items-center" aria-label="iChat 首页">
          <Wordmark size={18} />
        </Link>
      </header>

      <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center px-6">
        {!token ? (
          <div className="text-center">
            <h1 className={surfaceTitle}>重置链接无效</h1>
            <InlineStatus tone="warning" className="mt-4 text-left">
              链接缺少必要的参数，可能已损坏。请重新申请重置密码。
            </InlineStatus>
            <Link to="/" className={`${authCtaLink} mt-6`}>
              返回登录
            </Link>
          </div>
        ) : status === "success" ? (
          <div className="text-center">
            <h1 className={surfaceTitle}>密码已重置</h1>
            <InlineStatus tone="success" className="mt-4 text-left">
              你的密码已更新，所有设备上的登录状态已失效。请使用新密码重新登录。
            </InlineStatus>
            <Link to="/" className={`${authCtaLink} mt-6`}>
              返回登录
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-[26px]">
              <h1 className={surfaceTitle}>设置新密码</h1>
              <p className={`mt-2.5 mb-0 ${formHelp}`}>
                请输入并确认你的新密码。
              </p>
            </div>

            <form className="flex flex-col" onSubmit={handleSubmit} noValidate>
              <div className={authField}>
                <label className={authFieldLabel} htmlFor="reset-password">
                  新密码
                </label>
                <input
                  id="reset-password"
                  className={authFieldInput}
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="至少 8 位"
                  value={password}
                  aria-invalid={fieldErrors.password != null}
                  aria-describedby={fieldErrors.password ? "reset-password-error" : undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <AuthFieldError id="reset-password-error" message={fieldErrors.password} />
              </div>

              <div className={authField}>
                <label className={authFieldLabel} htmlFor="reset-confirm">
                  确认新密码
                </label>
                <input
                  id="reset-confirm"
                  className={authFieldInput}
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  aria-invalid={fieldErrors.confirm != null}
                  aria-describedby={fieldErrors.confirm ? "reset-confirm-error" : undefined}
                  onChange={(event) => setConfirm(event.target.value)}
                />
                <AuthFieldError id="reset-confirm-error" message={fieldErrors.confirm} />
              </div>

              {formMessage ? (
                <InlineStatus tone="error" className="mt-0.5">
                  {formMessage}
                </InlineStatus>
              ) : null}

              <button
                type="submit"
                className={`${primaryButton} mt-2 h-11 w-full ${controlText} !font-medium !text-accent-foreground disabled:!text-type-disabled`}
                disabled={submitting}
                aria-busy={submitting}
                aria-label={submitting ? "正在重置密码" : "重置密码"}
              >
                <LoadingButtonContent loading={submitting} label="重置密码" />
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

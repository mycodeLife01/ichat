import { useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { toApiError } from "../api/errors";
import { useAppActions } from "../app/context";
import { AuthBackground } from "./AuthBackground";
import { mapAuthError, type AuthFieldErrors, type AuthMode } from "./authErrorMessages";
import { useAuthSession } from "./useAuthSession";

// "forgot" is the password-reset request sub-view; it sits alongside the
// login/register tabs but hides them and drives its own submit.
type ScreenMode = AuthMode | "forgot";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const authTab =
  "relative mr-6 cursor-pointer border-none bg-transparent py-2.5 text-sm font-medium";
const authTabActive =
  " text-fg after:absolute after:right-0 after:-bottom-px after:left-0 after:h-[1.5px] after:bg-fg after:content-['']";

const field = "mb-3.5 flex flex-col gap-1.5";
const fieldLabel = "text-[12.5px] font-medium text-fg-muted";
// Clean focus: a single thin gray border, no ring/outline/background change
// (overrides the global :focus-visible accent outline).
const fieldInput =
  "rounded-[10px] border border-border-strong bg-bg px-3.5 py-[11px] text-[14.5px] text-fg " +
  "outline-none transition-[border-color] duration-[140ms] placeholder:text-fg-faint " +
  "focus:border-fg-subtle focus-visible:outline-none";
const fieldErr = "mt-0.5 text-xs text-danger";

const authFootBtn =
  "ml-1 cursor-pointer border-none bg-transparent p-0 font-[inherit] text-fg underline " +
  "decoration-border-strong underline-offset-2 hover:decoration-fg";

export function AuthScreen() {
  const { login, register, isSubmitting } = useAuthSession();
  const { services } = useAppActions();
  const [mode, setMode] = useState<ScreenMode>("login");
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [formMessage, setFormMessage] = useState<string | undefined>(undefined);
  const cardRef = useRef<HTMLElement>(null);
  const animationStartHeightRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const fromHeight = animationStartHeightRef.current;
    animationStartHeightRef.current = null;

    if (!card || fromHeight === null) return;

    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || typeof card.animate !== "function") return;

    const toHeight = card.getBoundingClientRect().height;
    if (Math.abs(fromHeight - toHeight) < 1) return;

    const animation = card.animate(
      [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
      {
        duration: 320,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    );

    return () => animation.cancel();
  }, [mode]);

  function switchMode(next: ScreenMode) {
    if (next === mode) return;
    animationStartHeightRef.current = cardRef.current?.getBoundingClientRect().height ?? null;
    setMode(next);
    setFieldErrors({});
    setFormMessage(undefined);
    setResetSent(false);
  }

  function validate(): AuthFieldErrors {
    const errors: AuthFieldErrors = {};
    if (mode === "register") {
      const name = username.trim();
      if (name.length < 1 || name.length > 50) {
        errors.username = "请输入 1–50 个字符的用户名";
      }
      if (nickname.trim().length > 50) {
        errors.nickname = "昵称长度不能超过 50 个字符";
      }
      if (!EMAIL_PATTERN.test(email.trim())) {
        errors.email = "请输入有效的邮箱地址";
      }
    } else if (identifier.trim().length < 1) {
      errors.identifier = "请输入用户名或邮箱";
    }
    if (password.length < 8 || password.length > 128) {
      errors.password = "密码长度需为 8–128 位";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setFormMessage(undefined);
      return;
    }

    setFieldErrors({});
    setFormMessage(undefined);

    try {
      if (mode === "register") {
        const normalizedUsername = username.trim();
        await register({
          username: normalizedUsername,
          nickname: nickname.trim() || normalizedUsername,
          email: email.trim(),
          password,
        });
      } else {
        await login({ identifier: identifier.trim(), password });
      }
    } catch (error) {
      // handleSubmit only runs for the login/register form; forgot has its own.
      const view = mapAuthError(error, mode === "register" ? "register" : "login");
      setFieldErrors(view.fieldErrors ?? {});
      setFormMessage(view.formMessage);
    }
  }

  async function handleResetRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (resetSubmitting) return;

    const normalizedEmail = resetEmail.trim();
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      setFieldErrors({ email: "请输入有效的邮箱地址" });
      setFormMessage(undefined);
      return;
    }

    setFieldErrors({});
    setFormMessage(undefined);
    setResetSubmitting(true);
    try {
      // Anti-enumeration: the endpoint returns success for any address, so a
      // valid and an unknown email both land here and show the same notice.
      await services.authApi.requestPasswordReset(normalizedEmail);
      setResetSent(true);
    } catch (error) {
      setFormMessage(toApiError(error).message);
    } finally {
      setResetSubmitting(false);
    }
  }

  const submitLabel = isSubmitting
    ? mode === "register"
      ? "注册中…"
      : "登录中…"
    : mode === "register"
      ? "注册"
      : "登录";

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg px-6 py-8 font-sans text-fg">
      <AuthBackground />

      <section
        ref={cardRef}
        className="relative z-[1] w-full max-w-[420px] overflow-hidden rounded-[18px] border border-border bg-bg-raised px-9 pt-9 pb-7 shadow-[0_1px_0_rgb(255_255_255/90%)_inset,0_2px_6px_rgb(20_20_19/4%),0_24px_64px_rgb(20_20_19/8%)] max-[480px]:rounded-2xl max-[480px]:px-6 max-[480px]:pt-7 max-[480px]:pb-[22px]"
      >
        <div className="mb-[26px] flex flex-col items-start">
          <span className="font-sans text-[22px] font-semibold tracking-[-0.02em] text-fg">
            iChat
          </span>
          <p className="mt-2.5 mb-0 text-[13px] leading-[1.55] text-fg-muted">
            {mode === "login"
              ? "欢迎回来。"
              : mode === "register"
                ? "创建你的账号，开始安静地思考。"
                : "输入你的注册邮箱，我们会发送重置链接。"}
          </p>
        </div>

        {mode === "forgot" ? null : (
          <div className="mb-[22px] flex gap-0.5 border-b border-border" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              className={`${authTab}${mode === "login" ? authTabActive : " text-fg-subtle"}`}
              onClick={() => switchMode("login")}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              className={`${authTab}${mode === "register" ? authTabActive : " text-fg-subtle"}`}
              onClick={() => switchMode("register")}
            >
              注册
            </button>
          </div>
        )}

        {mode === "forgot" ? (
          resetSent ? (
            <div className="flex flex-col">
              <p
                className="mt-0.5 mb-0 rounded-lg bg-bg px-3 py-[9px] text-[12.5px] leading-[1.55] text-fg-muted"
                role="status"
              >
                我们已发送一封包含重置链接的邮件。请查收邮箱（含垃圾邮件文件夹），并在
                30 分钟内使用该链接。
              </p>
            </div>
          ) : (
            <form className="flex flex-col" onSubmit={handleResetRequest} noValidate>
              <div className={field}>
                <label className={fieldLabel} htmlFor="auth-reset-email">
                  邮箱
                </label>
                <input
                  id="auth-reset-email"
                  className={fieldInput}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={resetEmail}
                  onChange={(event) => setResetEmail(event.target.value)}
                />
                {fieldErrors.email ? <div className={fieldErr}>{fieldErrors.email}</div> : null}
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
                disabled={resetSubmitting}
              >
                {resetSubmitting ? "发送中…" : "发送重置链接"}
              </button>
            </form>
          )
        ) : (
          <form className="flex flex-col" onSubmit={handleSubmit} noValidate>
          {mode === "register" ? (
            <>
              <div className={field}>
                <label className={fieldLabel} htmlFor="auth-username">
                  用户名
                </label>
                <input
                  id="auth-username"
                  className={fieldInput}
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
                {fieldErrors.username ? (
                  <div className={fieldErr}>{fieldErrors.username}</div>
                ) : null}
              </div>
              <div className={field}>
                <label className={fieldLabel} htmlFor="auth-nickname">
                  昵称（可选）
                </label>
                <input
                  id="auth-nickname"
                  className={fieldInput}
                  name="nickname"
                  autoComplete="nickname"
                  placeholder="默认与用户名相同"
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                />
                {fieldErrors.nickname ? (
                  <div className={fieldErr}>{fieldErrors.nickname}</div>
                ) : null}
              </div>
              <div className={field}>
                <label className={fieldLabel} htmlFor="auth-email">
                  邮箱
                </label>
                <input
                  id="auth-email"
                  className={fieldInput}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {fieldErrors.email ? <div className={fieldErr}>{fieldErrors.email}</div> : null}
              </div>
            </>
          ) : (
            <div className={field}>
              <label className={fieldLabel} htmlFor="auth-identifier">
                用户名或邮箱
              </label>
              <input
                id="auth-identifier"
                className={fieldInput}
                name="identifier"
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
              />
              {fieldErrors.identifier ? (
                <div className={fieldErr}>{fieldErrors.identifier}</div>
              ) : null}
            </div>
          )}

          <div className={field}>
            <label className={fieldLabel} htmlFor="auth-password">
              密码
            </label>
            <input
              id="auth-password"
              className={fieldInput}
              name="password"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              placeholder={mode === "register" ? "至少 8 位" : ""}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {fieldErrors.password ? <div className={fieldErr}>{fieldErrors.password}</div> : null}
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
            disabled={isSubmitting}
          >
            {submitLabel}
          </button>
          </form>
        )}

        <div className="mt-[18px] mb-4 flex items-center gap-2.5 font-mono text-[11px] tracking-[0.12em] text-fg-subtle uppercase before:h-px before:flex-1 before:bg-border before:content-[''] after:h-px after:flex-1 after:bg-border after:content-['']">
          或
        </div>

        <div className="mt-4 text-center text-[12.5px] text-fg-subtle">
          {mode === "login" ? (
            <>
              还没有账号？
              <button type="button" className={authFootBtn} onClick={() => switchMode("register")}>
                立即注册
              </button>
              <div className="mt-2">
                <button
                  type="button"
                  className={authFootBtn}
                  onClick={() => switchMode("forgot")}
                >
                  忘记密码？
                </button>
              </div>
            </>
          ) : mode === "forgot" ? (
            <>

              <button type="button" className={authFootBtn} onClick={() => switchMode("login")}>
                返回登录
              </button>
            </>
          ) : (
            <>
              已有账号？
              <button type="button" className={authFootBtn} onClick={() => switchMode("login")}>
                返回登录
              </button>
            </>
          )}
        </div>
      </section>

      <p className="absolute right-0 bottom-6 left-0 z-[1] m-0 text-center font-mono text-[11px] tracking-[0.04em] text-fg-subtle">
        登录即代表你同意服务条款与隐私政策
      </p>
    </main>
  );
}

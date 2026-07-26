import { useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { toApiError } from "../api/errors";
import { useAppActions } from "../app/context";
import { dialogSurface, primaryButton } from "../ui/classes";
import { InlineStatus } from "../ui/InlineStatus";
import { LoadingButtonContent } from "../ui/LoadingButtonContent";
import { AuthBackground } from "./AuthBackground";
import { authField, authFieldInput, authFieldLabel, AuthFieldError } from "./authFields";
import { mapAuthError, type AuthFieldErrors, type AuthMode } from "./authErrorMessages";
import { useAuthSession } from "./useAuthSession";

// "forgot" is the password-reset request sub-view; it sits alongside the
// login/register tabs but hides them and drives its own submit.
type ScreenMode = AuthMode | "forgot";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const authTab =
  "relative mr-6 min-h-11 cursor-pointer border-none bg-transparent py-2.5 text-sm font-medium";
const authTabActive =
  " text-fg after:absolute after:right-0 after:-bottom-px after:left-0 after:h-[1.5px] after:bg-fg after:content-['']";

const submitButton = `${primaryButton} mt-2 h-11 w-full text-sm font-medium`;

const authFootBtn =
  "ml-1 inline-flex min-h-11 cursor-pointer items-center border-none bg-transparent p-0 " +
  "font-[inherit] text-fg underline decoration-border-strong underline-offset-2 hover:decoration-fg";

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

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg px-6 py-8 font-sans text-fg">
      <AuthBackground />

      <section
        ref={cardRef}
        className={`${dialogSurface} relative z-[1] w-full max-w-[420px] overflow-hidden px-9 pt-9 pb-7 max-[480px]:px-6 max-[480px]:pt-7 max-[480px]:pb-[22px]`}
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
            <InlineStatus tone="success" className="mt-0.5">
              我们已发送一封包含重置链接的邮件。请查收邮箱（含垃圾邮件文件夹），并在
              30 分钟内使用该链接。
            </InlineStatus>
          ) : (
            <form className="flex flex-col" onSubmit={handleResetRequest} noValidate>
              <div className={authField}>
                <label className={authFieldLabel} htmlFor="auth-reset-email">
                  邮箱
                </label>
                <input
                  id="auth-reset-email"
                  className={authFieldInput}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={resetEmail}
                  aria-invalid={fieldErrors.email != null}
                  aria-describedby={fieldErrors.email ? "auth-reset-email-error" : undefined}
                  onChange={(event) => setResetEmail(event.target.value)}
                />
                <AuthFieldError id="auth-reset-email-error" message={fieldErrors.email} />
              </div>

              {formMessage ? (
                <InlineStatus tone="error" className="mt-0.5">
                  {formMessage}
                </InlineStatus>
              ) : null}

              <button
                type="submit"
                className={submitButton}
                disabled={resetSubmitting}
                aria-busy={resetSubmitting}
                aria-label={resetSubmitting ? "正在发送重置链接" : "发送重置链接"}
              >
                <LoadingButtonContent loading={resetSubmitting} label="发送重置链接" />
              </button>
            </form>
          )
        ) : (
          <form className="flex flex-col" onSubmit={handleSubmit} noValidate>
          {mode === "register" ? (
            <>
              <div className={authField}>
                <label className={authFieldLabel} htmlFor="auth-username">
                  用户名
                </label>
                <input
                  id="auth-username"
                  className={authFieldInput}
                  name="username"
                  autoComplete="username"
                  value={username}
                  aria-invalid={fieldErrors.username != null}
                  aria-describedby={fieldErrors.username ? "auth-username-error" : undefined}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <AuthFieldError id="auth-username-error" message={fieldErrors.username} />
              </div>
              <div className={authField}>
                <label className={authFieldLabel} htmlFor="auth-nickname">
                  昵称（可选）
                </label>
                <input
                  id="auth-nickname"
                  className={authFieldInput}
                  name="nickname"
                  autoComplete="nickname"
                  placeholder="默认与用户名相同"
                  value={nickname}
                  aria-invalid={fieldErrors.nickname != null}
                  aria-describedby={fieldErrors.nickname ? "auth-nickname-error" : undefined}
                  onChange={(event) => setNickname(event.target.value)}
                />
                <AuthFieldError id="auth-nickname-error" message={fieldErrors.nickname} />
              </div>
              <div className={authField}>
                <label className={authFieldLabel} htmlFor="auth-email">
                  邮箱
                </label>
                <input
                  id="auth-email"
                  className={authFieldInput}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  aria-invalid={fieldErrors.email != null}
                  aria-describedby={fieldErrors.email ? "auth-email-error" : undefined}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <AuthFieldError id="auth-email-error" message={fieldErrors.email} />
              </div>
            </>
          ) : (
            <div className={authField}>
              <label className={authFieldLabel} htmlFor="auth-identifier">
                用户名或邮箱
              </label>
              <input
                id="auth-identifier"
                className={authFieldInput}
                name="identifier"
                autoComplete="username"
                value={identifier}
                aria-invalid={fieldErrors.identifier != null}
                aria-describedby={fieldErrors.identifier ? "auth-identifier-error" : undefined}
                onChange={(event) => setIdentifier(event.target.value)}
              />
              <AuthFieldError id="auth-identifier-error" message={fieldErrors.identifier} />
            </div>
          )}

          <div className={authField}>
            <label className={authFieldLabel} htmlFor="auth-password">
              密码
            </label>
            <input
              id="auth-password"
              className={authFieldInput}
              name="password"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              placeholder={mode === "register" ? "至少 8 位" : ""}
              value={password}
              aria-invalid={fieldErrors.password != null}
              aria-describedby={fieldErrors.password ? "auth-password-error" : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            <AuthFieldError id="auth-password-error" message={fieldErrors.password} />
          </div>

          {formMessage ? (
            <InlineStatus tone="error" className="mt-0.5">
              {formMessage}
            </InlineStatus>
          ) : null}

          <button
            type="submit"
            className={submitButton}
            disabled={isSubmitting}
            aria-busy={isSubmitting}
            aria-label={
              isSubmitting
                ? mode === "register"
                  ? "正在注册"
                  : "正在登录"
                : mode === "register"
                  ? "注册"
                  : "登录"
            }
          >
            <LoadingButtonContent
              loading={isSubmitting}
              label={mode === "register" ? "注册" : "登录"}
            />
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

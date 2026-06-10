import { useState, type FormEvent } from "react";

import { AuthBackground } from "./AuthBackground";
import { mapAuthError, type AuthFieldErrors, type AuthMode } from "./authErrorMessages";
import { useAuthSession } from "./useAuthSession";
import "./AuthScreen.css";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AuthScreen() {
  const { login, register, isSubmitting } = useAuthSession();
  const [mode, setMode] = useState<AuthMode>("login");
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [formMessage, setFormMessage] = useState<string | undefined>(undefined);

  function switchMode(next: AuthMode) {
    if (next === mode) return;
    setMode(next);
    setFieldErrors({});
    setFormMessage(undefined);
  }

  function validate(): AuthFieldErrors {
    const errors: AuthFieldErrors = {};
    if (mode === "register") {
      const name = username.trim();
      if (name.length < 1 || name.length > 50) {
        errors.username = "请输入 1–50 个字符的用户名";
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
        await register({ username: username.trim(), email: email.trim(), password });
      } else {
        await login({ identifier: identifier.trim(), password });
      }
    } catch (error) {
      const view = mapAuthError(error, mode);
      setFieldErrors(view.fieldErrors ?? {});
      setFormMessage(view.formMessage);
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
    <main className="auth-shell">
      <AuthBackground />

      <section className="auth-card">
        <div className="auth-brand">
          <span className="wordmark">iChat</span>
          <p className="auth-tag">
            {mode === "login" ? "欢迎回来。" : "创建你的账号，开始安静地思考。"}
          </p>
        </div>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={mode === "login" ? "auth-tab active" : "auth-tab"}
            onClick={() => switchMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={mode === "register" ? "auth-tab active" : "auth-tab"}
            onClick={() => switchMode("register")}
          >
            注册
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          {/* Register-only fields. Kept mounted and collapsed (not unmounted) so
              the card height animates when switching tabs. */}
          <div
            className={mode === "register" ? "auth-collapse open" : "auth-collapse"}
            aria-hidden={mode !== "register"}
          >
            <div className="auth-collapse-inner">
              <div className="field">
                <label htmlFor="auth-username">用户名</label>
                <input
                  id="auth-username"
                  name="username"
                  autoComplete="username"
                  tabIndex={mode === "register" ? 0 : -1}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
                {fieldErrors.username ? (
                  <div className="err">{fieldErrors.username}</div>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="auth-email">邮箱</label>
                <input
                  id="auth-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  tabIndex={mode === "register" ? 0 : -1}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {fieldErrors.email ? <div className="err">{fieldErrors.email}</div> : null}
              </div>
            </div>
          </div>

          {/* Login-only field. */}
          <div
            className={mode === "login" ? "auth-collapse open" : "auth-collapse"}
            aria-hidden={mode !== "login"}
          >
            <div className="auth-collapse-inner">
              <div className="field">
                <label htmlFor="auth-identifier">用户名或邮箱</label>
                <input
                  id="auth-identifier"
                  name="identifier"
                  autoComplete="username"
                  tabIndex={mode === "login" ? 0 : -1}
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                />
                {fieldErrors.identifier ? (
                  <div className="err">{fieldErrors.identifier}</div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="field">
            <label htmlFor="auth-password">密码</label>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              placeholder={mode === "register" ? "至少 8 位" : ""}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {fieldErrors.password ? <div className="err">{fieldErrors.password}</div> : null}
          </div>

          {formMessage ? (
            <p className="auth-form-error" role="alert">
              {formMessage}
            </p>
          ) : null}

          <button type="submit" className="auth-submit" disabled={isSubmitting}>
            {submitLabel}
          </button>
        </form>

        <div className="auth-divider">或</div>

        <div className="auth-foot">
          {mode === "login" ? (
            <>
              还没有账号？
              <button type="button" onClick={() => switchMode("register")}>
                立即注册
              </button>
            </>
          ) : (
            <>
              已有账号？
              <button type="button" onClick={() => switchMode("login")}>
                返回登录
              </button>
            </>
          )}
        </div>
      </section>

      <p className="auth-meta">登录即代表你同意服务条款与隐私政策</p>
    </main>
  );
}

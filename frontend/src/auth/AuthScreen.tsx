import { useState, type FormEvent } from "react";

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
      <section className="auth-card">
        <h1 className="auth-title">iChat</h1>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={mode === "login" ? "auth-tab auth-tab--active" : "auth-tab"}
            onClick={() => switchMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={mode === "register" ? "auth-tab auth-tab--active" : "auth-tab"}
            onClick={() => switchMode("register")}
          >
            注册
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          {mode === "register" ? (
            <>
              <div className="auth-field">
                <label htmlFor="auth-username">用户名</label>
                <input
                  id="auth-username"
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
                {fieldErrors.username ? (
                  <span className="auth-field-error">{fieldErrors.username}</span>
                ) : null}
              </div>
              <div className="auth-field">
                <label htmlFor="auth-email">邮箱</label>
                <input
                  id="auth-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {fieldErrors.email ? (
                  <span className="auth-field-error">{fieldErrors.email}</span>
                ) : null}
              </div>
            </>
          ) : (
            <div className="auth-field">
              <label htmlFor="auth-identifier">用户名或邮箱</label>
              <input
                id="auth-identifier"
                name="identifier"
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
              />
              {fieldErrors.identifier ? (
                <span className="auth-field-error">{fieldErrors.identifier}</span>
              ) : null}
            </div>
          )}

          <div className="auth-field">
            <label htmlFor="auth-password">密码</label>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {fieldErrors.password ? (
              <span className="auth-field-error">{fieldErrors.password}</span>
            ) : null}
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
      </section>
    </main>
  );
}

import { toApiError } from "../api/errors";

export type AuthMode = "login" | "register";

export type AuthFieldErrors = Partial<
  Record<"username" | "email" | "identifier" | "password", string>
>;

export type AuthErrorView = {
  fieldErrors?: AuthFieldErrors;
  formMessage?: string;
};

export function mapAuthError(error: unknown, mode: AuthMode): AuthErrorView {
  const apiError = toApiError(error);

  if (apiError.isAbort) {
    return {};
  }

  if (mode === "login" && apiError.status === 401) {
    return { formMessage: "用户名或密码错误" };
  }

  if (mode === "register" && apiError.status === 409) {
    const detail = typeof apiError.detail === "string" ? apiError.detail : "";
    if (detail.includes("Username")) {
      return { fieldErrors: { username: "该用户名已被注册" } };
    }
    if (detail.includes("Email")) {
      return { fieldErrors: { email: "该邮箱已被注册" } };
    }
  }

  if (apiError.status === 422) {
    return { formMessage: "提交内容不符合要求，请检查后重试" };
  }

  return { formMessage: apiError.message };
}

import { describe, expect, it } from "vitest";

import { ApiError } from "../api/errors";
import { mapAuthError } from "./authErrorMessages";

describe("mapAuthError", () => {
  it("maps login 401 to a form message", () => {
    const view = mapAuthError(new ApiError({ status: 401 }), "login");
    expect(view.formMessage).toBe("用户名或密码错误");
    expect(view.fieldErrors).toBeUndefined();
  });

  it("maps register 409 username conflict to a field error", () => {
    const error = new ApiError({ status: 409, detail: "Username is already registered" });
    const view = mapAuthError(error, "register");
    expect(view.fieldErrors?.username).toBe("该用户名已被注册");
  });

  it("maps register 409 email conflict to a field error", () => {
    const error = new ApiError({ status: 409, detail: "Email is already registered" });
    const view = mapAuthError(error, "register");
    expect(view.fieldErrors?.email).toBe("该邮箱已被注册");
  });

  it("maps 422 to a generic form message", () => {
    const view = mapAuthError(new ApiError({ status: 422 }), "register");
    expect(view.formMessage).toBe("提交内容不符合要求，请检查后重试");
  });

  it("ignores aborted requests", () => {
    const view = mapAuthError(new ApiError({ status: 0, isAbort: true }), "login");
    expect(view).toEqual({});
  });

  it("falls back to the api error message", () => {
    const view = mapAuthError(new ApiError({ status: 500 }), "login");
    expect(view.formMessage).toBe("服务暂时不可用，请稍后重试");
  });
});

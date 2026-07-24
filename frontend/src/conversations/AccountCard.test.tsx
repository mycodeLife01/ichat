import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { AccountCard } from "./AccountCard";

const verifiedUser = {
  username: "alice-login",
  name: "alice",
  email: "alice@example.com",
  emailVerified: true,
};

function actions() {
  return {
    onClose: vi.fn(),
    onResendVerification: vi.fn(async () => ({ status: "ok" })),
    onUpdateNickname: vi.fn(async () => ({ status: "ok" })),
    onChangePassword: vi.fn(async () => ({ status: "ok" })),
    onRequestDeletion: vi.fn(async () => ({ status: "ok" })),
    onToast: vi.fn(),
  };
}

describe("AccountCard", () => {
  it("stays open when a drag starts inside the card and ends on the backdrop", () => {
    const props = actions();
    render(<AccountCard user={verifiedUser} {...props} />);
    const dialog = screen.getByRole("dialog", { name: "账号" });
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();

    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(backdrop!);
    fireEvent.click(backdrop!);

    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(backdrop!);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the account dialog and closes it with Escape", async () => {
    const user = userEvent.setup();
    const props = actions();
    render(<AccountCard user={verifiedUser} {...props} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "关闭账号" })).toHaveFocus(),
    );
    await user.keyboard("{Escape}");

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows verified account details without a resend action", () => {
    render(
      <AccountCard
        user={verifiedUser}
        {...actions()}
      />,
    );

    expect(screen.getByText("已认证")).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("已认证");
    expect(status).toHaveAttribute("data-tone", "success");
    expect(status.querySelector("svg")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "认证邮箱" })).toBeNull();
  });

  it("presents an unverified email as a warning fact", () => {
    render(
      <AccountCard
        user={{ ...verifiedUser, emailVerified: false }}
        {...actions()}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("未认证");
    expect(status).toHaveAttribute("data-tone", "warning");
    expect(status.querySelector("svg")).not.toBeNull();
  });

  it("shows username as a read-only field before the account email", () => {
    render(<AccountCard user={verifiedUser} {...actions()} />);

    const username = screen.getByText("alice-login");
    const email = screen.getByText("alice@example.com");
    expect(screen.getByText("用户名 · 不可修改")).toBeInTheDocument();
    expect(
      username.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "用户名" })).toBeNull();
    expect(screen.queryByRole("button", { name: /复制|保存用户名|修改用户名/ })).toBeNull();
    expect(screen.getByRole("textbox", { name: "昵称" })).toBeInTheDocument();
  });

  it("opens the file chooser from the avatar button", async () => {
    const user = userEvent.setup();
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    render(
      <AccountCard
        user={verifiedUser}
        {...actions()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "选择头像" }));

    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("classifies the unverified avatar restriction as a warning", async () => {
    const user = userEvent.setup();
    const props = actions();
    render(
      <AccountCard
        user={{ ...verifiedUser, emailVerified: false }}
        {...props}
      />,
    );

    await user.click(screen.getByRole("button", { name: "选择头像" }));

    expect(props.onToast).toHaveBeenCalledWith(
      "请先完成邮箱认证后再上传头像",
      "warning",
    );
  });

  it("opens the cropper after selecting a supported image", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 512, height: 512, close: vi.fn() })));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:avatar") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    render(<AccountCard user={verifiedUser} {...actions()} />);
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });

    await user.upload(screen.getByLabelText("上传头像图片"), file);

    expect(await screen.findByRole("dialog", { name: "裁剪头像" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "缩放" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "取消裁剪" })).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "裁剪头像" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "账号" })).toBeInTheDocument();
  });

  it("associates avatar validation failures with the file field", () => {
    render(<AccountCard user={verifiedUser} {...actions()} />);
    const input = screen.getByLabelText("上传头像图片");
    const file = new File(["avatar"], "avatar.gif", { type: "image/gif" });

    fireEvent.change(input, { target: { files: [file] } });

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("仅支持 JPEG、PNG 和静态 WebP 图片。");
  });

  it("keeps avatar upload failures inline and reports an error toast", async () => {
    const user = userEvent.setup();
    const props = actions();
    const onUploadAvatar = vi.fn(async () => {
      throw new Error("头像上传失败，请重试。");
    });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 512, height: 512, close: vi.fn() })));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:avatar") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["avatar"], { type: "image/webp" }));
    });
    render(
      <AccountCard
        user={verifiedUser}
        {...props}
        onUploadAvatar={onUploadAvatar}
      />,
    );

    await user.upload(
      screen.getByLabelText("上传头像图片"),
      new File(["avatar"], "avatar.png", { type: "image/png" }),
    );
    await user.click(await screen.findByRole("button", { name: "确认并上传" }));

    const slider = screen.getByRole("slider", { name: "缩放" });
    expect(slider).toHaveAttribute("aria-invalid", "true");
    expect(slider).toHaveAccessibleDescription("头像上传失败，请重试。");
    expect(props.onToast).toHaveBeenCalledWith("头像上传失败，请重试。", "error");

    getContext.mockRestore();
    toBlob.mockRestore();
  });

  it("reports verification success and cooldown failures through the global toast", async () => {
    const user = userEvent.setup();
    const resend = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ status: "ok" })
      .mockRejectedValueOnce(new ApiError({ status: 429 }));
    const props = actions();
    const { rerender } = render(
      <AccountCard
        user={{ ...verifiedUser, emailVerified: false }}
        {...props}
        onResendVerification={resend}
      />,
    );

    const verificationButton = screen.getByRole("button", { name: "认证邮箱" });
    await user.click(verificationButton);
    expect(props.onToast).toHaveBeenCalledWith("验证邮件已发送", "success");

    rerender(
      <AccountCard
        user={{ ...verifiedUser, emailVerified: false }}
        {...props}
        onResendVerification={resend}
      />,
    );
    await user.click(screen.getByRole("button", { name: "认证邮箱" }));
    expect(props.onToast).toHaveBeenCalledWith("发送过于频繁，请稍后再试。", "error");
  });

  it("updates the nickname directly from the account overview", async () => {
    const user = userEvent.setup();
    const props = actions();
    render(<AccountCard user={verifiedUser} {...props} />);

    const input = screen.getByLabelText("昵称");
    await user.clear(input);
    await user.type(input, "Alice Cooper");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(props.onUpdateNickname).toHaveBeenCalledWith("Alice Cooper");
    expect(props.onToast).toHaveBeenCalledWith("昵称已更新", "success");
  });

  it("associates nickname validation failures with the nickname field", async () => {
    const user = userEvent.setup();
    render(<AccountCard user={verifiedUser} {...actions()} />);

    const input = screen.getByRole("textbox", { name: "昵称" });
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("昵称长度需为 1–50 个字符。");
  });

  it("classifies nickname update failures as errors", async () => {
    const user = userEvent.setup();
    const props = actions();
    props.onUpdateNickname.mockRejectedValueOnce(new Error("network"));
    render(<AccountCard user={verifiedUser} {...props} />);

    const input = screen.getByLabelText("昵称");
    await user.clear(input);
    await user.type(input, "Alice Cooper");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(props.onToast).toHaveBeenCalledWith("昵称保存失败，请重试", "error");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("昵称保存失败，请重试");
  });

  it("does not request a nickname update when the trimmed value is unchanged", async () => {
    const user = userEvent.setup();
    const props = actions();
    render(<AccountCard user={verifiedUser} {...props} />);
    const input = screen.getByLabelText("昵称");

    await user.clear(input);
    await user.type(input, "  alice  ");

    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(props.onUpdateNickname).not.toHaveBeenCalled();
  });

  it("validates and submits a password change", async () => {
    const user = userEvent.setup();
    const props = actions();
    render(<AccountCard user={verifiedUser} {...props} />);

    await user.click(screen.getByRole("button", { name: "修改密码" }));
    await user.type(screen.getByLabelText("当前密码"), "old-password");
    const newPassword = screen.getByLabelText("新密码");
    await user.type(newPassword, "short");
    await user.click(screen.getByRole("button", { name: "修改密码" }));
    expect(newPassword).toHaveAttribute("aria-invalid", "true");
    expect(newPassword).toHaveAccessibleDescription("新密码长度需为 8–128 个字符。");

    await user.clear(newPassword);
    await user.type(newPassword, "new-password");
    await user.click(screen.getByRole("button", { name: "修改密码" }));
    expect(props.onChangePassword).toHaveBeenCalledWith("old-password", "new-password");
  });

  it("associates an incorrect current password with its field", async () => {
    const user = userEvent.setup();
    const props = actions();
    props.onChangePassword.mockRejectedValueOnce(new ApiError({ status: 400 }));
    render(<AccountCard user={verifiedUser} {...props} />);

    await user.click(screen.getByRole("button", { name: "修改密码" }));
    const currentPassword = screen.getByLabelText("当前密码");
    await user.type(currentPassword, "old-password");
    await user.type(screen.getByLabelText("新密码"), "new-password");
    await user.click(screen.getByRole("button", { name: "修改密码" }));

    expect(currentPassword).toHaveAttribute("aria-invalid", "true");
    expect(currentPassword).toHaveAccessibleDescription("当前密码不正确。");
  });

  it("requests a deletion email without claiming the account is deleted", async () => {
    const user = userEvent.setup();
    const props = actions();
    render(<AccountCard user={verifiedUser} {...props} />);

    await user.click(screen.getByRole("button", { name: "注销账号" }));
    await user.type(screen.getByLabelText("当前密码"), "old-password");
    await user.click(screen.getByRole("button", { name: "发送注销确认邮件" }));

    expect(props.onRequestDeletion).toHaveBeenCalledWith("old-password");
    expect(
      await screen.findByText("注销确认邮件已发送，请检查当前邮箱。账号尚未注销。"),
    ).toBeInTheDocument();
  });

  it("keeps deletion failures beside the password field and allows cancelling", async () => {
    const user = userEvent.setup();
    const props = actions();
    props.onRequestDeletion.mockRejectedValueOnce(new ApiError({ status: 400 }));
    render(<AccountCard user={verifiedUser} {...props} />);

    await user.click(screen.getByRole("button", { name: "注销账号" }));
    const password = screen.getByLabelText("当前密码");
    await user.type(password, "old-password");
    await user.click(screen.getByRole("button", { name: "发送注销确认邮件" }));

    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAccessibleDescription("当前密码不正确。");

    await user.click(screen.getByRole("button", { name: "账号" }));
    expect(screen.getByRole("button", { name: "注销账号" })).toBeInTheDocument();
  });
});

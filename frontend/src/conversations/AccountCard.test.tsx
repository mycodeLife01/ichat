import { fireEvent, render, screen } from "@testing-library/react";
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

  it("shows verified account details without a resend action", () => {
    render(
      <AccountCard
        user={verifiedUser}
        {...actions()}
      />,
    );

    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "认证邮箱" })).toBeNull();
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

  it("previews a selected avatar locally", async () => {
    const user = userEvent.setup();
    render(<AccountCard user={verifiedUser} {...actions()} />);
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });

    await user.upload(screen.getByLabelText("上传头像图片"), file);

    expect(await screen.findByRole("img", { name: "头像预览" })).toHaveAttribute(
      "src",
      expect.stringMatching(/^data:image\/png;base64,/),
    );
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
    expect(verificationButton).toHaveClass("bg-accent", "text-accent-fg");
    await user.click(verificationButton);
    expect(props.onToast).toHaveBeenCalledWith("验证邮件已发送");

    rerender(
      <AccountCard
        user={{ ...verifiedUser, emailVerified: false }}
        {...props}
        onResendVerification={resend}
      />,
    );
    await user.click(screen.getByRole("button", { name: "认证邮箱" }));
    expect(props.onToast).toHaveBeenCalledWith("发送过于频繁，请稍后再试。");
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
    expect(props.onToast).toHaveBeenCalledWith("昵称已更新");
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
    await user.type(screen.getByLabelText("新密码"), "short");
    await user.click(screen.getByRole("button", { name: "修改密码" }));
    expect(screen.getByRole("alert")).toHaveTextContent("8–128");

    await user.clear(screen.getByLabelText("新密码"));
    await user.type(screen.getByLabelText("新密码"), "new-password");
    await user.click(screen.getByRole("button", { name: "修改密码" }));
    expect(props.onChangePassword).toHaveBeenCalledWith("old-password", "new-password");
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
});

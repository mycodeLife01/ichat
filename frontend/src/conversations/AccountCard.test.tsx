import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { AccountCard } from "./AccountCard";

const verifiedUser = {
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
  };
}

describe("AccountCard", () => {
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

  it("opens the same file chooser from the avatar and choose button", async () => {
    const user = userEvent.setup();
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    render(
      <AccountCard
        user={verifiedUser}
        {...actions()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "选择头像" }));
    await user.click(screen.getByRole("button", { name: "选择图片" }));

    expect(click).toHaveBeenCalledTimes(2);
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

  it("resends verification and explains cooldown failures", async () => {
    const user = userEvent.setup();
    const resend = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ status: "ok" })
      .mockRejectedValueOnce(new ApiError({ status: 429 }));
    const { rerender } = render(
      <AccountCard
        user={{ ...verifiedUser, emailVerified: false }}
        {...actions()}
        onResendVerification={resend}
      />,
    );

    await user.click(screen.getByRole("button", { name: "认证邮箱" }));
    expect(await screen.findByText("验证邮件已发送，请检查收件箱。")).toBeInTheDocument();

    rerender(
      <AccountCard
        user={{ ...verifiedUser, emailVerified: false }}
        {...actions()}
        onResendVerification={resend}
      />,
    );
    await user.click(screen.getByRole("button", { name: "认证邮箱" }));
    expect(await screen.findByText("发送过于频繁，请稍后再试。")).toBeInTheDocument();
  });

  it("updates the nickname from a child view", async () => {
    const user = userEvent.setup();
    const props = actions();
    render(<AccountCard user={verifiedUser} {...props} />);

    await user.click(screen.getByRole("button", { name: "修改昵称" }));
    const input = screen.getByLabelText("昵称");
    await user.clear(input);
    await user.type(input, "Alice Cooper");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(props.onUpdateNickname).toHaveBeenCalledWith("Alice Cooper");
    expect(await screen.findByText("昵称已更新。")).toBeInTheDocument();
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

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { useAppState } from "../app/context";
import { createAuthSession, tokenStore } from "../auth/tokenStore";
import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { VerifyEmailBanner } from "./VerifyEmailBanner";

const BANNER_TEXT = "请验证你的邮箱，确保账号安全。";

function ToastProbe() {
  const { ui } = useAppState();
  return <div data-testid="toast">{ui.toast?.message ?? ""}</div>;
}

function unverifiedSession() {
  return createAuthSession(authTokenResponse);
}

function verifiedSession() {
  return createAuthSession({
    ...authTokenResponse,
    user: { ...authTokenResponse.user, email_verified: true },
  });
}

describe("VerifyEmailBanner", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("shows for an unverified user", async () => {
    tokenStore.save(unverifiedSession());
    renderWithApp(<VerifyEmailBanner />, createFakeServices());

    expect(await screen.findByText(BANNER_TEXT)).toBeInTheDocument();
    expect(screen.getByText(authTokenResponse.user.email)).toBeInTheDocument();
  });

  it("hides for a verified user", async () => {
    tokenStore.save(verifiedSession());
    const me = vi.fn(async () => ({ ...authTokenResponse.user, email_verified: true }));
    renderWithApp(<VerifyEmailBanner />, createFakeServices({ me }));

    await waitFor(() => expect(me).toHaveBeenCalled());
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
  });

  it("resends and shows a success toast", async () => {
    const resendVerificationEmail = vi.fn(async () => ({ status: "ok" }));
    tokenStore.save(unverifiedSession());
    const user = userEvent.setup();
    renderWithApp(
      <>
        <VerifyEmailBanner />
        <ToastProbe />
      </>,
      createFakeServices({ resendVerificationEmail }),
    );

    await user.click(await screen.findByRole("button", { name: "重新发送验证邮件" }));

    expect(resendVerificationEmail).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("toast")).toHaveTextContent("验证邮件已发送，请检查邮箱。"),
    );
  });

  it("shows a try-later toast on 429", async () => {
    const resendVerificationEmail = vi.fn(async () => {
      throw new ApiError({ status: 429 });
    });
    tokenStore.save(unverifiedSession());
    const user = userEvent.setup();
    renderWithApp(
      <>
        <VerifyEmailBanner />
        <ToastProbe />
      </>,
      createFakeServices({ resendVerificationEmail }),
    );

    await user.click(await screen.findByRole("button", { name: "重新发送验证邮件" }));

    await waitFor(() => expect(screen.getByTestId("toast")).toHaveTextContent("请稍后再试"));
  });
});

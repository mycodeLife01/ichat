import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import type { AuthUserResponse } from "../api/types";
import { useAppActions } from "../app/context";
import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { createAuthSession, tokenStore } from "./tokenStore";
import { VerifyEmailPage } from "./VerifyEmailPage";

function renderAt(path: string, services = createFakeServices()) {
  return renderWithApp(<VerifyEmailPage />, services, undefined, [path]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ResettableVerifyEmailPage({ onReady }: { onReady(reset: () => void): void }) {
  const { dispatch } = useAppActions();
  onReady(() => dispatch({ type: "app/reset" }));
  return <VerifyEmailPage />;
}

describe("VerifyEmailPage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("lets a logged-out visitor verify a token", async () => {
    const verifyEmail = vi.fn(async () => ({ status: "ok" }));
    renderAt("/verify-email?token=abc123", createFakeServices({ verifyEmail }));

    expect(await screen.findByText("Email verified")).toBeInTheDocument();
    expect(verifyEmail).toHaveBeenCalledWith("abc123");
    expect(
      screen.getByText("Your email is verified and your account is more secure.").closest(
        "[data-tone]",
      ),
    ).toHaveAttribute("data-tone", "success");
  });

  it("waits for session recovery before verifying and refreshing the user", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));
    const recoveredUser = deferred<AuthUserResponse>();
    const verifiedUser = { ...authTokenResponse.user, email_verified: true };
    const me = vi
      .fn<() => Promise<AuthUserResponse>>()
      .mockImplementationOnce(() => recoveredUser.promise)
      .mockResolvedValueOnce(verifiedUser);
    const verifyEmail = vi.fn(async () => ({ status: "ok" }));

    renderAt("/verify-email?token=abc123", createFakeServices({ verifyEmail, me }));

    await waitFor(() => expect(me).toHaveBeenCalledTimes(1));
    expect(verifyEmail).not.toHaveBeenCalled();

    recoveredUser.resolve(authTokenResponse.user);

    expect(await screen.findByText("Email verified")).toBeInTheDocument();
    expect(verifyEmail).toHaveBeenCalledWith("abc123");
    await waitFor(() => expect(me).toHaveBeenCalledTimes(2));
    expect(tokenStore.read()?.user.email_verified).toBe(true);
  });

  it("treats a reused link as success when the recovered user is verified", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));
    const me = vi
      .fn<() => Promise<AuthUserResponse>>()
      .mockResolvedValueOnce(authTokenResponse.user)
      .mockResolvedValueOnce({ ...authTokenResponse.user, email_verified: true });
    const verifyEmail = vi.fn(async () => {
      throw new ApiError({ status: 400, detail: "Invalid or expired verification link" });
    });

    renderAt("/verify-email?token=reused", createFakeServices({ verifyEmail, me }));

    expect(await screen.findByText("Email verified")).toBeInTheDocument();
    expect(me).toHaveBeenCalledTimes(2);
  });

  it("keeps successful verification visible when the user refresh fails", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));
    const me = vi
      .fn<() => Promise<AuthUserResponse>>()
      .mockResolvedValueOnce(authTokenResponse.user)
      .mockRejectedValueOnce(new Error("refresh failed"));

    renderAt("/verify-email?token=abc123", createFakeServices({ me }));

    expect(await screen.findByText("Email verified")).toBeInTheDocument();
    expect(me).toHaveBeenCalledTimes(2);
  });

  it("does not verify twice when a failed user refresh resets auth", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));
    let resetAuth = () => {};
    const me = vi
      .fn<() => Promise<AuthUserResponse>>()
      .mockResolvedValueOnce(authTokenResponse.user)
      .mockImplementationOnce(async () => {
        resetAuth();
        throw new ApiError({ status: 401 });
      });
    const verifyEmail = vi
      .fn<() => Promise<{ status: string }>>()
      .mockResolvedValueOnce({ status: "ok" })
      .mockRejectedValueOnce(new ApiError({ status: 400 }));

    renderWithApp(
      <ResettableVerifyEmailPage onReady={(reset) => (resetAuth = reset)} />,
      createFakeServices({ me, verifyEmail }),
      undefined,
      ["/verify-email?token=abc123"],
    );

    expect(await screen.findByText("Email verified")).toBeInTheDocument();
    expect(verifyEmail).toHaveBeenCalledOnce();
  });

  it("shows a generic failure to a logged-out visitor", async () => {
    const verifyEmail = vi.fn(async () => {
      throw new ApiError({ status: 400, detail: "Invalid or expired verification link" });
    });
    renderAt("/verify-email?token=bad", createFakeServices({ verifyEmail }));

    expect(await screen.findByText("Verification link unavailable")).toBeInTheDocument();
    expect(
      screen
        .getByText("This verification link may be expired, already used, or invalid.")
        .closest("[data-tone]"),
    ).toHaveAttribute("data-tone", "warning");
    expect(screen.queryByRole("button", { name: "Resend verification email" })).toBeNull();
    expect(screen.getByRole("link", { name: "Go to Piko" })).toBeInTheDocument();
  });

  it("offers resend with an English confirmation when the recovered user is unverified", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));
    const me = vi.fn(async () => authTokenResponse.user);
    const verifyEmail = vi.fn(async () => {
      throw new ApiError({ status: 400 });
    });
    const resendVerificationEmail = vi.fn(async () => ({ status: "ok" }));
    const user = userEvent.setup();

    renderAt(
      "/verify-email?token=bad",
      createFakeServices({ verifyEmail, me, resendVerificationEmail }),
    );

    await user.click(
      await screen.findByRole("button", { name: "Resend verification email" }),
    );
    expect(resendVerificationEmail).toHaveBeenCalledOnce();
    const sent = await screen.findByText("Verification email sent. Check your inbox.");
    expect(sent.closest("[data-tone]")).toHaveAttribute("data-tone", "success");
  });

  it("marks the resend button busy while sending and reports a send failure", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));
    const me = vi.fn(async () => authTokenResponse.user);
    const verifyEmail = vi.fn(async () => {
      throw new ApiError({ status: 400 });
    });
    let rejectResend!: (error: Error) => void;
    const resendVerificationEmail = vi.fn(
      () =>
        new Promise<{ status: string }>((_resolve, reject) => {
          rejectResend = reject;
        }),
    );
    const user = userEvent.setup();

    renderAt(
      "/verify-email?token=bad",
      createFakeServices({ verifyEmail, me, resendVerificationEmail }),
    );

    await user.click(
      await screen.findByRole("button", { name: "Resend verification email" }),
    );

    const pending = await screen.findByRole("button", { name: "Sending verification email" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");

    rejectResend(new Error("smtp down"));

    const failure = await screen.findByText("Could not send the email. Please try again later.");
    expect(failure.closest("[data-tone]")).toHaveAttribute("data-tone", "error");
    expect(
      screen.getByRole("button", { name: "Resend verification email" }),
    ).toBeEnabled();
  });
});

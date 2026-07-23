import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { useAppState } from "../app/context";
import { createAuthSession, tokenStore } from "../auth/tokenStore";
import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { VerifyEmailBanner } from "./VerifyEmailBanner";

const BANNER_TEXT = "Verify your email to keep your account secure.";
const SENT_TEXT = "We sent a verification email to";

function ToastProbe() {
  const { ui } = useAppState();
  return (
    <div data-testid="toast" data-tone={ui.toast?.tone ?? ""}>
      {ui.toast?.message ?? ""}
    </div>
  );
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
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it("shows for an unverified user with a Send button and does not auto-send", async () => {
    const resendVerificationEmail = vi.fn(async () => ({ status: "ok" }));
    tokenStore.save(unverifiedSession());
    renderWithApp(<VerifyEmailBanner />, createFakeServices({ resendVerificationEmail }));

    expect(await screen.findByText(BANNER_TEXT)).toBeInTheDocument();
    expect(screen.getByText(authTokenResponse.user.email)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send verification email" }),
    ).toBeInTheDocument();
    expect(resendVerificationEmail).not.toHaveBeenCalled();
  });

  it("hides for a verified user", async () => {
    tokenStore.save(verifiedSession());
    const me = vi.fn(async () => ({ ...authTokenResponse.user, email_verified: true }));
    renderWithApp(<VerifyEmailBanner />, createFakeServices({ me }));

    await waitFor(() => expect(me).toHaveBeenCalled());
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
  });

  it("sends, shows a success toast, and enters a cooldown countdown", async () => {
    // shouldAdvanceTime keeps waitFor's real-time polling alive under fake timers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const resendVerificationEmail = vi.fn(async () => ({ status: "ok" }));
    tokenStore.save(unverifiedSession());
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderWithApp(
      <>
        <VerifyEmailBanner />
        <ToastProbe />
      </>,
      createFakeServices({ resendVerificationEmail }),
    );

    await user.click(await screen.findByRole("button", { name: "Send verification email" }));

    expect(resendVerificationEmail).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("toast")).toHaveTextContent(
        "Verification email sent. Check your inbox.",
      ),
    );
    expect(screen.getByTestId("toast")).toHaveAttribute("data-tone", "success");
    expect(screen.getByText(SENT_TEXT, { exact: false })).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Resend in 60s" });
    expect(button).toBeDisabled();
  });

  it("re-enables as Resend after the cooldown elapses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const resendVerificationEmail = vi.fn(async () => ({ status: "ok" }));
    tokenStore.save(unverifiedSession());
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderWithApp(<VerifyEmailBanner />, createFakeServices({ resendVerificationEmail }));

    await user.click(await screen.findByRole("button", { name: "Send verification email" }));
    await screen.findByRole("button", { name: "Resend in 60s" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole("button", { name: "Resend in 59s" })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });

    const button = screen.getByRole("button", { name: "Resend verification email" });
    expect(button).toBeEnabled();
  });

  it("shows a try-later toast on 429 and keeps the Send label", async () => {
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

    await user.click(await screen.findByRole("button", { name: "Send verification email" }));

    await waitFor(() =>
      expect(screen.getByTestId("toast")).toHaveTextContent("Please try again later."),
    );
    expect(screen.getByTestId("toast")).toHaveAttribute("data-tone", "error");
    expect(
      screen.getByRole("button", { name: "Send verification email" }),
    ).toBeInTheDocument();
    expect(screen.getByText(BANNER_TEXT)).toBeInTheDocument();
  });

  it("shows a failure toast on other errors and keeps the Send label", async () => {
    const resendVerificationEmail = vi.fn(async () => {
      throw new ApiError({ status: 500 });
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

    await user.click(await screen.findByRole("button", { name: "Send verification email" }));

    await waitFor(() =>
      expect(screen.getByTestId("toast")).toHaveTextContent(
        "Could not send the email. Try again.",
      ),
    );
    expect(screen.getByTestId("toast")).toHaveAttribute("data-tone", "error");
    const button = screen.getByRole("button", { name: "Send verification email" });
    expect(button).toBeEnabled();
    expect(screen.getByText(BANNER_TEXT)).toBeInTheDocument();
  });
});

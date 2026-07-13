import { useEffect, useState } from "react";

import { ApiError } from "../api/errors";
import { useAppActions } from "../app/context";
import { useAuthSession } from "../auth/useAuthSession";

// Mirrors auth_email_verification_cooldown_seconds on the backend so the UI
// disables the button instead of letting the user run into a 429.
const COOLDOWN_SECONDS = 60;

// Persistent, non-blocking reminder shown in the authed shell while the current
// user's email is unverified. Does not gate any feature — only prompts.
//
// The button reads "Send" until the user successfully sends one in this
// session, then "Resend" — we never claim an email was sent when it may not
// have been (pre-verification accounts, delivery failures).
export function VerifyEmailBanner() {
  const { user } = useAuthSession();
  const { services, dispatch } = useAppActions();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((s) => s - 1), 1_000);
    return () => clearInterval(timer);
  }, [cooldown]);

  if (!user || user.email_verified) return null;

  const disabled = sending || cooldown > 0;

  const onSend = async () => {
    if (disabled) return;
    setSending(true);
    try {
      await services.authApi.resendVerificationEmail();
      setSent(true);
      setCooldown(COOLDOWN_SECONDS);
      dispatch({
        type: "ui/showToast",
        message: "Verification email sent. Check your inbox.",
      });
    } catch (error) {
      const tooMany = error instanceof ApiError && error.status === 429;
      dispatch({
        type: "ui/showToast",
        message: tooMany ? "Please try again later." : "Could not send the email. Try again.",
      });
    } finally {
      setSending(false);
    }
  };

  const label = sending
    ? "Sending…"
    : cooldown > 0
      ? `Resend in ${cooldown}s`
      : sent
        ? "Resend verification email"
        : "Send verification email";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-bg-raised px-4 py-2 text-[13px] text-fg-muted">
      {sent ? (
        <span>
          We sent a verification email to{" "}
          <span className="text-fg-subtle">{user.email}</span>. Check your inbox.
        </span>
      ) : (
        <>
          <span>Verify your email to keep your account secure.</span>
          <span className="text-fg-subtle">{user.email}</span>
        </>
      )}
      <button
        type="button"
        onClick={() => void onSend()}
        disabled={disabled}
        className="ml-auto rounded-md border border-border bg-bg px-2.5 py-1 text-[12.5px] font-medium text-fg transition-[background,border-color] duration-[120ms] hover:border-border-strong disabled:opacity-60"
      >
        {label}
      </button>
    </div>
  );
}

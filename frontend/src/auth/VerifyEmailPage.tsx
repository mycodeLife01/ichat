import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LoaderCircle } from "lucide-react";

import { ApiError } from "../api/errors";
import { useAppActions } from "../app/context";
import {
  controlText,
  primaryButton,
  semanticStatus,
  surfaceTitle,
} from "../ui/classes";
import { InlineStatus } from "../ui/InlineStatus";
import { LoadingButtonContent } from "../ui/LoadingButtonContent";
import { Wordmark } from "../ui/Wordmark";
import { authCtaLink } from "./authFields";
import { useAuthSession } from "./useAuthSession";

type Status = "loading" | "success" | "error";
type ResendStatus = "idle" | "sending" | "sent" | "error";

// Public page (outside AuthGate): a logged-out user clicking the email link must
// still be able to verify. On success, if a session exists we refresh the user
// mirror so the unverified banner disappears.
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const { services, stateRef } = useAppActions();
  const { bootstrapped, isAuthenticated, user, refreshUser } = useAuthSession();
  const [status, setStatus] = useState<Status>("loading");
  const [resend, setResend] = useState<ResendStatus>("idle");

  useEffect(() => {
    let active = true;
    if (!bootstrapped) return;
    if (!token) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    void (async () => {
      try {
        await services.authApi.verifyEmail(token);
        if (stateRef.current.auth.session !== null) {
          try {
            await refreshUser();
          } catch {
            // Verification already succeeded; a failed mirror refresh is fine.
          }
        }
        if (active) setStatus("success");
      } catch (error) {
        if (!(error instanceof ApiError)) {
          if (active) setStatus("error");
          throw error;
        }
        // Friendly idempotency: the public endpoint returns a generic failure
        // even when the email was already verified. If we have a session, ask
        // /me and treat an already-verified account as success.
        if (stateRef.current.auth.session !== null) {
          try {
            const refreshed = await refreshUser();
            if (refreshed.email_verified) {
              if (active) setStatus("success");
              return;
            }
          } catch {
            // fall through to generic failure
          }
        }
        if (active) setStatus("error");
      }
    })();
    return () => {
      active = false;
    };
  }, [bootstrapped, refreshUser, services, stateRef, token]);

  const onResend = async () => {
    if (resend === "sending") return;
    setResend("sending");
    try {
      await services.authApi.resendVerificationEmail();
      setResend("sent");
    } catch {
      setResend("error");
    }
  };

  const showResend = isAuthenticated && user != null && !user.email_verified;

  return (
    <div className="flex h-full flex-col bg-bg font-ui text-type-primary">
      <header className="flex h-[52px] shrink-0 items-center border-b border-border bg-bg">
        <div className="mx-auto flex w-full max-w-[var(--reading-width)] items-center px-8 max-[760px]:px-[18px]">
          <Link to="/" className="flex min-h-11 items-center" aria-label="iChat home">
            <Wordmark size={18} />
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[var(--reading-width)] px-8 pt-16 text-center max-[760px]:px-[18px]">
        {status === "loading" && (
          <p
            className={`inline-flex items-center gap-2 text-type-tertiary ${semanticStatus}`}
            role="status"
            aria-live="polite"
          >
            <LoaderCircle className="animate-spin" size={15} strokeWidth={1.9} aria-hidden="true" />
            Verifying…
          </p>
        )}

        {status === "success" && (
          <>
            <h1 className={`mb-2 ${surfaceTitle}`}>Email verified</h1>
            <InlineStatus tone="success" className="mx-auto inline-flex text-left">
              Your email is verified and your account is more secure.
            </InlineStatus>
            <div>
              <Link to="/" className={`${authCtaLink} mt-5`}>
                Return to iChat
              </Link>
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <h1 className={`mb-2 ${surfaceTitle}`}>Verification link unavailable</h1>
            <InlineStatus tone="warning" className="mx-auto inline-flex text-left">
              This verification link may be expired, already used, or invalid.
            </InlineStatus>
            {showResend ? (
              <div className="mt-5 flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onResend()}
                  disabled={resend === "sending"}
                  aria-busy={resend === "sending"}
                  aria-label={
                    resend === "sending"
                      ? "Sending verification email"
                      : "Resend verification email"
                  }
                  className={`${primaryButton} h-11 px-4 ${controlText} !font-medium !text-accent-foreground disabled:!text-type-disabled`}
                >
                  <LoadingButtonContent
                    loading={resend === "sending"}
                    label="Resend verification email"
                  />
                </button>
                {resend === "sent" && (
                  <InlineStatus tone="success" className="text-left">
                    Verification email sent. Check your inbox.
                  </InlineStatus>
                )}
                {resend === "error" && (
                  <InlineStatus tone="error" className="text-left">
                    Could not send the email. Please try again later.
                  </InlineStatus>
                )}
              </div>
            ) : (
              <div>
                <Link to="/" className={`${authCtaLink} mt-5`}>
                  Go to iChat
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

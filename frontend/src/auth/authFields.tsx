// Shared form-field and CTA styling for the standalone auth pages
// (AuthScreen, ResetPasswordPage, VerifyEmailPage, ConfirmAccountDeletionPage).
// Built on the semantic primitives so these pages stay consistent with the
// in-chat account panel.
import { inputControl, primaryButton } from "../ui/classes";

export const authField = "mb-3.5 flex flex-col gap-1.5";

export const authFieldLabel = "text-[12.5px] font-medium text-text-muted";

export const authFieldInput =
  `${inputControl} h-11 w-full px-3.5 text-[14px] placeholder:text-text-faint`;

// Primary call-to-action link on auth outcome pages; pages add their own mt-*.
export const authCtaLink = `${primaryButton} h-11 px-5 text-[13px] font-medium`;

// Per-field error copy: associated to its input via aria-describedby, no live
// region — cross-form failures use InlineStatus (role=alert) or a Toast.
export function AuthFieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="m-0 text-xs leading-[1.55] text-danger">
      {message}
    </p>
  );
}

import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  Camera,
  ChevronRight,
  KeyRound,
  Mail,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import { ApiError } from "../api/errors";
import { Avatar } from "../ui/Avatar";
import {
  buttonControl,
  controlText,
  dangerInteractiveItem,
  formHelp,
  formValue,
  iconControl,
  inputControl,
  interactiveItem,
  primaryButton,
  surfaceTitle,
  uiLabel,
} from "../ui/classes";
import { InlineStatus } from "../ui/InlineStatus";
import { LoadingButtonContent } from "../ui/LoadingButtonContent";
import { ModalDialog } from "../ui/ModalDialog";
import type { ToastHandler } from "../ui/state";
import { AvatarCropper } from "./AvatarCropper";

type AccountCardProps = {
  user: { email: string; username: string; name: string; emailVerified: boolean; avatarUrl?: string | null };
  onClose: () => void;
  onResendVerification: () => Promise<unknown>;
  onUpdateNickname: (nickname: string) => Promise<unknown>;
  onUploadAvatar?: (blob: Blob) => Promise<string>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<unknown>;
  onRequestDeletion: (password: string) => Promise<unknown>;
  onToast: ToastHandler;
};

type AccountView = "overview" | "password" | "deletion";
type PasswordErrors = {
  current?: string;
  newPassword?: string;
  form?: string;
};

const fieldClass =
  `${inputControl} h-10 w-full px-3 outline-none`;
const primaryClass =
  `${primaryButton} h-9 shrink-0 px-4 ${controlText} !font-medium !text-accent-foreground disabled:!text-type-disabled`;
function AccountActionRow({
  icon,
  title,
  description,
  danger = false,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      className={`${danger ? dangerInteractiveItem : interactiveItem} flex w-full items-center gap-3 px-2 py-3.5 text-left`}
      onClick={onClick}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-pill ${
          danger ? "text-danger" : "bg-sunken text-text-muted"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block ${uiLabel} ${danger ? "!text-danger" : ""}`}>{title}</span>
        <span className={`mt-0.5 block ${formHelp} ${danger ? "!text-danger" : ""}`}>{description}</span>
      </span>
      <ChevronRight size={14} className="text-fg-faint" />
    </button>
  );
}

export function AccountCard({
  user,
  onClose,
  onResendVerification,
  onUpdateNickname,
  onUploadAvatar,
  onChangePassword,
  onRequestDeletion,
  onToast,
}: AccountCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user.avatarUrl ?? null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [avatarStatus, setAvatarStatus] = useState<string | null>(null);
  const [view, setView] = useState<AccountView>("overview");
  const [nickname, setNickname] = useState(user.name);
  const [savedNickname, setSavedNickname] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deletionPassword, setDeletionPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [passwordErrors, setPasswordErrors] = useState<PasswordErrors>({});
  const [deletionError, setDeletionError] = useState<string | null>(null);

  const chooseAvatar = () => {
    if (!user.emailVerified) {
      onToast("Verify your email before uploading an avatar.", "warning");
      return;
    }
    inputRef.current?.click();
  };
  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setAvatarError(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setAvatarError("Only JPEG, PNG, and static WebP images are supported.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setAvatarError("The source image must not exceed 10 MiB.");
      return;
    }
    if (file.type === "image/webp") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const signature = new TextDecoder("latin1").decode(bytes);
      if (signature.includes("ANIM") || signature.includes("ANMF")) {
        setAvatarError("Animated WebP images are not supported.");
        return;
      }
    }
    try {
      if (typeof createImageBitmap !== "function") {
        setCropFile(file);
        return;
      }
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      if (width < 128 || height < 128) throw new Error("The image must be at least 128×128 pixels.");
      if (width > 8192 || height > 8192 || width * height > 20_000_000) {
        throw new Error("The image must be at most 8192 pixels per side and 20 million pixels total.");
      }
      setCropFile(file);
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "The image could not be decoded.");
    }
  };

  const back = () => {
    setView("overview");
    setAvatarError(null);
    setPasswordErrors({});
    setDeletionError(null);
  };

  const saveNickname = async () => {
    const normalized = nickname.trim();
    if (normalized.length < 1 || normalized.length > 50) {
      setNicknameError("Nickname must be between 1 and 50 characters.");
      return;
    }
    if (normalized === savedNickname) return;
    setSubmitting(true);
    setNicknameError(null);
    try {
      await onUpdateNickname(normalized);
      setNickname(normalized);
      setSavedNickname(normalized);
      onToast("昵称已更新", "success");
    } catch {
      setNicknameError("Failed to save nickname. Please try again.");
      onToast("Failed to save nickname. Please try again.", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async () => {
    if (sending) return;
    setSending(true);
    try {
      await onResendVerification();
      onToast("验证邮件已发送", "success");
    } catch (error) {
      onToast(
        error instanceof ApiError && error.status === 429
          ? "Too many requests. Please try again later."
          : "Failed to send the verification email. Please try again.",
        "error",
      );
    } finally {
      setSending(false);
    }
  };

  const changePassword = async () => {
    if (newPassword.length < 8 || newPassword.length > 128) {
      setPasswordErrors({ newPassword: "New password must be between 8 and 128 characters." });
      return;
    }
    setSubmitting(true);
    setPasswordErrors({});
    try {
      await onChangePassword(currentPassword, newPassword);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        setPasswordErrors({ current: "Current password is incorrect." });
      } else {
        setPasswordErrors({
          form:
            error instanceof ApiError && error.status === 429
              ? "Too many attempts. Please try again later."
              : "Failed to change password. Please try again.",
        });
      }
      setSubmitting(false);
    }
  };

  const requestDeletion = async () => {
    setSubmitting(true);
    setDeletionError(null);
    try {
      await onRequestDeletion(deletionPassword);
      setDeletionPassword("");
      setNotice("注销确认邮件已发送，请检查当前邮箱。账号尚未注销。");
      setView("overview");
    } catch (error) {
      setDeletionError(
        error instanceof ApiError && error.status === 429
          ? "Too many requests. Please try again later."
          : error instanceof ApiError && error.status === 400
            ? "Current password is incorrect."
            : "Failed to send the confirmation email. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalDialog
      titleId="account-card-title"
      onClose={onClose}
      className="w-full max-w-[680px] overflow-hidden"
      backdropClassName="z-50 p-6 max-[760px]:p-2"
    >
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4 max-[760px]:px-4">
          <div>
            <h2 id="account-card-title" className={surfaceTitle}>
              账号
            </h2>
            <p className={`mt-1 ${formHelp}`}>管理公开资料、邮箱与账号安全。</p>
          </div>
          <button
            type="button"
            className={`${iconControl} h-8 w-8 shrink-0`}
            aria-label="关闭账号"
            data-dialog-initial-focus
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="max-h-[calc(100vh-128px)] overflow-y-auto px-6 py-5 max-[760px]:px-4">
          {notice && <InlineStatus tone="success" className="mb-4">{notice}</InlineStatus>}

          {view === "overview" && (
            <>
              <section className="pb-5">
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    className={`relative flex h-14 w-14 shrink-0 items-center justify-center overflow-visible rounded-pill bg-accent text-lg font-semibold text-accent-foreground ${
                      avatarError ? "outline-2 outline-error-border" : ""
                    }`}
                    aria-label="选择头像"
                    aria-invalid={avatarError != null}
                    aria-describedby={avatarError ? "account-avatar-error" : undefined}
                    onClick={chooseAvatar}
                  >
                    <Avatar
                      name={nickname}
                      url={avatarUrl}
                      className="h-full w-full text-lg"
                      imageAlt="头像预览"
                    />
                    <span className="absolute -right-0.5 -bottom-0.5 flex h-5 w-5 items-center justify-center rounded-pill border-2 border-surface bg-accent text-accent-foreground">
                      <Camera size={10} />
                    </span>
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className={uiLabel}>个人头像</div>
                    <div className={`mt-0.5 ${formHelp}`}>
                      {avatarStatus ?? (user.emailVerified ? "支持 JPEG、PNG 和 WebP" : "完成邮箱认证后可上传")}
                    </div>
                  </div>
                  <input
                    ref={inputRef}
                    className="sr-only"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label="上传头像图片"
                    aria-invalid={avatarError != null}
                    aria-describedby={avatarError ? "account-avatar-error" : undefined}
                    onChange={onFileChange}
                  />
                </div>
                {avatarError && (
                  <InlineStatus
                    id="account-avatar-error"
                    tone="error"
                    className="mt-2 border-0 bg-transparent px-0 py-0"
                  >
                    {avatarError}
                  </InlineStatus>
                )}

                <form
                  className="mt-4 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveNickname();
                  }}
                >
                  <input
                    className={fieldClass}
                    value={nickname}
                    maxLength={50}
                    autoComplete="nickname"
                    aria-label="昵称"
                    aria-invalid={nicknameError != null}
                    aria-describedby={nicknameError ? "account-nickname-error" : undefined}
                    onChange={(event) => {
                      setNickname(event.target.value);
                      setNicknameError(null);
                    }}
                  />
                  <button
                    type="submit"
                    className={primaryClass}
                    disabled={submitting || nickname.trim() === savedNickname}
                    aria-busy={submitting}
                    aria-label={submitting ? "正在保存" : "保存"}
                  >
                    <LoadingButtonContent loading={submitting} label="保存" />
                  </button>
                </form>
                {nicknameError && (
                  <InlineStatus
                    id="account-nickname-error"
                    tone="error"
                    className="mt-2 border-0 bg-transparent px-0 py-0"
                  >
                    {nicknameError}
                  </InlineStatus>
                )}
              </section>

              <div className="divide-y divide-border border-y border-border">
                <div className="flex items-center gap-3 px-1 py-3.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-sunken text-text-muted">
                    <UserRound size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate ${formValue}`}>{user.username}</div>
                    <div className={formHelp}>用户名 · 不可修改</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 px-1 py-3.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-sunken text-text-muted">
                    <Mail size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate ${formValue}`}>{user.email}</div>
                    <div className={formHelp}>账号邮箱</div>
                  </div>
                  <InlineStatus
                    tone={user.emailVerified ? "success" : "warning"}
                    className="shrink-0 border-0 bg-transparent p-0"
                  >
                    {user.emailVerified ? "已认证" : "未认证"}
                  </InlineStatus>
                  {!user.emailVerified && (
                    <button
                      type="button"
                      className={`${primaryButton} h-8 shrink-0 px-3 ${controlText} !font-medium !text-accent-foreground disabled:!text-type-disabled`}
                      disabled={sending}
                      aria-busy={sending}
                      aria-label={sending ? "正在发送认证邮件" : "认证邮箱"}
                      onClick={() => void resend()}
                    >
                      <LoadingButtonContent loading={sending} label="认证邮箱" />
                    </button>
                  )}
                </div>
                <AccountActionRow
                  icon={<KeyRound size={14} />}
                  title="修改密码"
                  description="更新登录密码"
                  onClick={() => {
                    setAvatarError(null);
                    setPasswordErrors({});
                    setView("password");
                  }}
                />
                <AccountActionRow
                  icon={<Trash2 size={14} />}
                  title="注销账号"
                  description="停用账号并退出所有设备"
                  danger
                  onClick={() => {
                    setAvatarError(null);
                    setDeletionError(null);
                    setView("deletion");
                  }}
                />
              </div>
            </>
          )}

          {view === "password" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void changePassword();
              }}
            >
              <button type="button" className={`${buttonControl} mb-4 h-8 gap-1.5 px-2 ${controlText}`} onClick={back}>
                <ArrowLeft size={13} />账号
              </button>
              <h3 className={surfaceTitle}>修改密码</h3>
              <p className={`mt-1 ${formHelp}`}>更新后所有设备会退出登录。</p>
              <div className="mt-5 grid grid-cols-2 gap-2 max-[760px]:grid-cols-1">
                <div>
                  <label className="sr-only" htmlFor="account-current-password">当前密码</label>
                  <input
                    id="account-current-password"
                    className={fieldClass}
                    type="password"
                    autoComplete="current-password"
                    placeholder="当前密码"
                    value={currentPassword}
                    aria-invalid={passwordErrors.current != null}
                    aria-describedby={passwordErrors.current ? "account-current-password-error" : undefined}
                    onChange={(event) => {
                      setCurrentPassword(event.target.value);
                      setPasswordErrors((errors) => ({ ...errors, current: undefined }));
                    }}
                  />
                  {passwordErrors.current && (
                    <InlineStatus
                      id="account-current-password-error"
                      tone="error"
                      className="mt-2 border-0 bg-transparent px-0 py-0"
                    >
                      {passwordErrors.current}
                    </InlineStatus>
                  )}
                </div>
                <div>
                  <label className="sr-only" htmlFor="account-new-password">新密码</label>
                  <input
                    id="account-new-password"
                    className={fieldClass}
                    type="password"
                    autoComplete="new-password"
                    placeholder="新密码（8–128 位）"
                    value={newPassword}
                    aria-invalid={passwordErrors.newPassword != null}
                    aria-describedby={passwordErrors.newPassword ? "account-new-password-error" : undefined}
                    onChange={(event) => {
                      setNewPassword(event.target.value);
                      setPasswordErrors((errors) => ({ ...errors, newPassword: undefined }));
                    }}
                  />
                  {passwordErrors.newPassword && (
                    <InlineStatus
                      id="account-new-password-error"
                      tone="error"
                      className="mt-2 border-0 bg-transparent px-0 py-0"
                    >
                      {passwordErrors.newPassword}
                    </InlineStatus>
                  )}
                </div>
              </div>
              {passwordErrors.form && (
                <InlineStatus tone="error" className="mt-3">
                  {passwordErrors.form}
                </InlineStatus>
              )}
              <div className="mt-4 flex justify-end">
                <button
                  type="submit"
                  className={primaryClass}
                  disabled={submitting}
                  aria-busy={submitting}
                >
                  <LoadingButtonContent loading={submitting} label="修改密码" />
                </button>
              </div>
            </form>
          )}

          {view === "deletion" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void requestDeletion();
              }}
            >
              <button type="button" className={`${buttonControl} mb-4 h-8 gap-1.5 px-2 ${controlText}`} onClick={back}>
                <ArrowLeft size={13} />账号
              </button>
              <h3 className={`${surfaceTitle} !text-danger`}>注销账号</h3>
              <p className={`mt-1 ${formHelp}`}>确认链接将发送至 {user.email}。点击邮件链接前，账号不会停用。</p>
              <label className="sr-only" htmlFor="account-deletion-password">当前密码</label>
              <input
                id="account-deletion-password"
                className={`${fieldClass} mt-5`}
                type="password"
                autoComplete="current-password"
                placeholder="输入当前密码确认"
                value={deletionPassword}
                aria-invalid={deletionError != null}
                aria-describedby={deletionError ? "account-deletion-password-error" : undefined}
                onChange={(event) => {
                  setDeletionPassword(event.target.value);
                  setDeletionError(null);
                }}
              />
              {deletionError && (
                <InlineStatus
                  id="account-deletion-password-error"
                  tone="error"
                  className="mt-2 border-0 bg-transparent px-0 py-0"
                >
                  {deletionError}
                </InlineStatus>
              )}
              <div className="mt-4 flex justify-end">
                <button
                  type="submit"
                  className={primaryClass}
                  disabled={submitting || deletionPassword.length < 8}
                  aria-busy={submitting}
                >
                  <LoadingButtonContent loading={submitting} label="发送注销确认邮件" />
                </button>
              </div>
            </form>
          )}
        </div>
      {cropFile && (
        <AvatarCropper
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onError={(message) => onToast(message, "error")}
          onConfirm={async (blob) => {
            if (!onUploadAvatar) throw new Error("Avatar upload is unavailable.");
            setAvatarStatus("正在处理头像…");
            let url: string;
            try {
              url = await onUploadAvatar(blob);
            } catch {
              throw new Error("Avatar upload failed. Please try again.");
            }
            setAvatarUrl(url);
            setAvatarStatus("头像已更新");
            setCropFile(null);
            onToast("头像已更新", "success");
          }}
        />
      )}
    </ModalDialog>
  );
}

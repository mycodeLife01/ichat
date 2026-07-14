import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  BadgeCheck,
  Camera,
  ChevronRight,
  KeyRound,
  Mail,
  MailWarning,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import { ApiError } from "../api/errors";
import { Avatar } from "../ui/Avatar";
import { AvatarCropper } from "./AvatarCropper";

type AccountCardProps = {
  user: { email: string; username: string; name: string; emailVerified: boolean; avatarUrl?: string | null };
  onClose: () => void;
  onResendVerification: () => Promise<unknown>;
  onUpdateNickname: (nickname: string) => Promise<unknown>;
  onUploadAvatar?: (blob: Blob) => Promise<string>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<unknown>;
  onRequestDeletion: (password: string) => Promise<unknown>;
  onToast: (message: string) => void;
};

type AccountView = "overview" | "password" | "deletion";

const fieldClass =
  "h-10 w-full rounded-md border border-border-strong bg-bg px-3 text-[13px] text-fg outline-none transition-colors focus:border-fg-muted";
const primaryClass =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-accent px-4 text-[12.5px] font-medium text-accent-fg disabled:opacity-60";
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
      className={`flex w-full items-center gap-3 px-1 py-3.5 text-left ${
        danger ? "text-danger" : "text-fg"
      }`}
      onClick={onClick}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          danger ? "bg-danger-soft" : "bg-bg-sunken text-fg-muted"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium">{title}</span>
        <span className="mt-0.5 block text-[10.5px] text-fg-subtle">{description}</span>
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
  const [formError, setFormError] = useState<string | null>(null);

  const chooseAvatar = () => {
    if (!user.emailVerified) {
      onToast("请先完成邮箱认证后再上传头像");
      return;
    }
    inputRef.current?.click();
  };
  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setFormError(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setFormError("仅支持 JPEG、PNG 和静态 WebP 图片。");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setFormError("原图不能超过 10 MiB。");
      return;
    }
    if (file.type === "image/webp") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const signature = new TextDecoder("latin1").decode(bytes);
      if (signature.includes("ANIM") || signature.includes("ANMF")) {
        setFormError("头像不支持动画 WebP，请选择静态图片。");
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
      if (width < 128 || height < 128) throw new Error("图片至少需要 128×128 像素。");
      if (width > 8192 || height > 8192 || width * height > 20_000_000) {
        throw new Error("图片像素过大，请选择最长边不超过 8192 且总像素不超过 2000 万的图片。");
      }
      setCropFile(file);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "图片无法解码，请选择其他图片。");
    }
  };

  const back = () => {
    setView("overview");
    setFormError(null);
  };

  const saveNickname = async () => {
    const normalized = nickname.trim();
    if (normalized.length < 1 || normalized.length > 50) {
      setFormError("昵称长度需为 1–50 个字符。");
      return;
    }
    if (normalized === savedNickname) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onUpdateNickname(normalized);
      setNickname(normalized);
      setSavedNickname(normalized);
      onToast("昵称已更新");
    } catch {
      onToast("昵称保存失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async () => {
    if (sending) return;
    setSending(true);
    try {
      await onResendVerification();
      onToast("验证邮件已发送");
    } catch (error) {
      onToast(
        error instanceof ApiError && error.status === 429
          ? "发送过于频繁，请稍后再试。"
          : "验证邮件发送失败，请重试。",
      );
    } finally {
      setSending(false);
    }
  };

  const changePassword = async () => {
    if (newPassword.length < 8 || newPassword.length > 128) {
      setFormError("新密码长度需为 8–128 个字符。");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await onChangePassword(currentPassword, newPassword);
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.status === 429
          ? "尝试次数过多，请稍后再试。"
          : error instanceof ApiError && error.status === 400
            ? "当前密码不正确。"
            : "密码修改失败，请重试。",
      );
      setSubmitting(false);
    }
  };

  const requestDeletion = async () => {
    setSubmitting(true);
    setFormError(null);
    try {
      await onRequestDeletion(deletionPassword);
      setDeletionPassword("");
      setNotice("注销确认邮件已发送，请检查当前邮箱。账号尚未注销。");
      setView("overview");
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.status === 429
          ? "请求过于频繁，请稍后再试。"
          : error instanceof ApiError && error.status === 400
            ? "当前密码不正确。"
            : "确认邮件发送失败，请重试。",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,19,0.36)] p-6 backdrop-blur-[1px] max-[760px]:p-2"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="w-full max-w-[680px] overflow-hidden rounded-xl border border-border-strong bg-bg-raised shadow-[0_24px_80px_rgba(20,20,19,0.22)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-card-title"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-4 max-[760px]:px-4">
          <div>
            <h2 id="account-card-title" className="text-[16px] font-semibold text-fg">
              账号
            </h2>
            <p className="mt-1 text-[11px] text-fg-subtle">管理公开资料、邮箱与账号安全。</p>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
            aria-label="关闭账号"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="max-h-[calc(100vh-128px)] overflow-y-auto px-6 py-5 max-[760px]:px-4">
          {notice && (
            <div className="mb-4 flex items-center rounded-md border border-[#cce5d2] bg-[#f0f8f2] px-3 py-2 text-[11.5px] text-[#39734a]" role="status">
              {notice}
            </div>
          )}

          {view === "overview" && (
            <>
              <section className="pb-5">
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-visible rounded-full bg-accent text-lg font-semibold text-accent-fg"
                    aria-label="选择头像"
                    onClick={chooseAvatar}
                  >
                    <Avatar
                      name={nickname}
                      url={avatarUrl}
                      className="h-full w-full text-lg"
                      imageAlt="头像预览"
                    />
                    <span className="absolute -right-0.5 -bottom-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-bg-raised bg-accent text-accent-fg">
                      <Camera size={10} />
                    </span>
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-fg">个人头像</div>
                    <div className="mt-0.5 text-[10.5px] text-fg-subtle">
                      {avatarStatus ?? (user.emailVerified ? "支持 JPEG、PNG 和静态 WebP" : "完成邮箱认证后可上传")}
                    </div>
                  </div>
                  <input
                    ref={inputRef}
                    className="sr-only"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label="上传头像图片"
                    onChange={onFileChange}
                  />
                </div>

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
                    onChange={(event) => setNickname(event.target.value)}
                  />
                  <button
                    type="submit"
                    className={primaryClass}
                    disabled={submitting || nickname.trim() === savedNickname}
                  >
                    {submitting ? "保存中…" : "保存"}
                  </button>
                </form>
                {formError && <p className="mt-2 text-[12px] text-danger" role="alert">{formError}</p>}
              </section>

              <div className="divide-y divide-border border-y border-border">
                <div className="flex items-center gap-3 px-1 py-3.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-fg-muted">
                    <UserRound size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-fg">{user.username}</div>
                    <div className="text-[10.5px] text-fg-subtle">用户名 · 不可修改</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 px-1 py-3.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-fg-muted">
                    <Mail size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-fg">{user.email}</div>
                    <div className="text-[10.5px] text-fg-subtle">账号邮箱</div>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 text-[11.5px] ${
                      user.emailVerified ? "text-success" : "text-warning"
                    }`}
                  >
                    {user.emailVerified ? <BadgeCheck size={13} /> : <MailWarning size={13} />}
                    {user.emailVerified ? "已认证" : "未认证"}
                  </span>
                  {!user.emailVerified && (
                    <button
                      type="button"
                      className="inline-flex h-8 shrink-0 items-center justify-center rounded-md bg-accent px-3 text-[12px] font-medium text-accent-fg transition-opacity hover:opacity-85 disabled:opacity-60"
                      disabled={sending}
                      onClick={() => void resend()}
                    >
                      {sending ? "发送中…" : "认证邮箱"}
                    </button>
                  )}
                </div>
                <AccountActionRow
                  icon={<KeyRound size={14} />}
                  title="修改密码"
                  description="更新登录密码"
                  onClick={() => {
                    setFormError(null);
                    setView("password");
                  }}
                />
                <AccountActionRow
                  icon={<Trash2 size={14} />}
                  title="注销账号"
                  description="停用账号并退出所有设备"
                  danger
                  onClick={() => {
                    setFormError(null);
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
              <button type="button" className="mb-4 inline-flex items-center gap-1.5 text-[11.5px] text-fg-muted hover:text-fg" onClick={back}>
                <ArrowLeft size={13} />账号
              </button>
              <h3 className="text-[15px] font-semibold text-fg">修改密码</h3>
              <p className="mt-1 text-[10.5px] text-fg-subtle">更新后所有设备会退出登录。</p>
              <div className="mt-5 grid grid-cols-2 gap-2 max-[760px]:grid-cols-1">
                <label className="sr-only" htmlFor="account-current-password">当前密码</label>
                <input id="account-current-password" className={fieldClass} type="password" autoComplete="current-password" placeholder="当前密码" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
                <label className="sr-only" htmlFor="account-new-password">新密码</label>
                <input id="account-new-password" className={fieldClass} type="password" autoComplete="new-password" placeholder="新密码（8–128 位）" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
              </div>
              {formError && <p className="mt-2 text-[12px] text-danger" role="alert">{formError}</p>}
              <div className="mt-4 flex justify-end">
                <button type="submit" className={primaryClass} disabled={submitting}>
                  {submitting ? "修改中…" : "修改密码"}
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
              <button type="button" className="mb-4 inline-flex items-center gap-1.5 text-[11.5px] text-fg-muted hover:text-fg" onClick={back}>
                <ArrowLeft size={13} />账号
              </button>
              <h3 className="text-[15px] font-semibold text-danger">注销账号</h3>
              <p className="mt-1 text-[10.5px] text-fg-muted">确认链接将发送至 {user.email}。点击邮件链接前，账号不会停用。</p>
              <label className="sr-only" htmlFor="account-deletion-password">当前密码</label>
              <input id="account-deletion-password" className={`${fieldClass} mt-5`} type="password" autoComplete="current-password" placeholder="输入当前密码确认" value={deletionPassword} onChange={(event) => setDeletionPassword(event.target.value)} />
              {formError && <p className="mt-2 text-[12px] text-danger" role="alert">{formError}</p>}
              <div className="mt-4 flex justify-end">
                <button type="submit" className="inline-flex h-9 items-center justify-center rounded-full bg-danger px-4 text-[12.5px] font-medium text-white disabled:opacity-60" disabled={submitting || deletionPassword.length < 8}>
                  {submitting ? "发送中…" : "发送注销确认邮件"}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
      {cropFile && (
        <AvatarCropper
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onConfirm={async (blob) => {
            if (!onUploadAvatar) throw new Error("头像上传服务暂不可用。");
            setAvatarStatus("正在处理头像…");
            const url = await onUploadAvatar(blob);
            setAvatarUrl(url);
            setAvatarStatus("头像已更新");
            setCropFile(null);
            onToast("头像已更新");
          }}
        />
      )}
    </div>
  );
}

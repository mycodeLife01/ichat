import { useRef, useState, type ChangeEvent } from "react";
import {
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  MailWarning,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { ApiError } from "../api/errors";

type AccountCardProps = {
  user: { email: string; name: string; emailVerified: boolean };
  onClose: () => void;
  onResendVerification: () => Promise<unknown>;
  onUpdateNickname: (nickname: string) => Promise<unknown>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<unknown>;
  onRequestDeletion: (password: string) => Promise<unknown>;
};

type AccountView = "overview" | "nickname" | "password" | "deletion";

export function AccountCard({
  user,
  onClose,
  onResendVerification,
  onUpdateNickname,
  onChangePassword,
  onRequestDeletion,
}: AccountCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [emailFeedback, setEmailFeedback] = useState<string | null>(null);
  const [view, setView] = useState<AccountView>("overview");
  const [nickname, setNickname] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deletionPassword, setDeletionPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const chooseAvatar = () => inputRef.current?.click();
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAvatarUrl(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  const resend = async () => {
    if (sending) return;
    setSending(true);
    setEmailFeedback(null);
    try {
      await onResendVerification();
      setEmailFeedback("验证邮件已发送，请检查收件箱。");
    } catch (error) {
      setEmailFeedback(
        error instanceof ApiError && error.status === 429
          ? "发送过于频繁，请稍后再试。"
          : "验证邮件发送失败，请重试。",
      );
    } finally {
      setSending(false);
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
    setSubmitting(true);
    setFormError(null);
    try {
      await onUpdateNickname(normalized);
      setNickname(normalized);
      setFeedback("昵称已更新。");
      setView("overview");
    } catch {
      setFormError("昵称保存失败，请重试。");
    } finally {
      setSubmitting(false);
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
      setFeedback("注销确认邮件已发送，请检查当前邮箱。账号尚未注销。");
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,19,0.32)] p-4"
      onClick={onClose}
    >
      <section
        className="max-h-[calc(100vh-32px)] w-full max-w-[520px] overflow-y-auto rounded-xl border border-border-strong bg-bg-raised p-6 shadow-[0_18px_60px_rgba(20,20,19,0.18)] max-[760px]:p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-card-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {view !== "overview" && (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center text-fg-muted hover:text-fg"
                aria-label="返回账号"
                onClick={back}
              >
                <ChevronLeft size={17} />
              </button>
            )}
            <h2 id="account-card-title" className="text-lg font-semibold text-fg">
              {view === "overview"
                ? "账号"
                : view === "nickname"
                  ? "修改昵称"
                  : view === "password"
                    ? "修改密码"
                    : "注销账号"}
            </h2>
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:text-fg"
            aria-label="关闭账号"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        {view === "overview" && <>
        <div className="mt-5 flex items-center gap-4 border-b border-border pb-5">
          <button
            type="button"
            className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent text-xl font-semibold text-accent-fg"
            aria-label="选择头像"
            onClick={chooseAvatar}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="头像预览" className="h-full w-full object-cover" />
            ) : (
              (user.name || "U").slice(0, 1).toUpperCase()
            )}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium text-fg">{nickname}</div>
            <div className="mt-1 truncate text-[12px] text-fg-muted">{user.email}</div>
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-fg-muted hover:text-fg"
              onClick={chooseAvatar}
            >
              <Upload size={13} />
              选择图片
            </button>
            <input
              ref={inputRef}
              className="sr-only"
              type="file"
              accept="image/*"
              aria-label="上传头像图片"
              onChange={onFileChange}
            />
          </div>
        </div>

        <dl className="divide-y divide-border">
          <div className="flex items-center justify-between gap-4 py-4">
            <dt className="text-[13px] text-fg-muted">展示名称</dt>
            <dd className="truncate text-[13px] font-medium text-fg">{nickname}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-4">
            <dt className="text-[13px] text-fg-muted">邮箱</dt>
            <dd className="min-w-0 text-right">
              <div className="truncate text-[13px] font-medium text-fg">{user.email}</div>
              <div
                className={`mt-1 inline-flex items-center gap-1 text-[11.5px] ${
                  user.emailVerified ? "text-success" : "text-warning"
                }`}
              >
                {user.emailVerified ? <BadgeCheck size={13} /> : <MailWarning size={13} />}
                <span>{user.emailVerified ? "已认证" : "未认证"}</span>
              </div>
            </dd>
          </div>
        </dl>

        {!user.emailVerified && (
          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between gap-4">
              <p className="text-[12px] text-fg-muted">发送验证链接到当前邮箱。</p>
              <button
                type="button"
                className="shrink-0 rounded-md border border-border-strong px-3 py-1.5 text-[12px] font-medium text-fg hover:border-fg-muted disabled:opacity-60"
                disabled={sending}
                onClick={() => void resend()}
              >
                {sending ? "发送中…" : "认证邮箱"}
              </button>
            </div>
            {emailFeedback && <p className="mt-2 text-[12px] text-fg-muted" role="status">{emailFeedback}</p>}
          </div>
        )}
        <div className="mt-2 border-t border-border pt-2">
          <button
            type="button"
            className="flex w-full items-center gap-3 py-3 text-left text-[13px] text-fg"
            onClick={() => setView("nickname")}
          >
            <Pencil size={15} className="text-fg-muted" />
            <span className="flex-1">修改昵称</span>
            <ChevronRight size={15} className="text-fg-subtle" />
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-3 py-3 text-left text-[13px] text-fg"
            onClick={() => setView("password")}
          >
            <KeyRound size={15} className="text-fg-muted" />
            <span className="flex-1">修改密码</span>
            <ChevronRight size={15} className="text-fg-subtle" />
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-3 py-3 text-left text-[13px] text-danger"
            onClick={() => setView("deletion")}
          >
            <Trash2 size={15} />
            <span className="flex-1">注销账号</span>
            <ChevronRight size={15} />
          </button>
        </div>
        {feedback && (
          <p className="mt-3 text-[12px] text-fg-muted" role="status">{feedback}</p>
        )}
        </>}

        {view === "nickname" && (
          <form className="mt-6" onSubmit={(event) => { event.preventDefault(); void saveNickname(); }}>
            <label className="block text-[12px] font-medium text-fg" htmlFor="account-nickname">昵称</label>
            <input
              id="account-nickname"
              className="mt-2 h-10 w-full rounded-md border border-border-strong bg-bg px-3 text-[13px] text-fg outline-none focus:border-fg-muted"
              value={nickname}
              maxLength={50}
              autoComplete="nickname"
              onChange={(event) => setNickname(event.target.value)}
            />
            {formError && <p className="mt-2 text-[12px] text-danger" role="alert">{formError}</p>}
            <button className="mt-5 h-10 w-full rounded-full bg-accent text-[13px] font-medium text-accent-fg disabled:opacity-60" disabled={submitting}>
              {submitting ? "保存中…" : "保存"}
            </button>
          </form>
        )}

        {view === "password" && (
          <form className="mt-6 space-y-4" onSubmit={(event) => { event.preventDefault(); void changePassword(); }}>
            <label className="block text-[12px] font-medium text-fg">当前密码
              <input className="mt-2 h-10 w-full rounded-md border border-border-strong bg-bg px-3 text-[13px] outline-none focus:border-fg-muted" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            </label>
            <label className="block text-[12px] font-medium text-fg">新密码
              <input className="mt-2 h-10 w-full rounded-md border border-border-strong bg-bg px-3 text-[13px] outline-none focus:border-fg-muted" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            </label>
            {formError && <p className="text-[12px] text-danger" role="alert">{formError}</p>}
            <button className="h-10 w-full rounded-full bg-accent text-[13px] font-medium text-accent-fg disabled:opacity-60" disabled={submitting}>
              {submitting ? "修改中…" : "修改密码"}
            </button>
          </form>
        )}

        {view === "deletion" && (
          <form className="mt-6" onSubmit={(event) => { event.preventDefault(); void requestDeletion(); }}>
            <p className="text-[13px] leading-6 text-fg-muted">输入当前密码后，我们会向你的邮箱发送注销确认链接。点击邮件链接前，账号不会停用。</p>
            <label className="mt-5 block text-[12px] font-medium text-fg">当前密码
              <input className="mt-2 h-10 w-full rounded-md border border-border-strong bg-bg px-3 text-[13px] outline-none focus:border-danger" type="password" autoComplete="current-password" value={deletionPassword} onChange={(event) => setDeletionPassword(event.target.value)} />
            </label>
            {formError && <p className="mt-2 text-[12px] text-danger" role="alert">{formError}</p>}
            <button className="mt-5 h-10 w-full rounded-full bg-danger text-[13px] font-medium text-white disabled:opacity-60" disabled={submitting || deletionPassword.length < 8}>
              {submitting ? "发送中…" : "发送注销确认邮件"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

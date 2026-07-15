import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useAppActions } from "../app/context";
import { tokenStore } from "./tokenStore";
import { Wordmark } from "../ui/Wordmark";

type ConfirmStatus = "loading" | "success" | "error";

export function ConfirmAccountDeletionPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const { services, dispatch, streamAbort } = useAppActions();
  const [status, setStatus] = useState<ConfirmStatus>("loading");

  useEffect(() => {
    let active = true;
    if (!token) {
      setStatus("error");
      return;
    }
    void services.authApi.confirmAccountDeletion(token).then(
      () => {
        streamAbort.abort();
        tokenStore.clear();
        dispatch({ type: "app/reset" });
        if (active) setStatus("success");
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [dispatch, services, streamAbort, token]);

  return (
    <main className="flex h-full flex-col bg-bg">
      <header className="flex h-[52px] shrink-0 items-center border-b border-border px-6">
        <Link to="/" aria-label="iChat 首页"><Wordmark size={18} /></Link>
      </header>
      <div className="mx-auto flex w-full max-w-[520px] flex-1 flex-col items-center justify-center px-6 text-center">
        {status === "loading" && <p className="text-[14px] text-fg-muted">正在确认注销…</p>}
        {status === "success" && <>
          <h1 className="text-xl font-semibold text-fg">账号已停用</h1>
          <p className="mt-3 text-[13px] leading-6 text-fg-muted">你的登录凭证已失效，账号数据目前按注销策略保留。</p>
          <Link to="/" className="mt-6 rounded-full bg-accent px-5 py-2.5 text-[13px] font-medium text-accent-fg">返回登录</Link>
        </>}
        {status === "error" && <>
          <h1 className="text-xl font-semibold text-fg">注销链接不可用</h1>
          <p className="mt-3 text-[13px] leading-6 text-fg-muted">链接可能已过期、已使用或无效，账号状态未发生变化。</p>
          <Link to="/" className="mt-6 rounded-full border border-border-strong px-5 py-2.5 text-[13px] font-medium text-fg">返回 iChat</Link>
        </>}
      </div>
    </main>
  );
}

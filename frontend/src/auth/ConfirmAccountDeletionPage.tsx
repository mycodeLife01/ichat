import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LoaderCircle } from "lucide-react";

import { useAppActions } from "../app/context";
import { buttonControl } from "../ui/classes";
import { InlineStatus } from "../ui/InlineStatus";
import { authCtaLink } from "./authFields";
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
        <Link to="/" className="flex min-h-11 items-center" aria-label="Piko 首页">
          <Wordmark size={18} />
        </Link>
      </header>
      <div className="mx-auto flex w-full max-w-[520px] flex-1 flex-col items-center justify-center px-6 text-center">
        {status === "loading" && (
          <p
            className="inline-flex items-center gap-2 text-[14px] text-fg-muted"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle className="animate-spin" size={15} strokeWidth={1.9} aria-hidden="true" />
            正在确认注销…
          </p>
        )}
        {status === "success" && <>
          <h1 className="text-xl font-semibold text-fg">账号已停用</h1>
          <InlineStatus tone="success" className="mt-4 text-left">
            你的登录凭证已失效，账号数据目前按注销策略保留。
          </InlineStatus>
          <Link to="/" className={`${authCtaLink} mt-6`}>
            返回登录
          </Link>
        </>}
        {status === "error" && <>
          <h1 className="text-xl font-semibold text-fg">注销链接不可用</h1>
          <InlineStatus tone="warning" className="mt-4 text-left">
            链接可能已过期、已使用或无效，账号状态未发生变化。
          </InlineStatus>
          <Link
            to="/"
            className={`${buttonControl} mt-6 h-11 border border-border-strong px-5 text-[13px] font-medium`}
          >
            返回 Piko
          </Link>
        </>}
      </div>
    </main>
  );
}

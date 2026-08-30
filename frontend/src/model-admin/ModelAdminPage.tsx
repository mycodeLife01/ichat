import { KeyRound, LoaderCircle, Route as RouteIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { ApiError, toApiError } from "../api/errors";
import type {
  ModelAdminCatalog,
  ModelAdminRoute,
  UpsertChatModelRequest,
  UpsertModelRouteRequest,
  UpsertModelUpstreamRequest,
} from "../api/modelAdmin";
import { useAppActions } from "../app/context";
import { inputControl, primaryButton } from "../ui/classes";
import { InlineStatus } from "../ui/InlineStatus";
import { ModelAdminDashboard } from "./ModelAdminDashboard";
import { modelAdminAccessKeyStore } from "./accessKeyStore";

type Mutation = () => Promise<ModelAdminCatalog>;

export function ModelAdminPage() {
  const { services } = useAppActions();
  const restoredAccessKey = useRef(modelAdminAccessKeyStore.read());
  const [accessKey, setAccessKey] = useState(restoredAccessKey.current ?? "");
  const [catalog, setCatalog] = useState<ModelAdminCatalog | null>(null);
  const [gateBusy, setGateBusy] = useState(Boolean(restoredAccessKey.current));
  const [gateError, setGateError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(
    null,
  );

  const lock = useCallback(() => {
    modelAdminAccessKeyStore.clear();
    setAccessKey("");
    setCatalog(null);
    setBusyAction(null);
    setNotice(null);
  }, []);

  const rejectAccess = useCallback(
    (error: unknown) => {
      const apiError = toApiError(error);
      if (apiError.status === 401 || apiError.status === 429) {
        lock();
      }
      setGateError(errorText(apiError));
    },
    [lock],
  );

  const openCatalog = useCallback(
    async (candidate: string, persist: boolean) => {
      setGateBusy(true);
      setGateError(null);
      try {
        const loaded = await services.modelAdminApi.getCatalog(candidate);
        setAccessKey(candidate);
        setCatalog(loaded);
        if (persist) modelAdminAccessKeyStore.save(candidate);
      } catch (error) {
        rejectAccess(error);
      } finally {
        setGateBusy(false);
      }
    },
    [rejectAccess, services.modelAdminApi],
  );

  useEffect(() => {
    const restored = restoredAccessKey.current;
    if (restored) void openCatalog(restored, false);
  }, [openCatalog]);

  const runMutation = useCallback(
    async (action: string, successText: string, mutation: Mutation): Promise<boolean> => {
      setBusyAction(action);
      setNotice(null);
      try {
        const updated = await mutation();
        setCatalog(updated);
        setNotice({ tone: "success", text: successText });
        return true;
      } catch (error) {
        const apiError = toApiError(error);
        if (apiError.status === 401 || apiError.status === 429) {
          rejectAccess(apiError);
        } else {
          setNotice({ tone: "error", text: errorText(apiError) });
        }
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [rejectAccess],
  );

  if (catalog === null) {
    return (
      <AccessGate
        accessKey={accessKey}
        busy={gateBusy}
        error={gateError}
        onAccessKeyChange={setAccessKey}
        onSubmit={(candidate) => openCatalog(candidate, true)}
      />
    );
  }

  return (
    <ModelAdminDashboard
      catalog={catalog}
      busyAction={busyAction}
      notice={notice}
      onLock={lock}
      onRefresh={() =>
        runMutation("refresh", "目录已刷新。", () =>
          services.modelAdminApi.getCatalog(accessKey),
        )
      }
      onSaveModel={(modelKey, body) =>
        runMutation("save-model", "模型配置已保存。", () =>
          services.modelAdminApi.upsertModel(accessKey, modelKey, body),
        )
      }
      onSetModelEnabled={(modelKey, enabled) =>
        runMutation("toggle-model", enabled ? "模型已上线。" : "模型已下线。", () =>
          services.modelAdminApi.setModelEnabled(accessKey, modelKey, enabled),
        )
      }
      onSaveUpstream={(upstreamKey, body) =>
        runMutation("save-upstream", "上游配置已保存。", () =>
          services.modelAdminApi.upsertUpstream(accessKey, upstreamKey, body),
        )
      }
      onSetUpstreamEnabled={(upstreamKey, enabled) =>
        runMutation("toggle-upstream", enabled ? "上游已上线。" : "上游已下线。", () =>
          services.modelAdminApi.setUpstreamEnabled(accessKey, upstreamKey, enabled),
        )
      }
      onSaveRoute={(body) =>
        runMutation("save-route", "模型路由已保存。", () =>
          services.modelAdminApi.upsertRoute(accessKey, body),
        )
      }
      onSetRouteEnabled={(route, enabled) =>
        runMutation("toggle-route", enabled ? "模型路由已上线。" : "模型路由已下线。", () =>
          services.modelAdminApi.setRouteEnabled(accessKey, route, enabled),
        )
      }
      onSetCatalogEnabled={(enabled) =>
        runMutation(
          "toggle-catalog",
          enabled ? "数据库模型目录已生效。" : "已切回 ENV 模型目录。",
          () => services.modelAdminApi.setCatalogEnabled(accessKey, enabled),
        )
      }
      onImportEnvironment={() =>
        runMutation("import-environment", "ENV 模型配置已导入数据库。", () =>
          services.modelAdminApi.importEnvironment(accessKey),
        )
      }
    />
  );
}

type AccessGateProps = {
  accessKey: string;
  busy: boolean;
  error: string | null;
  onAccessKeyChange: (value: string) => void;
  onSubmit: (accessKey: string) => Promise<void>;
};

function AccessGate({
  accessKey,
  busy,
  error,
  onAccessKeyChange,
  onSubmit,
}: AccessGateProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessKey || busy) return;
    void onSubmit(accessKey);
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-canvas px-5 py-10 text-text-primary">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[36%] h-px bg-[linear-gradient(90deg,transparent,rgba(37,87,214,0.24),transparent)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[36%] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-canvas bg-[#2557d6] shadow-[0_0_0_1px_rgba(37,87,214,0.24)]"
      />

      <section className="relative w-full max-w-[420px] rounded-dialog border border-border-strong bg-surface p-7 shadow-dialog sm:p-9">
        <div className="mb-7 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-card bg-[#edf2ff] text-[#2557d6]">
            <RouteIcon size={22} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-muted">
              iChat operations
            </p>
            <h1 className="mt-0.5 text-[21px] font-semibold tracking-[-0.025em]">
              模型路由控制台
            </h1>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <label htmlFor="model-admin-access-key" className="text-[13px] font-medium">
            固定访问密钥
          </label>
          <div className="relative mt-2">
            <KeyRound
              size={16}
              strokeWidth={1.8}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />
            <input
              id="model-admin-access-key"
              name="model-admin-access-key"
              type="password"
              autoComplete="off"
              autoFocus={!busy}
              className={`${inputControl} h-11 w-full pl-10 pr-3 font-mono text-[13px]`}
              value={accessKey}
              disabled={busy}
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "model-admin-access-error" : undefined}
              onChange={(event) => onAccessKeyChange(event.target.value)}
            />
          </div>

          <p className="mt-2 text-[11.5px] leading-[1.55] text-text-muted">
            The key stays in this tab session and is sent only in the dedicated request header.
          </p>

          {error ? (
            <InlineStatus id="model-admin-access-error" tone="error" className="mt-4">
              {error}
            </InlineStatus>
          ) : null}

          <button
            type="submit"
            className={`${primaryButton} mt-6 h-11 w-full gap-2 px-4 text-[13.5px] font-medium`}
            disabled={!accessKey || busy}
            aria-busy={busy}
          >
            {busy ? (
              <LoaderCircle
                size={16}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {busy ? "正在验证" : "进入控制台"}
          </button>
        </form>

        <p className="mt-7 border-t border-border pt-4 font-mono text-[10.5px] text-text-faint">
          X-Model-Admin-Key · no user session
        </p>
      </section>
    </main>
  );
}

function errorText(error: ApiError): string {
  return typeof error.detail === "string" ? error.detail : error.message;
}

export type ModelAdminMutationHandlers = {
  onSaveModel(modelKey: string, body: UpsertChatModelRequest): Promise<boolean>;
  onSaveUpstream(upstreamKey: string, body: UpsertModelUpstreamRequest): Promise<boolean>;
  onSaveRoute(body: UpsertModelRouteRequest): Promise<boolean>;
  onSetRouteEnabled(route: ModelAdminRoute, enabled: boolean): Promise<boolean>;
};

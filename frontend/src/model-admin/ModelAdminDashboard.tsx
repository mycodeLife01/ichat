import {
  Archive,
  ArrowLeft,
  BrainCircuit,
  Database,
  Download,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Server,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import type {
  ModelAdminCatalog,
  ModelAdminChatModel,
  ModelAdminRoute,
  ModelAdminUpstream,
  UpsertChatModelRequest,
  UpsertModelRouteRequest,
  UpsertModelUpstreamRequest,
} from "../api/modelAdmin";
import {
  buttonControl,
  cardSurface,
  iconControl,
  primaryButton,
} from "../ui/classes";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { InlineStatus } from "../ui/InlineStatus";
import { useArchiveFlow, type ArchiveHandlers } from "./archiveActions";
import { ArchivedList } from "./ArchivedList";
import {
  activeCatalog,
  archivedEntries,
  matchesQuery,
  routesOfModel,
  routesOfUpstream,
  routeStatusText,
} from "./catalogView";
import { SearchField, SegmentedControl } from "./ModelAdminControls";
import {
  ModelAdminEditorDialog,
  type ModelAdminEditor,
} from "./ModelAdminEditors";

export type ModelAdminDashboardProps = {
  catalog: ModelAdminCatalog;
  busyAction: string | null;
  notice: { tone: "success" | "error"; text: string } | null;
  onLock: () => void;
  onRefresh: () => Promise<boolean>;
  onSaveModel: (modelKey: string, body: UpsertChatModelRequest) => Promise<boolean>;
  onSetModelEnabled: (modelKey: string, enabled: boolean) => Promise<boolean>;
  onSaveUpstream: (
    upstreamKey: string,
    body: UpsertModelUpstreamRequest,
  ) => Promise<boolean>;
  onSetUpstreamEnabled: (upstreamKey: string, enabled: boolean) => Promise<boolean>;
  onSaveRoute: (body: UpsertModelRouteRequest) => Promise<boolean>;
  onSetRouteEnabled: (route: ModelAdminRoute, enabled: boolean) => Promise<boolean>;
  onSetCatalogEnabled: (enabled: boolean) => Promise<boolean>;
  onImportEnvironment: () => Promise<boolean>;
} & ArchiveHandlers;

type Pane = "models" | "upstreams" | "archived";

// A searchable list on the left and one selected item's full detail on the
// right; narrow screens drill down from list to detail.
export function ModelAdminDashboard(props: ModelAdminDashboardProps) {
  const { catalog: fullCatalog, busyAction } = props;
  const catalog = useMemo(() => activeCatalog(fullCatalog), [fullCatalog]);
  const busy = busyAction !== null;
  const [pane, setPane] = useState<Pane>("models");
  const [query, setQuery] = useState("");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [showDetailOnMobile, setShowDetailOnMobile] = useState(false);
  const [editor, setEditor] = useState<ModelAdminEditor | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const flow = useArchiveFlow(fullCatalog, props);
  const upstreamByKey = useMemo(
    () => new Map(catalog.upstreams.map((upstream) => [upstream.key, upstream])),
    [catalog.upstreams],
  );

  const models = catalog.models.filter((model) => matchesQuery(model, query));
  const upstreams = catalog.upstreams.filter((upstream) => matchesQuery(upstream, query));
  const archivedCount = archivedEntries(fullCatalog).length;
  const selectedModel =
    pane === "models"
      ? (catalog.models.find((model) => model.ref === selectedRef) ?? models[0])
      : undefined;
  const selectedUpstream =
    pane === "upstreams"
      ? (catalog.upstreams.find((upstream) => upstream.ref === selectedRef) ?? upstreams[0])
      : undefined;

  const select = (ref: string) => {
    setSelectedRef(ref);
    setShowDetailOnMobile(true);
    // Narrow screens swap the list for the detail; bring its top into view.
    if (window.matchMedia?.("(max-width: 1023px)").matches)
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "start" }));
  };
  const switchPane = (next: Pane) => {
    setPane(next);
    setQuery("");
    setSelectedRef(null);
    setShowDetailOnMobile(next === "archived");
  };

  return (
    <ConsoleChrome
      {...props}
      catalog={catalog}
      overlays={
        <>
          {editor ? (
            <ModelAdminEditorDialog
              editor={editor}
              models={catalog.models}
              upstreams={catalog.upstreams}
              onClose={() => setEditor(null)}
              onSaveModel={props.onSaveModel}
              onSaveUpstream={props.onSaveUpstream}
              onSaveRoute={props.onSaveRoute}
            />
          ) : null}
          {flow.dialog}
        </>
      }
    >
      <section
        className="mt-8 grid gap-4 pb-10 lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start"
        aria-label="模型目录"
      >
        <aside
          className={`${cardSurface} flex min-w-0 flex-col overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100dvh-32px)] ${
            showDetailOnMobile ? "hidden lg:flex" : ""
          }`}
        >
          <div className="space-y-2.5 border-b border-border p-3">
            <SegmentedControl
              label="目录分段"
              className="flex w-full"
              value={pane === "archived" ? "models" : pane}
              options={[
                { value: "models", label: "模型", count: catalog.models.length },
                { value: "upstreams", label: "上游", count: catalog.upstreams.length },
              ]}
              onChange={switchPane}
            />
            <div className="flex gap-2">
              <SearchField
                className="flex-1"
                label={pane === "upstreams" ? "搜索上游" : "搜索模型"}
                value={query}
                onChange={setQuery}
              />
              <button
                type="button"
                className={`${iconControl} h-9 w-9 shrink-0 border border-border-strong`}
                aria-label={pane === "upstreams" ? "添加上游" : "添加模型"}
                disabled={busy}
                onClick={() =>
                  setEditor({ kind: pane === "upstreams" ? "upstream" : "model" })
                }
              >
                <Plus size={15} aria-hidden="true" />
              </button>
            </div>
          </div>

          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label="目录项">
            {pane !== "upstreams"
              ? models.map((model) => (
                  <ListRow
                    key={model.ref}
                    current={pane === "models" && selectedModel?.ref === model.ref}
                    enabled={model.enabled}
                    title={model.label}
                    detail={model.key}
                    count={routesOfModel(catalog, model).length}
                    onSelect={() => {
                      setPane("models");
                      select(model.ref);
                    }}
                  />
                ))
              : upstreams.map((upstream) => (
                  <ListRow
                    key={upstream.ref}
                    current={selectedUpstream?.ref === upstream.ref}
                    enabled={upstream.enabled}
                    title={upstream.label}
                    detail={`${upstream.key} · ${upstream.adapter}`}
                    count={routesOfUpstream(catalog, upstream).length}
                    onSelect={() => select(upstream.ref)}
                  />
                ))}
            {(pane === "upstreams" ? upstreams : models).length === 0 ? (
              <li className="px-3 py-6 text-center text-[11.5px] text-text-muted">No matches.</li>
            ) : null}
          </ul>

          <button
            type="button"
            aria-current={pane === "archived" ? "true" : undefined}
            className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 text-left text-[12px] text-text-muted transition-[background,color] duration-[120ms] hover:bg-hover hover:text-text-primary aria-current:bg-selected aria-current:text-text-primary"
            onClick={() => switchPane("archived")}
          >
            <span className="flex items-center gap-2">
              <Archive size={13} aria-hidden="true" />
              已归档
            </span>
            <span className="font-mono text-[10px] text-text-faint">{archivedCount}</span>
          </button>
        </aside>

        <div
          ref={detailRef}
          className={`min-w-0 scroll-mt-4 ${showDetailOnMobile ? "" : "hidden lg:block"}`}
        >
          <button
            type="button"
            className={`${buttonControl} mb-3 h-9 gap-1.5 px-2 text-[12px] lg:hidden`}
            onClick={() => setShowDetailOnMobile(false)}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            返回列表
          </button>

          {pane === "archived" ? (
            <div className={`${cardSurface} p-5`}>
              <DetailEyebrow>Archived</DetailEyebrow>
              <h2 className="mt-1 text-[18px] font-semibold tracking-[-0.02em]">已归档</h2>
              <p className="mt-1 text-[12px] leading-[1.6] text-text-muted">
                Archived items stay out of the catalog. Routes archived with a model return
                when the model is restored.
              </p>
              <ArchivedList
                className="mt-4"
                catalog={fullCatalog}
                busy={busy}
                onRestore={flow.restore}
              />
            </div>
          ) : selectedModel ? (
            <ModelDetail
              catalog={catalog}
              model={selectedModel}
              upstreamByKey={upstreamByKey}
              busy={busy}
              onEdit={() => {
                // Pin the selection so a reordered catalog keeps showing this model.
                setSelectedRef(selectedModel.ref);
                setEditor({ kind: "model", model: selectedModel });
              }}
              onToggle={(enabled) => void props.onSetModelEnabled(selectedModel.key, enabled)}
              onArchive={() => flow.archiveModel(selectedModel)}
              onAddRoute={() => setEditor({ kind: "route", modelKey: selectedModel.key })}
              onEditRoute={(route) => setEditor({ kind: "route", route })}
              onToggleRoute={(route, enabled) => void props.onSetRouteEnabled(route, enabled)}
              onArchiveRoute={flow.archiveRoute}
            />
          ) : selectedUpstream ? (
            <UpstreamDetail
              catalog={catalog}
              upstream={selectedUpstream}
              busy={busy}
              onEdit={() => {
                setSelectedRef(selectedUpstream.ref);
                setEditor({ kind: "upstream", upstream: selectedUpstream });
              }}
              onToggle={(enabled) =>
                void props.onSetUpstreamEnabled(selectedUpstream.key, enabled)
              }
              onArchive={() => flow.archiveUpstream(selectedUpstream)}
            />
          ) : (
            <p className={`${cardSurface} px-5 py-10 text-center text-[12px] text-text-muted`}>
              Nothing to show. Add a model or an upstream to begin.
            </p>
          )}
        </div>
      </section>
    </ConsoleChrome>
  );
}

function ListRow({
  current,
  enabled,
  title,
  detail,
  count,
  onSelect,
}: {
  current: boolean;
  enabled: boolean;
  title: string;
  detail: string;
  count: number;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        className="flex w-full items-center gap-3 rounded-item px-3 py-2.5 text-left transition-[background] duration-[120ms] hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring aria-current:bg-selected"
        onClick={onSelect}
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${enabled ? "bg-success-foreground" : "bg-text-faint"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium">{title}</span>
          <span className="block truncate font-mono text-[10px] text-text-muted">{detail}</span>
        </span>
        <span className="font-mono text-[10px] text-text-faint" aria-label={`${count} 条路由`}>
          {count}
        </span>
      </button>
    </li>
  );
}

function DetailEyebrow({ children }: { children: string }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">{children}</p>
  );
}

type RouteHandlers = Pick<
  Parameters<typeof RouteTrack>[0],
  "onAddRoute" | "onEditRoute" | "onToggleRoute" | "onArchiveRoute"
>;

function ModelDetail({
  catalog,
  model,
  upstreamByKey,
  busy,
  onEdit,
  onToggle,
  onArchive,
  ...routeHandlers
}: {
  catalog: ModelAdminCatalog;
  model: ModelAdminChatModel;
  upstreamByKey: Map<string, ModelAdminUpstream>;
  busy: boolean;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onArchive: () => void;
} & RouteHandlers) {
  return (
    <article className={`${cardSurface} overflow-hidden`}>
      <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
        <div className="min-w-0">
          <DetailEyebrow>Chat model</DetailEyebrow>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-[18px] font-semibold tracking-[-0.02em]">{model.label}</h2>
            <StatusBadge enabled={model.enabled} onLabel="模型上线" offLabel="模型下线" />
          </div>
          <p className="mt-1 break-all font-mono text-[11px] text-text-muted">{model.key}</p>
          <ModelCapabilities model={model} />
        </div>
        <DetailActions
          kind="模型"
          name={model.label}
          enabled={model.enabled}
          busy={busy}
          onArchive={onArchive}
          onEdit={onEdit}
          onToggle={onToggle}
        />
      </div>
      <RouteTrack
        model={model}
        routes={routesOfModel(catalog, model)}
        upstreamByKey={upstreamByKey}
        databaseEnabled={catalog.database_enabled}
        busy={busy}
        {...routeHandlers}
      />
    </article>
  );
}

function UpstreamDetail({
  catalog,
  upstream,
  busy,
  onEdit,
  onToggle,
  onArchive,
}: {
  catalog: ModelAdminCatalog;
  upstream: ModelAdminUpstream;
  busy: boolean;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onArchive: () => void;
}) {
  const routes = routesOfUpstream(catalog, upstream);
  const models = new Map(catalog.models.map((model) => [model.ref, model]));
  return (
    <article className={`${cardSurface} overflow-hidden`}>
      <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-sunken text-text-muted">
            <Server size={18} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <DetailEyebrow>Model upstream</DetailEyebrow>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-[18px] font-semibold tracking-[-0.02em]">{upstream.label}</h2>
              <StatusBadge enabled={upstream.enabled} onLabel="上游上线" offLabel="上游下线" />
            </div>
            <p className="mt-1 break-all font-mono text-[11px] text-text-muted">{upstream.key}</p>
          </div>
        </div>
        <DetailActions
          kind="上游"
          name={upstream.label}
          enabled={upstream.enabled}
          busy={busy}
          onArchive={onArchive}
          onEdit={onEdit}
          onToggle={onToggle}
        />
      </div>
      <div className="mx-5 mb-5 min-w-0 rounded-control border border-border bg-sunken px-3 py-2.5 sm:mx-6">
        <p className="break-all font-mono text-[10.5px] text-text-primary">{upstream.base_url}</p>
        <div className="mt-2 flex items-center justify-between gap-3 font-mono text-[9.5px] text-text-muted">
          <span className="rounded-pill bg-surface px-2 py-0.5">{upstream.adapter}</span>
          <span className="flex items-center gap-1">
            <KeyRound size={10} aria-hidden="true" />
            {upstream.api_key_hint}
          </span>
        </div>
      </div>
      <div className="border-t border-border bg-sunken/60 px-5 py-4 sm:px-6">
        <h3 className="mb-2 text-[12px] font-medium">
          引用该上游的路由
          <span className="ml-2 font-mono text-[10px] text-text-faint">{routes.length}</span>
        </h3>
        {routes.length ? (
          <ul className="divide-y divide-border">
            {routes.map((route) => {
              const model = models.get(route.model_ref);
              return (
                <li key={route.ref} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium">{model?.label ?? route.model_key}</p>
                    <p className="break-all font-mono text-[10px] text-text-muted">
                      {route.upstream_model} · P{route.priority}
                    </p>
                  </div>
                  <span
                    className={`rounded-pill px-2 py-0.5 font-mono text-[9.5px] ${
                      route.selected
                        ? "bg-[#e8efff] text-[#2557d6]"
                        : "bg-neutral-soft text-neutral-foreground"
                    }`}
                  >
                    {model
                      ? routeStatusText(route, model, upstream, catalog.database_enabled)
                      : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[11.5px] text-text-muted">
            No unarchived route uses this upstream, so it can be archived.
          </p>
        )}
      </div>
    </article>
  );
}

function DetailActions({
  kind,
  name,
  enabled,
  busy,
  onArchive,
  onEdit,
  onToggle,
}: {
  kind: string;
  name: string;
  enabled: boolean;
  busy: boolean;
  onArchive: () => void;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={`${iconControl} h-9 w-9 border border-border`}
        aria-label={`归档${kind} ${name}`}
        disabled={busy}
        onClick={onArchive}
      >
        <Archive size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`${iconControl} h-9 w-9 border border-border`}
        aria-label={`编辑${kind} ${name}`}
        disabled={busy}
        onClick={onEdit}
      >
        <Pencil size={14} aria-hidden="true" />
      </button>
      <StatusSwitch checked={enabled} disabled={busy} label={name} onChange={onToggle} />
    </div>
  );
}

type Confirmation = "catalog" | "import-environment" | null;

type ConsoleChromeProps = Pick<
  ModelAdminDashboardProps,
  | "catalog"
  | "busyAction"
  | "notice"
  | "onLock"
  | "onRefresh"
  | "onSetCatalogEnabled"
  | "onImportEnvironment"
> & {
  children: ReactNode;
  overlays?: ReactNode;
};

// Header, notice, and runtime-source card shared by every console layout.
function ConsoleChrome({
  catalog,
  busyAction,
  notice,
  onLock,
  onRefresh,
  onSetCatalogEnabled,
  onImportEnvironment,
  children,
  overlays,
}: ConsoleChromeProps) {
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const busy = busyAction !== null;
  const activeRouteCount = catalog.routes.filter((route) => route.enabled).length;
  const selectedRouteCount = catalog.routes.filter((route) => route.selected).length;

  const confirmAction = () => {
    const current = confirmation;
    setConfirmation(null);
    if (current === "catalog") {
      void onSetCatalogEnabled(!catalog.database_enabled);
    } else if (current === "import-environment") {
      void onImportEnvironment();
    }
  };

  return (
    <main className="min-h-dvh bg-canvas text-text-primary">
      <header className="border-b border-border bg-surface/95">
        <div className="mx-auto flex min-h-[72px] max-w-[1280px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-[#edf2ff] text-[#2557d6]">
              <RouteIcon size={20} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[17px] font-semibold tracking-[-0.02em]">
                  模型路由控制台
                </h1>
                <StatusBadge
                  enabled={catalog.database_enabled}
                  onLabel="数据库目录生效中"
                  offLabel="ENV 目录生效中"
                />
              </div>
              <p className="mt-0.5 truncate font-mono text-[10.5px] text-text-muted">
                models → routes → upstream adapters
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {busy ? (
              <span className="mr-1 flex items-center gap-1.5 text-[11.5px] text-text-muted" role="status">
                <LoaderCircle
                  size={14}
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                正在更新
              </span>
            ) : null}
            <button
              type="button"
              className={`${buttonControl} h-9 gap-2 px-3 text-[12px]`}
              aria-label="从 ENV 导入模型配置"
              disabled={busy}
              onClick={() => setConfirmation("import-environment")}
            >
              <Download size={15} aria-hidden="true" />
              <span className="hidden sm:inline">导入 ENV</span>
            </button>
            <button
              type="button"
              className={`${iconControl} h-9 w-9`}
              aria-label="刷新模型目录"
              disabled={busy}
              onClick={() => void onRefresh()}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${iconControl} h-9 w-9`}
              aria-label="锁定模型管理控制台"
              disabled={busy}
              onClick={onLock}
            >
              <LockKeyhole size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {notice ? (
          <InlineStatus tone={notice.tone} className="mb-5">
            {notice.text}
          </InlineStatus>
        ) : null}

        <section
          className={`${cardSurface} overflow-hidden border-border-strong bg-[linear-gradient(135deg,#ffffff_0%,#fbfcff_70%,#f1f5ff_100%)]`}
          aria-labelledby="catalog-state-title"
        >
          <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:p-6">
            <div>
              <div className="flex items-center gap-2 text-[#2557d6]">
                <Database size={17} strokeWidth={1.8} aria-hidden="true" />
                <p className="font-mono text-[10.5px] uppercase tracking-[0.16em]">
                  Runtime source
                </p>
              </div>
              <h2 id="catalog-state-title" className="mt-2 text-[20px] font-semibold tracking-[-0.025em]">
                {catalog.database_enabled ? "数据库配置正在服务新 Run" : "当前仍由 ENV 配置服务"}
              </h2>
              <p className="mt-1 max-w-[720px] text-[12.5px] leading-[1.65] text-text-muted">
                {catalog.database_enabled
                  ? "All new model resolutions use the first eligible route shown below. Existing runs keep their saved route snapshots."
                  : "Prepare and verify database routes below, then activate them in one step. Existing ENV behavior remains unchanged until activation."}
              </p>
            </div>
            <button
              type="button"
              className={`${catalog.database_enabled ? buttonControl : primaryButton} h-10 min-w-[156px] px-4 text-[12.5px] font-medium ${catalog.database_enabled ? "border border-border-strong" : ""}`}
              disabled={busy}
              onClick={() => setConfirmation("catalog")}
            >
              {catalog.database_enabled ? "切回 ENV 目录" : "启用数据库目录"}
            </button>
          </div>
          <div className="grid grid-cols-2 border-t border-border bg-surface/70 sm:grid-cols-4">
            <Metric label="逻辑模型" value={catalog.models.length} />
            <Metric label="模型上游" value={catalog.upstreams.length} />
            <Metric label="上线的路由" value={activeRouteCount} />
            <Metric label="首选路径" value={selectedRouteCount} />
          </div>
        </section>

        {children}
      </div>

      {overlays}

      {confirmation ? (
        <ConfirmDialog
          title={confirmation === "catalog" ? "切换运行时模型目录？" : "从 ENV 导入配置？"}
          body={
            confirmation === "catalog"
              ? catalog.database_enabled
                ? "New requests will immediately use the legacy ENV catalog. Existing runs keep their saved route snapshots."
                : "Activation validates enabled routes and credentials, then new requests immediately use the database catalog."
              : "Matching database records and encrypted upstream credentials will be updated. The active catalog source will not change."
          }
          confirmLabel={
            confirmation === "catalog"
              ? catalog.database_enabled
                ? "切回 ENV"
                : "启用数据库目录"
              : "确认导入"
          }
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmAction}
        />
      ) : null}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r border-border px-4 py-3.5 last:border-r-0 sm:px-5">
      <p className="font-mono text-[18px] font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-[10.5px] text-text-muted">{label}</p>
    </div>
  );
}

function ModelCapabilities({ model }: { model: ModelAdminChatModel }) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      <CapabilityPill icon={<BrainCircuit size={12} aria-hidden="true" />}>
        {model.thinking_levels.length
          ? model.thinking_levels.join(" · ")
          : "no reasoning control"}
      </CapabilityPill>
      {model.supports_image_input ? (
        <CapabilityPill icon={<ImageIcon size={12} aria-hidden="true" />}>
          vision · {model.image_token_reserve} tokens
        </CapabilityPill>
      ) : null}
      <CapabilityPill>{model.token_profile} tokens</CapabilityPill>
      <CapabilityPill>order {model.sort_order}</CapabilityPill>
    </div>
  );
}

type RouteTrackProps = {
  model: ModelAdminChatModel;
  routes: ModelAdminRoute[];
  upstreamByKey: Map<string, ModelAdminUpstream>;
  databaseEnabled: boolean;
  busy: boolean;
  onAddRoute: () => void;
  onEditRoute: (route: ModelAdminRoute) => void;
  onToggleRoute: (route: ModelAdminRoute, enabled: boolean) => void;
  onArchiveRoute?: (route: ModelAdminRoute) => void;
};

function RouteTrack({
  model,
  routes,
  upstreamByKey,
  databaseEnabled,
  busy,
  onAddRoute,
  onEditRoute,
  onToggleRoute,
  onArchiveRoute,
}: RouteTrackProps) {
  return (
    <div className="border-t border-border bg-sunken/60 px-5 py-4 sm:px-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <RouteIcon size={14} className="text-text-muted" aria-hidden="true" />
          <h4 className="text-[12px] font-medium">路由轨道</h4>
          <span className="font-mono text-[10px] text-text-faint">{routes.length}</span>
        </div>
        <button
          type="button"
          className={`${buttonControl} h-8 gap-1.5 px-2.5 text-[11.5px]`}
          disabled={busy || !upstreamByKey.size}
          onClick={onAddRoute}
        >
          <Plus size={13} aria-hidden="true" />
          添加路由
        </button>
      </div>

      {routes.length ? (
        <div className="relative ml-1 border-l border-[#cfd7e9] pl-5">
          {routes.map((route) => {
            const upstream = upstreamByKey.get(route.upstream_key);
            const routeAvailable = model.enabled && route.enabled && Boolean(upstream?.enabled);
            const statusText = routeStatusText(route, model, upstream, databaseEnabled);
            return (
              <div
                key={`${route.upstream_key}:${route.upstream_model}`}
                className="relative border-b border-border py-3 last:border-b-0"
              >
                <span
                  aria-hidden="true"
                  className={`absolute -left-[25px] top-[19px] h-2.5 w-2.5 rounded-full border-2 border-sunken ${
                    route.selected
                      ? "bg-[#2557d6] shadow-[0_0_0_3px_rgba(37,87,214,0.14)]"
                      : routeAvailable
                        ? "bg-success-foreground"
                        : "bg-text-faint"
                  }`}
                />
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[12.5px] font-medium">
                        {upstream?.label ?? route.upstream_key}
                      </p>
                      <span
                        className={`rounded-pill px-2 py-0.5 font-mono text-[9.5px] ${
                          route.selected
                            ? "bg-[#e8efff] text-[#2557d6]"
                            : "bg-neutral-soft text-neutral-foreground"
                        }`}
                      >
                        {statusText}
                      </span>
                      <span className="font-mono text-[9.5px] text-text-faint">
                        P{route.priority}
                      </span>
                    </div>
                    <p className="mt-1 break-all font-mono text-[10.5px] text-text-muted">
                      {route.upstream_model}
                    </p>
                    <p className="mt-0.5 font-mono text-[9.5px] text-text-faint">
                      {route.upstream_key} · {upstream?.adapter ?? "missing upstream"}
                    </p>
                    <p className="mt-1 font-mono text-[9.5px] text-text-muted">
                      推理输出：
                      {route.reasoning_outputs?.length
                        ? route.reasoning_outputs.join(" · ")
                        : "none"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {onArchiveRoute ? (
                      <button
                        type="button"
                        className={`${iconControl} h-8 w-8`}
                        aria-label={`归档路由 ${route.upstream_model}`}
                        disabled={busy}
                        onClick={() => onArchiveRoute(route)}
                      >
                        <Archive size={13} aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`${iconControl} h-8 w-8`}
                      aria-label={`编辑路由 ${route.upstream_model}`}
                      disabled={busy}
                      onClick={() => onEditRoute(route)}
                    >
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                    <StatusSwitch
                      compact
                      checked={route.enabled}
                      disabled={busy}
                      label={`${model.label} 到 ${upstream?.label ?? route.upstream_key} 的路由`}
                      onChange={(enabled) => onToggleRoute(route, enabled)}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-control border border-dashed border-border-strong bg-surface px-3 py-4 text-center text-[11.5px] text-text-muted">
          No route configured. This model cannot serve requests from the database catalog.
        </p>
      )}
    </div>
  );
}

function StatusSwitch({
  checked,
  disabled,
  label,
  compact = false,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  compact?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${checked ? "下线" : "上线"}：${label}`}
      disabled={disabled}
      className={`relative inline-flex shrink-0 items-center rounded-pill border transition-[background,border-color] duration-[120ms] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${
        compact ? "h-6 w-10" : "h-7 w-12"
      } ${checked ? "border-success-border bg-success-soft" : "border-border-strong bg-sunken"}`}
      onClick={() => onChange(!checked)}
    >
      <span
        aria-hidden="true"
        className={`block rounded-full transition-[transform,background] duration-[120ms] motion-reduce:transition-none ${
          compact ? "h-4 w-4" : "h-5 w-5"
        } ${
          checked
            ? `${compact ? "translate-x-[19px]" : "translate-x-[25px]"} bg-success-foreground`
            : "translate-x-[3px] bg-text-faint"
        }`}
      />
    </button>
  );
}

function StatusBadge({
  enabled,
  onLabel,
  offLabel,
}: {
  enabled: boolean;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 text-[9.5px] ${
        enabled
          ? "border-success-border bg-success-soft text-success-foreground"
          : "border-neutral-border bg-neutral-soft text-neutral-foreground"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-success-foreground" : "bg-text-faint"}`} />
      {enabled ? onLabel : offLabel}
    </span>
  );
}

function CapabilityPill({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill border border-border bg-sunken px-2 py-1 font-mono text-[9.5px] text-text-muted">
      {icon}
      {children}
    </span>
  );
}

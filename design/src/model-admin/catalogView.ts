import type {
  ModelAdminCatalog,
  ModelAdminChatModel,
  ModelAdminRoute,
  ModelAdminUpstream,
} from "../api/modelAdmin";

export function compareRoutes(left: ModelAdminRoute, right: ModelAdminRoute): number {
  return (
    left.priority - right.priority ||
    left.upstream_key.localeCompare(right.upstream_key) ||
    left.upstream_model.localeCompare(right.upstream_model)
  );
}

// The active catalog is what the current console shows; archived rows are
// shown only by proposals that know about them.
export function activeCatalog(catalog: ModelAdminCatalog): ModelAdminCatalog {
  return {
    ...catalog,
    models: catalog.models.filter((model) => !model.archived),
    upstreams: catalog.upstreams.filter((upstream) => !upstream.archived),
    routes: catalog.routes.filter((route) => !route.archived),
  };
}

export function matchesQuery(
  item: ModelAdminChatModel | ModelAdminUpstream,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${item.label} ${item.key}`.toLowerCase().includes(needle);
}

export function routesOfModel(
  catalog: ModelAdminCatalog,
  model: ModelAdminChatModel,
): ModelAdminRoute[] {
  return catalog.routes
    .filter((route) => route.model_ref === model.ref && !route.archived)
    .sort(compareRoutes);
}

export function routesOfUpstream(
  catalog: ModelAdminCatalog,
  upstream: ModelAdminUpstream,
): ModelAdminRoute[] {
  return catalog.routes
    .filter((route) => route.upstream_ref === upstream.ref && !route.archived)
    .sort(compareRoutes);
}

export type ArchivedEntry =
  | { kind: "model"; ref: string; title: string; detail: string; model: ModelAdminChatModel }
  | { kind: "upstream"; ref: string; title: string; detail: string }
  | { kind: "route"; ref: string; title: string; detail: string };

export function archivedEntries(catalog: ModelAdminCatalog): ArchivedEntry[] {
  const models = new Map(catalog.models.map((model) => [model.ref, model]));
  return [
    ...catalog.models
      .filter((model) => model.archived)
      .map((model): ArchivedEntry => ({
        kind: "model",
        ref: model.ref,
        title: model.label,
        detail: model.key,
        model,
      })),
    ...catalog.upstreams
      .filter((upstream) => upstream.archived)
      .map((upstream): ArchivedEntry => ({
        kind: "upstream",
        ref: upstream.ref,
        title: upstream.label,
        detail: `${upstream.key} · ${upstream.adapter}`,
      })),
    ...catalog.routes
      // Routes archived with their model come back through the model.
      .filter(
        (route) =>
          route.archived && route.archived_at !== models.get(route.model_ref)?.archived_at,
      )
      .map((route): ArchivedEntry => ({
        kind: "route",
        ref: route.ref,
        title: route.upstream_model,
        detail: `${route.model_key} → ${route.upstream_key}`,
      })),
  ];
}

// Restoring a model brings back the routes archived with it (same archived_at)
// whose upstream is still active.
export function modelRestorePreview(catalog: ModelAdminCatalog, model: ModelAdminChatModel) {
  const activeUpstreams = new Set(
    catalog.upstreams.filter((upstream) => !upstream.archived).map((u) => u.ref),
  );
  const routes = catalog.routes.filter(
    (route) =>
      route.model_ref === model.ref && route.archived_at === model.archived_at,
  );
  const restorable = routes.filter((route) => activeUpstreams.has(route.upstream_ref));
  return { restorable: restorable.length, blocked: routes.length - restorable.length };
}

export function routeStatusText(
  route: ModelAdminRoute,
  model: ModelAdminChatModel,
  upstream: ModelAdminUpstream | undefined,
  databaseEnabled: boolean,
): string {
  return route.selected
    ? databaseEnabled
      ? "当前路由"
      : "目录首选"
    : !route.enabled
      ? "路由下线"
      : !upstream?.enabled
        ? "上游下线"
        : !model.enabled
          ? "模型下线"
          : "候选路由";
}

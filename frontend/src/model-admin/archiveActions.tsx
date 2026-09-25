import { useState } from "react";

import type {
  ModelAdminCatalog,
  ModelAdminChatModel,
  ModelAdminRoute,
  ModelAdminUpstream,
  ModelRouteIdentity,
} from "../api/modelAdmin";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import {
  modelRestorePreview,
  routesOfModel,
  routesOfUpstream,
  type ArchivedEntry,
} from "./catalogView";

export type ArchiveHandlers = {
  onArchiveModel: (modelKey: string) => Promise<boolean>;
  onArchiveUpstream: (upstreamKey: string) => Promise<boolean>;
  onArchiveRoute: (route: ModelRouteIdentity) => Promise<boolean>;
  onRestore: (ref: string) => Promise<boolean>;
};

type Pending =
  | { kind: "model"; model: ModelAdminChatModel }
  | { kind: "upstream"; upstream: ModelAdminUpstream }
  | { kind: "route"; route: ModelAdminRoute }
  | { kind: "restore"; entry: ArchivedEntry };

// One confirmation flow for archive and restore, shared by every proposal so
// the copy and cascade counts stay identical across layouts.
export function useArchiveFlow(catalog: ModelAdminCatalog, handlers: ArchiveHandlers) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = () => {
    const current = pending;
    setPending(null);
    if (!current) return;
    if (current.kind === "model") void handlers.onArchiveModel(current.model.key);
    else if (current.kind === "upstream") void handlers.onArchiveUpstream(current.upstream.key);
    else if (current.kind === "route") void handlers.onArchiveRoute(current.route);
    else void handlers.onRestore(current.entry.ref);
  };

  const dialog = pending ? (
    <ConfirmDialog
      {...dialogCopy(catalog, pending)}
      destructive={pending.kind !== "restore"}
      onCancel={() => setPending(null)}
      onConfirm={confirm}
    />
  ) : null;

  return {
    dialog,
    archiveModel: (model: ModelAdminChatModel) => setPending({ kind: "model", model }),
    archiveUpstream: (upstream: ModelAdminUpstream) =>
      setPending({ kind: "upstream", upstream }),
    archiveRoute: (route: ModelAdminRoute) => setPending({ kind: "route", route }),
    restore: (entry: ArchivedEntry) => setPending({ kind: "restore", entry }),
  };
}

function dialogCopy(catalog: ModelAdminCatalog, pending: Pending) {
  if (pending.kind === "model") {
    const routes = routesOfModel(catalog, pending.model).length;
    return {
      title: `归档模型「${pending.model.label}」？`,
      body: `The model and its ${routes} ${routes === 1 ? "route" : "routes"} leave the catalog immediately. Running Runs are not affected. Restore it later from 已归档.`,
      confirmLabel: "归档模型",
    };
  }
  if (pending.kind === "upstream") {
    const routes = routesOfUpstream(catalog, pending.upstream).length;
    return {
      title: `归档上游「${pending.upstream.label}」？`,
      body: routes
        ? `${routes} unarchived ${routes === 1 ? "route still uses" : "routes still use"} this upstream, so the server will refuse. Archive those routes or their models first.`
        : "The upstream leaves the catalog and its key can be reused. Running Runs keep their saved credentials. Restore it later from 已归档.",
      confirmLabel: "归档上游",
    };
  }
  if (pending.kind === "route") {
    return {
      title: "归档这条路由？",
      body: `${pending.route.model_key} → ${pending.route.upstream_key} → ${pending.route.upstream_model} leaves the route track. Running Runs are not affected.`,
      confirmLabel: "归档路由",
    };
  }
  const entry = pending.entry;
  if (entry.kind === "model") {
    const { restorable, blocked } = modelRestorePreview(catalog, entry.model);
    const taken = catalog.models.some(
      (model) => model.key === entry.model.key && !model.archived,
    );
    return {
      title: `恢复模型「${entry.title}」？`,
      body: taken
        ? `An active model already uses the key ${entry.model.key}, so the server will refuse. Archive the active model first.`
        : `${restorable} ${restorable === 1 ? "route" : "routes"} archived with it will return.${
            blocked
              ? ` ${blocked} ${blocked === 1 ? "route stays" : "routes stay"} archived because its upstream is archived.`
              : ""
          }`,
      confirmLabel: "恢复",
    };
  }
  return {
    title: `恢复「${entry.title}」？`,
    body:
      entry.kind === "route"
        ? "The route returns to its model's track. Its model and upstream must be active."
        : "Restoring fails if an active upstream already uses this key.",
    confirmLabel: "恢复",
  };
}

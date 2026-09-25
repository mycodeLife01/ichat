import { ApiError } from "../api/errors";
import type {
  ConversationDetailResponse,
  PublicShareResponse,
  ShareLinkResponse,
  UserShareResponse,
} from "../api/types";
import type {
  ModelAdminCatalog,
  ModelRouteIdentity,
  UpsertChatModelRequest,
  UpsertModelUpstreamRequest,
  UpsertModelRouteRequest,
} from "../api/modelAdmin";
import {
  catalog as initialCatalog,
  denseCatalog,
  fixedDate,
  user as initialUser,
} from "../scenarios/data";
import type { Scene } from "../scenarios/registry";
import { createOutcomes } from "./outcomes";
export function createResults(
  scene: Scene,
  getConversations: () => ConversationDetailResponse[],
) {
  const outcomes = createOutcomes(scene);
  const resources = new Map<string, string>();
  const ownedUrls = new Set<string>();
  const snapshotKey = "piko-design.shared-snapshots.v1";
  const persistSnapshot = (
    token: string,
    value: PublicShareResponse | null,
  ) => {
    const saved = JSON.parse(localStorage.getItem(snapshotKey) ?? "{}");
    if (value) saved[token] = value;
    else delete saved[token];
    localStorage.setItem(snapshotKey, JSON.stringify(saved));
  };
  const objectUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    ownedUrls.add(url);
    return url;
  };
  let user = { ...initialUser, email_verified: scene.id !== "unverified" };
  const sceneCatalog = scene.id === "admin-dense" ? denseCatalog : initialCatalog;
  let catalog: ModelAdminCatalog = structuredClone(sceneCatalog);
  let shares: UserShareResponse[] =
    scene.id === "share-dialog"
      ? []
      : [
          {
            token: "design-share",
            created_at: fixedDate,
            expires_at: null,
            revoked_at: null,
            conversation_id: "design-chat",
            conversation_title: "从设计到实现",
          },
        ];
  const snapshots = new Map<string, PublicShareResponse>();
  function snapshot(id: string): PublicShareResponse {
    const conversation =
      getConversations().find((c) => c.id === id) ?? getConversations()[0];
    return {
      title: conversation.title,
      created_at: fixedDate,
      messages: conversation.messages.map((m) => ({
        role: m.role,
        content: m.content,
        sources: m.metadata?.sources ?? [],
        attachments: m.attachments?.map((a, i) => ({
          ...a,
          ref: `sample-${i}`,
        })),
        reply_quote: m.reply_quote
          ? {
              excerpt: m.reply_quote.excerpt,
              source_message_index: 1,
              source_anchor: m.reply_quote.source_anchor,
            }
          : null,
      })),
    };
  }
  snapshots.set("design-share", snapshot("design-chat"));
  const command = (name: string, token?: string) => {
    if (token === "invalid")
      return Promise.reject(new ApiError({ status: 400 }));
    return outcomes.run(name, { status: "ok" });
  };
  const commit = (name: string, change: () => void) =>
    outcomes.run(name, () => {
      change();
      return structuredClone(catalog);
    });
  const archiveTime = () => new Date().toISOString();
  const conflict = (detail: string) => new ApiError({ status: 409, detail });
  const activeModel = (key: string) => {
    const model = catalog.models.find((m) => m.key === key && !m.archived);
    if (!model) throw new ApiError({ status: 422, detail: "Chat model does not exist" });
    return model;
  };
  const activeUpstream = (key: string) => {
    const upstream = catalog.upstreams.find((u) => u.key === key && !u.archived);
    if (!upstream)
      throw new ApiError({ status: 422, detail: "Model upstream does not exist" });
    return upstream;
  };
  const restore = (ref: string) => {
    const model = catalog.models.find((m) => m.ref === ref);
    const upstream = catalog.upstreams.find((u) => u.ref === ref);
    const route = catalog.routes.find((r) => r.ref === ref);
    const item = model ?? upstream ?? route;
    if (!item?.archived) throw conflict("Catalog item is not archived");
    if (model) {
      if (catalog.models.some((m) => m.key === model.key && !m.archived))
        throw conflict("An active chat model with the same key already exists");
      const activeUpstreams = new Set(
        catalog.upstreams.filter((u) => !u.archived).map((u) => u.ref),
      );
      catalog.models = catalog.models.map((m) =>
        m === model ? { ...m, archived: false, archived_at: null } : m,
      );
      catalog.routes = catalog.routes.map((r) =>
        r.model_ref === model.ref &&
        r.archived_at === model.archived_at &&
        activeUpstreams.has(r.upstream_ref)
          ? { ...r, archived: false, archived_at: null }
          : r,
      );
    } else if (upstream) {
      if (catalog.upstreams.some((u) => u.key === upstream.key && !u.archived))
        throw conflict("An active model upstream with the same key already exists");
      catalog.upstreams = catalog.upstreams.map((u) =>
        u === upstream ? { ...u, archived: false, archived_at: null } : u,
      );
    } else if (route) {
      const parents = [
        catalog.models.find((m) => m.ref === route.model_ref),
        catalog.upstreams.find((u) => u.ref === route.upstream_ref),
      ];
      if (parents.some((parent) => parent?.archived !== false))
        throw conflict("Restore the route's chat model and upstream before the route");
      if (catalog.routes.some((r) => r !== route && sameRoute(r, route) && !r.archived))
        throw conflict("An active model route with the same target already exists");
      catalog.routes = catalog.routes.map((r) =>
        r === route ? { ...r, archived: false, archived_at: null } : r,
      );
    }
  };
  return {
    outcomes,
    registerFile(id: string, blob: Blob) {
      const url = objectUrl(blob);
      resources.set(id, url);
      return url;
    },
    dispose() {
      for (const url of ownedUrls) URL.revokeObjectURL(url);
      ownedUrls.clear();
    },
    authApi: {
      me: async () => user,
      login: async (body: { identifier: string; password: string }) =>
        outcomes.run("login", () => ({ ...user, username: body.identifier })),
      register: async (body: {
        username: string;
        nickname: string;
        email: string;
        password: string;
      }) =>
        outcomes.run("register", () => {
          user = { ...user, ...body, email_verified: false };
          return user;
        }),
      verifyEmail: (token: string) => command("verifyEmail", token),
      resendVerificationEmail: () => command("resendVerificationEmail"),
      requestPasswordReset: (_email: string) => command("requestPasswordReset"),
      resetPassword: (token: string, _password: string) =>
        command("resetPassword", token),
      confirmAccountDeletion: (token: string) =>
        command("confirmAccountDeletion", token),
      requestAccountDeletion: (_password: string) =>
        command("requestAccountDeletion"),
      changePassword: (_current: string, _next: string) =>
        command("changePassword"),
      updateProfile: (nickname: string) =>
        outcomes.run("profile", () => {
          user = { ...user, nickname };
          return user;
        }),
      uploadAvatar: (blob: Blob) =>
        outcomes.run("avatar", () => objectUrl(blob)),
    },
    filesApi: {
      readUrl: async (id: string, _role?: string) => ({
        url:
          resources.get(id) ??
          (id === "image" ? "/assets/landscape.svg" : "/assets/document.txt"),
      }),
    },
    shareApi: {
      list: (id: string) =>
        outcomes.run(
          "share-list",
          shares.filter((s) => s.conversation_id === id),
        ),
      listMine: () => outcomes.run("shares", shares),
      create: (id: string, days: number | null, _attachments?: boolean) =>
        outcomes.run("share-create", () => {
          const existing = shares.find((s) => s.conversation_id === id);
          if (existing) return existing;
          const token = `design-share-${shares.length + 1}`;
          const row: UserShareResponse = {
            token,
            created_at: fixedDate,
            expires_at: days
              ? new Date(
                  new Date(fixedDate).getTime() + days * 86400000,
                ).toISOString()
              : null,
            revoked_at: null,
            conversation_id: id,
            conversation_title:
              getConversations().find((c) => c.id === id)?.title ?? null,
          };
          shares = [...shares, row];
          snapshots.set(token, structuredClone(snapshot(id)));
          persistSnapshot(token, snapshots.get(token)!);
          return row as ShareLinkResponse;
        }),
      revoke: (id: string, token: string) =>
        outcomes.run("share-revoke", () => {
          shares = shares.filter(
            (s) => !(s.conversation_id === id && s.token === token),
          );
          snapshots.delete(token);
          persistSnapshot(token, null);
          return { status: "ok" };
        }),
      getPublic: (token: string) =>
        outcomes.run("share-read", () => {
          const result =
            snapshots.get(token) ??
            JSON.parse(localStorage.getItem(snapshotKey) ?? "{}")[token];
          if (!result) throw new ApiError({ status: 404 });
          return structuredClone(result);
        }),
      readAttachment: async (_token: string, ref: string, _role: string) => ({
        url:
          ref === "sample-0" ? "/assets/landscape.svg" : "/assets/document.txt",
      }),
    },
    modelAdminApi: {
      getCatalog: (key: string) =>
        key === "invalid"
          ? Promise.reject(new ApiError({ status: 401 }))
          : outcomes.run("catalog", () => structuredClone(catalog), {
              initial: true,
            }),
      upsertModel: (_key: string, key: string, body: UpsertChatModelRequest) =>
        commit("save-model", () => {
          const existing = catalog.models.find((m) => m.key === key && !m.archived);
          catalog.models = [
            ...catalog.models.filter((m) => m !== existing),
            {
              ref: existing?.ref ?? nextRef(catalog.models, "model"),
              key,
              ...body,
              archived: false,
              archived_at: null,
            },
          ];
        }),
      setModelEnabled: (_key: string, key: string, enabled: boolean) =>
        commit("toggle-model", () => {
          catalog.models = catalog.models.map((m) =>
            m.key === key && !m.archived ? { ...m, enabled } : m,
          );
        }),
      upsertUpstream: (
        _key: string,
        key: string,
        body: UpsertModelUpstreamRequest,
      ) =>
        commit("save-upstream", () => {
          const { api_key: _secret, ...display } = body;
          const existing = catalog.upstreams.find((u) => u.key === key && !u.archived);
          catalog.upstreams = [
            ...catalog.upstreams.filter((u) => u !== existing),
            {
              ref: existing?.ref ?? nextRef(catalog.upstreams, "upstream"),
              key,
              ...display,
              api_key_hint: "demo…only",
              archived: false,
              archived_at: null,
            },
          ];
        }),
      setUpstreamEnabled: (_key: string, key: string, enabled: boolean) =>
        commit("toggle-upstream", () => {
          catalog.upstreams = catalog.upstreams.map((m) =>
            m.key === key && !m.archived ? { ...m, enabled } : m,
          );
        }),
      upsertRoute: (_key: string, body: UpsertModelRouteRequest) =>
        commit("save-route", () => {
          const existing = catalog.routes.find((r) => sameRoute(r, body) && !r.archived);
          catalog.routes = [
            ...catalog.routes.filter((r) => r !== existing),
            {
              ...body,
              ref: existing?.ref ?? nextRef(catalog.routes, "route"),
              model_ref: activeModel(body.model_key).ref,
              upstream_ref: activeUpstream(body.upstream_key).ref,
              archived: false,
              archived_at: null,
              selected: false,
            },
          ];
        }),
      setRouteEnabled: (
        _key: string,
        route: ModelRouteIdentity,
        enabled: boolean,
      ) =>
        commit("toggle-route", () => {
          catalog.routes = catalog.routes.map((r) =>
            sameRoute(r, route) && !r.archived ? { ...r, enabled } : r,
          );
        }),
      setCatalogEnabled: (_key: string, enabled: boolean) =>
        commit("toggle-catalog", () => {
          catalog.database_enabled = enabled;
        }),
      importEnvironment: (_key: string) =>
        commit("import", () => {
          catalog = structuredClone(sceneCatalog);
        }),
      // Local mirror of the backend archive rules; conflicts surface as 409.
      archiveModel: (_key: string, key: string) =>
        commit("archive-model", () => {
          const model = activeModel(key);
          // Cascaded routes share the model's archived_at, as on the server.
          const archived_at = archiveTime();
          catalog.models = catalog.models.map((m) =>
            m === model ? { ...m, archived: true, archived_at } : m,
          );
          catalog.routes = catalog.routes.map((r) =>
            r.model_ref === model.ref && !r.archived
              ? { ...r, archived: true, archived_at, selected: false }
              : r,
          );
        }),
      archiveUpstream: (_key: string, key: string) =>
        commit("archive-upstream", () => {
          const upstream = activeUpstream(key);
          const blocking = catalog.routes.filter(
            (r) => r.upstream_ref === upstream.ref && !r.archived,
          );
          if (blocking.length)
            throw new ApiError({
              status: 409,
              detail: `Model upstream is still used by unarchived routes: ${blocking
                .map((r) => `${r.model_key} -> ${r.upstream_key} -> ${r.upstream_model}`)
                .join(", ")}`,
            });
          catalog.upstreams = catalog.upstreams.map((u) =>
            u === upstream ? { ...u, archived: true, archived_at: archiveTime() } : u,
          );
        }),
      archiveRoute: (_key: string, route: ModelRouteIdentity) =>
        commit("archive-route", () => {
          catalog.routes = catalog.routes.map((r) =>
            sameRoute(r, route) && !r.archived
              ? { ...r, archived: true, archived_at: archiveTime(), selected: false }
              : r,
          );
        }),
      restoreArchived: (_key: string, ref: string) =>
        commit("restore", () => restore(ref)),
    },
  };
}
function nextRef(items: { ref: string }[], kind: string) {
  const ids = items.map((item) => Number(item.ref.split("-").pop()) || 0);
  return `${kind}-${Math.max(0, ...ids) + 1}`;
}
function sameRoute(a: ModelRouteIdentity, b: ModelRouteIdentity) {
  return (
    a.model_key === b.model_key &&
    a.upstream_key === b.upstream_key &&
    a.upstream_model === b.upstream_model
  );
}
export type DesignResults = ReturnType<typeof createResults>;

import { LoaderCircle, X } from "lucide-react";
import {
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import type {
  ModelAdminChatModel,
  ModelAdminRoute,
  ModelAdminUpstream,
  ModelProviderAdapter,
  ModelReasoningOutput,
  ModelThinkingLevel,
  ModelTokenProfile,
  UpsertChatModelRequest,
  UpsertModelRouteRequest,
  UpsertModelUpstreamRequest,
} from "../api/modelAdmin";
import { buttonControl, iconControl, inputControl, primaryButton } from "../ui/classes";
import { ModalDialog } from "../ui/ModalDialog";

export type ModelAdminEditor =
  | { kind: "model"; model?: ModelAdminChatModel }
  | { kind: "upstream"; upstream?: ModelAdminUpstream }
  | { kind: "route"; route?: ModelAdminRoute; modelKey?: string };

type ModelAdminEditorDialogProps = {
  editor: ModelAdminEditor;
  models: ModelAdminChatModel[];
  upstreams: ModelAdminUpstream[];
  onClose: () => void;
  onSaveModel: (modelKey: string, body: UpsertChatModelRequest) => Promise<boolean>;
  onSaveUpstream: (
    upstreamKey: string,
    body: UpsertModelUpstreamRequest,
  ) => Promise<boolean>;
  onSaveRoute: (body: UpsertModelRouteRequest) => Promise<boolean>;
};

export function ModelAdminEditorDialog(props: ModelAdminEditorDialogProps) {
  if (props.editor.kind === "model") {
    return <ModelEditorDialog {...props} editor={props.editor} />;
  }
  if (props.editor.kind === "upstream") {
    return <UpstreamEditorDialog {...props} editor={props.editor} />;
  }
  return <RouteEditorDialog {...props} editor={props.editor} />;
}

type EditorProps<EditorT extends ModelAdminEditor> = Omit<
  ModelAdminEditorDialogProps,
  "editor"
> & { editor: EditorT };

const thinkingLevels: ModelThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
const reasoningOutputs: ModelReasoningOutput[] = ["raw", "summary"];
const adapterReasoningOutputs: Record<
  ModelProviderAdapter,
  readonly ModelReasoningOutput[]
> = {
  deepseek: ["raw"],
  openai: [],
  openrouter: ["raw", "summary"],
};

function ModelEditorDialog({
  editor,
  onClose,
  onSaveModel,
}: EditorProps<Extract<ModelAdminEditor, { kind: "model" }>>) {
  const model = editor.model;
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  const [supportsImage, setSupportsImage] = useState(model?.supports_image_input ?? false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body: UpsertChatModelRequest = {
      label: stringValue(data, "label"),
      thinking_levels: data.getAll("thinking_levels") as ModelThinkingLevel[],
      supports_image_input: supportsImage,
      image_token_reserve: supportsImage ? numberValue(data, "image_token_reserve") : null,
      token_profile: stringValue(data, "token_profile") as ModelTokenProfile,
      sort_order: numberValue(data, "sort_order"),
      enabled: data.has("enabled"),
    };
    setSaving(true);
    try {
      if (await onSaveModel(stringValue(data, "key"), body)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorShell
      titleId={titleId}
      title={model ? "编辑聊天模型" : "添加聊天模型"}
      saving={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="模型标识" htmlFor="model-key" helper="Stable key exposed to clients.">
          <input
            id="model-key"
            name="key"
            className={`${inputControl} h-10 w-full px-3 font-mono text-[12.5px]`}
            defaultValue={model?.key ?? ""}
            pattern="[A-Za-z0-9][A-Za-z0-9._/-]{0,127}"
            required
            readOnly={Boolean(model)}
            disabled={saving}
          />
        </Field>
        <Field label="显示名称" htmlFor="model-label">
          <input
            id="model-label"
            name="label"
            className={`${inputControl} h-10 w-full px-3 text-[13px]`}
            defaultValue={model?.label ?? ""}
            maxLength={128}
            required
            disabled={saving}
          />
        </Field>
        <Field label="Token 计数配置" htmlFor="model-token-profile">
          <select
            id="model-token-profile"
            name="token_profile"
            className={`${inputControl} h-10 w-full px-3 text-[13px]`}
            defaultValue={model?.token_profile ?? "default"}
            disabled={saving}
          >
            <option value="default">default</option>
            <option value="deepseek">deepseek</option>
            <option value="openai">openai</option>
          </select>
        </Field>
        <Field label="排序" htmlFor="model-sort-order" helper="Lower values appear first.">
          <input
            id="model-sort-order"
            name="sort_order"
            type="number"
            min={0}
            step={1}
            className={`${inputControl} h-10 w-full px-3 font-mono text-[13px]`}
            defaultValue={model?.sort_order ?? 100}
            required
            disabled={saving}
          />
        </Field>
      </div>

      <fieldset className="mt-5">
        <legend className="text-[12.5px] font-medium">可选思考等级</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {thinkingLevels.map((level) => (
            <label
              key={level}
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded-control border border-border bg-sunken px-3 font-mono text-[11.5px] has-[:checked]:border-[#9db4ed] has-[:checked]:bg-[#edf2ff]"
            >
              <input
                type="checkbox"
                name="thinking_levels"
                value={level}
                defaultChecked={model?.thinking_levels.includes(level) ?? false}
                disabled={saving}
                className="accent-[#2557d6]"
              />
              {level}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5 grid gap-3 rounded-card border border-border bg-sunken p-4 sm:grid-cols-2">
        <CheckField
          name="supports_image_input"
          label="支持图像输入"
          checked={supportsImage}
          disabled={saving}
          onChange={setSupportsImage}
        />
        <Field
          label="图像 Token 预留"
          htmlFor="model-image-token-reserve"
          helper="Required only for vision models."
        >
          <input
            id="model-image-token-reserve"
            name="image_token_reserve"
            type="number"
            min={1}
            step={1}
            className={`${inputControl} h-10 w-full px-3 font-mono text-[13px]`}
            defaultValue={model?.image_token_reserve ?? 8192}
            required={supportsImage}
            disabled={!supportsImage || saving}
          />
        </Field>
      </div>

      <CheckField
        name="enabled"
        label="保存后上线"
        defaultChecked={model?.enabled ?? false}
        disabled={saving}
        className="mt-5"
      />
    </EditorShell>
  );
}

function UpstreamEditorDialog({
  editor,
  onClose,
  onSaveUpstream,
}: EditorProps<Extract<ModelAdminEditor, { kind: "upstream" }>>) {
  const upstream = editor.upstream;
  const titleId = useId();
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const apiKey = stringValue(data, "api_key");
    const body: UpsertModelUpstreamRequest = {
      label: stringValue(data, "label"),
      adapter: stringValue(data, "adapter") as ModelProviderAdapter,
      base_url: stringValue(data, "base_url"),
      enabled: data.has("enabled"),
      ...(apiKey ? { api_key: apiKey } : {}),
    };
    setSaving(true);
    try {
      if (await onSaveUpstream(stringValue(data, "key"), body)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorShell
      titleId={titleId}
      title={upstream ? "编辑模型上游" : "添加模型上游"}
      saving={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="上游标识" htmlFor="upstream-key" helper="Stable internal route target.">
          <input
            id="upstream-key"
            name="key"
            className={`${inputControl} h-10 w-full px-3 font-mono text-[12.5px]`}
            defaultValue={upstream?.key ?? ""}
            pattern="[A-Za-z0-9][A-Za-z0-9._/-]{0,127}"
            required
            readOnly={Boolean(upstream)}
            disabled={saving}
          />
        </Field>
        <Field label="显示名称" htmlFor="upstream-label">
          <input
            id="upstream-label"
            name="label"
            className={`${inputControl} h-10 w-full px-3 text-[13px]`}
            defaultValue={upstream?.label ?? ""}
            maxLength={128}
            required
            disabled={saving}
          />
        </Field>
        <Field label="Provider 适配器" htmlFor="upstream-adapter">
          <select
            id="upstream-adapter"
            name="adapter"
            className={`${inputControl} h-10 w-full px-3 font-mono text-[12.5px]`}
            defaultValue={upstream?.adapter ?? "openai"}
            disabled={saving}
          >
            <option value="deepseek">deepseek</option>
            <option value="openai">openai</option>
            <option value="openrouter">openrouter</option>
          </select>
        </Field>
        <Field
          label="API Key"
          htmlFor="upstream-api-key"
          helper={
            upstream
              ? `Leave blank to keep ${upstream.api_key_hint}.`
              : "Stored encrypted; never returned by the API."
          }
        >
          <input
            id="upstream-api-key"
            name="api_key"
            type="password"
            autoComplete="new-password"
            className={`${inputControl} h-10 w-full px-3 font-mono text-[12.5px]`}
            required={!upstream}
            disabled={saving}
          />
        </Field>
      </div>

      <Field label="Base URL" htmlFor="upstream-base-url" className="mt-4">
        <input
          id="upstream-base-url"
          name="base_url"
          type="url"
          className={`${inputControl} h-10 w-full px-3 font-mono text-[12.5px]`}
          defaultValue={upstream?.base_url ?? ""}
          placeholder="https://api.example.com/v1"
          maxLength={2048}
          required
          disabled={saving}
        />
      </Field>

      <CheckField
        name="enabled"
        label="保存后上线"
        defaultChecked={upstream?.enabled ?? false}
        disabled={saving}
        className="mt-5"
      />
    </EditorShell>
  );
}

function RouteEditorDialog({
  editor,
  models,
  upstreams,
  onClose,
  onSaveRoute,
}: EditorProps<Extract<ModelAdminEditor, { kind: "route" }>>) {
  const route = editor.route;
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  const initialUpstreamKey = route?.upstream_key ?? upstreams[0]?.key ?? "";
  const [upstreamKey, setUpstreamKey] = useState(initialUpstreamKey);
  const initialAdapter =
    upstreams.find((upstream) => upstream.key === initialUpstreamKey)?.adapter ?? "openai";
  const [selectedReasoningOutputs, setSelectedReasoningOutputs] = useState<
    ModelReasoningOutput[]
  >(
    route?.reasoning_outputs ??
      (initialAdapter === "deepseek" || initialAdapter === "openrouter" ? ["raw"] : []),
  );
  const selectedAdapter =
    upstreams.find((upstream) => upstream.key === upstreamKey)?.adapter ?? "openai";
  const allowedReasoningOutputs = adapterReasoningOutputs[selectedAdapter];

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body: UpsertModelRouteRequest = {
      model_key: route?.model_key ?? stringValue(data, "model_key"),
      upstream_key: route?.upstream_key ?? upstreamKey,
      upstream_model: route?.upstream_model ?? stringValue(data, "upstream_model"),
      reasoning_outputs: selectedReasoningOutputs,
      priority: numberValue(data, "priority"),
      enabled: data.has("enabled"),
    };
    setSaving(true);
    try {
      if (await onSaveRoute(body)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorShell
      titleId={titleId}
      title={route ? "编辑模型路由" : "添加模型路由"}
      saving={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {route ? (
        <p className="mb-4 rounded-control border border-neutral-border bg-neutral-soft px-3 py-2 text-[11.5px] leading-[1.55] text-neutral-foreground">
          Route identity is immutable. Edit priority here, or disable this route and add another.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="聊天模型" htmlFor="route-model-key">
          <select
            id="route-model-key"
            name="model_key"
            className={`${inputControl} h-10 w-full px-3 font-mono text-[12.5px]`}
            defaultValue={route?.model_key ?? editor.modelKey ?? models[0]?.key}
            disabled={Boolean(route) || saving}
            required
          >
            {models.map((model) => (
              <option key={model.key} value={model.key}>
                {model.label} · {model.key}
              </option>
            ))}
          </select>
        </Field>
        <Field label="模型上游" htmlFor="route-upstream-key">
          <select
            id="route-upstream-key"
            name="upstream_key"
            className={`${inputControl} h-10 w-full px-3 font-mono text-[12.5px]`}
            value={upstreamKey}
            disabled={Boolean(route) || saving}
            required
            onChange={(event) => {
              const nextKey = event.target.value;
              const nextAdapter =
                upstreams.find((upstream) => upstream.key === nextKey)?.adapter ?? "openai";
              const nextAllowed = adapterReasoningOutputs[nextAdapter];
              setUpstreamKey(nextKey);
              setSelectedReasoningOutputs((current) => {
                const retained = current.filter((output) => nextAllowed.includes(output));
                if (retained.length > 0 || nextAllowed.length === 0) return retained;
                return ["raw"];
              });
            }}
          >
            {upstreams.map((upstream) => (
              <option key={upstream.key} value={upstream.key}>
                {upstream.label} · {upstream.adapter}
              </option>
            ))}
          </select>
        </Field>
        <Field label="上游 Model ID" htmlFor="route-upstream-model">
          <input
            id="route-upstream-model"
            name="upstream_model"
            className={`${inputControl} h-10 w-full px-3 font-mono text-[12.5px]`}
            defaultValue={route?.upstream_model ?? ""}
            maxLength={256}
            required
            disabled={Boolean(route) || saving}
          />
        </Field>
        <Field label="优先级" htmlFor="route-priority" helper="Lower values win.">
          <input
            id="route-priority"
            name="priority"
            type="number"
            min={0}
            step={1}
            className={`${inputControl} h-10 w-full px-3 font-mono text-[13px]`}
            defaultValue={route?.priority ?? 100}
            required
            disabled={saving}
          />
        </Field>
      </div>

      <fieldset className="mt-5 rounded-card border border-border bg-sunken p-4">
        <legend className="px-1 text-[12.5px] font-medium">推理输出</legend>
        <p className="mt-1 text-[10.5px] leading-[1.45] text-text-muted">
          描述该路由实际返回的可见推理类型；与模型的思考强度控制相互独立。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {reasoningOutputs.map((output) => {
            const supported = allowedReasoningOutputs.includes(output);
            const checked = selectedReasoningOutputs.includes(output);
            return (
              <label
                key={output}
                className="flex min-h-9 items-center gap-2 rounded-control border border-border bg-surface px-3 font-mono text-[11.5px] has-[:checked]:border-[#9db4ed] has-[:checked]:bg-[#edf2ff] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-45"
              >
                <input
                  type="checkbox"
                  name="reasoning_outputs"
                  value={output}
                  checked={checked}
                  disabled={saving || !supported}
                  onChange={(event) => {
                    setSelectedReasoningOutputs((current) =>
                      event.target.checked
                        ? [...current, output]
                        : current.filter((item) => item !== output),
                    );
                  }}
                  className="accent-[#2557d6]"
                />
                {output}
              </label>
            );
          })}
          {allowedReasoningOutputs.length === 0 ? (
            <span className="self-center text-[11px] text-text-muted">
              当前 Adapter 不声明可见推理输出
            </span>
          ) : null}
        </div>
      </fieldset>

      <CheckField
        name="enabled"
        label="保存后上线"
        defaultChecked={route?.enabled ?? false}
        disabled={saving}
        className="mt-5"
      />
    </EditorShell>
  );
}

type EditorShellProps = {
  titleId: string;
  title: string;
  saving: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
};

function EditorShell({
  titleId,
  title,
  saving,
  onClose,
  onSubmit,
  children,
}: EditorShellProps) {
  return (
    <ModalDialog
      titleId={titleId}
      onClose={() => {
        if (!saving) onClose();
      }}
      className="max-h-[calc(100dvh-32px)] w-full max-w-[640px] overflow-y-auto p-5 sm:p-6"
      backdropClassName="z-50 p-4"
    >
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.015em]">
          {title}
        </h2>
        <button
          type="button"
          className={`${iconControl} h-9 w-9`}
          aria-label="关闭"
          disabled={saving}
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <form onSubmit={onSubmit}>
        {children}
        <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            className={`${buttonControl} h-10 px-4 text-[13px]`}
            disabled={saving}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className={`${primaryButton} h-10 gap-2 px-4 text-[13px] font-medium`}
            disabled={saving}
            aria-busy={saving}
          >
            {saving ? (
              <LoaderCircle
                size={15}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {saving ? "正在保存" : "保存配置"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

type FieldProps = {
  label: string;
  htmlFor: string;
  helper?: string;
  className?: string;
  children: ReactNode;
};

function Field({ label, htmlFor, helper, className = "", children }: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-text-primary">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {helper ? (
        <p className="mt-1 text-[10.5px] leading-[1.45] text-text-muted">{helper}</p>
      ) : null}
    </div>
  );
}

type CheckFieldProps = {
  name: string;
  label: string;
  defaultChecked?: boolean;
  checked?: boolean;
  disabled?: boolean;
  className?: string;
  onChange?: (checked: boolean) => void;
};

function CheckField({
  name,
  label,
  defaultChecked,
  checked,
  disabled,
  className = "",
  onChange,
}: CheckFieldProps) {
  return (
    <label className={`flex min-h-10 items-center gap-2.5 text-[12.5px] ${className}`.trim()}>
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked === undefined ? defaultChecked : undefined}
        checked={checked}
        disabled={disabled}
        onChange={onChange ? (event) => onChange(event.target.checked) : undefined}
        className="h-4 w-4 accent-[#2557d6]"
      />
      <span>{label}</span>
    </label>
  );
}

function stringValue(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value : "";
}

function numberValue(data: FormData, key: string): number {
  return Number(stringValue(data, key));
}

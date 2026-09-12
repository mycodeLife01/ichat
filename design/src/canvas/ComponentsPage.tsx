import { useState } from "react";
import { Icons } from "../ui/icons";
import { Avatar } from "../ui/Avatar";
import { InlineStatus } from "../ui/InlineStatus";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { BottomSheet } from "../ui/BottomSheet";
import { Wordmark } from "../ui/Wordmark";
import {
  primaryButton,
  buttonControl,
  inputControl,
  iconControl,
} from "../ui/classes";
export function ComponentsPage() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  return (
    <main className="mx-auto max-w-[960px] space-y-10 p-8 text-text-primary">
      <Wordmark />
      <h1 className="text-2xl">组件与样式</h1>
      <section className="space-y-4">
        <h2>颜色与表面</h2>
        <div className="flex flex-wrap gap-4">
          {[
            "canvas",
            "sidebar",
            "surface",
            "sunken",
            "hover",
            "selected",
            "text-primary",
            "text-muted",
            "border",
            "accent",
          ].map((token) => (
            <div key={token}>
              <div
                style={{ background: `var(--color-${token})` }}
                className="h-16 w-20 rounded-control border border-border"
              />
              <code className="text-xs">{token}</code>
            </div>
          ))}
        </div>
      </section>
      <section className="space-y-4">
        <h2>按钮与输入</h2>
        <div className="flex flex-wrap gap-3">
          <button className={`${primaryButton} px-4 py-2`}>主要操作</button>
          <button className={`${buttonControl} px-4 py-2`}>普通操作</button>
          <button disabled className={`${primaryButton} px-4 py-2`}>
            不可用
          </button>
          <button aria-label="新建对话" className={`${iconControl} h-9 w-9`}>
            <Icons.NewChat />
          </button>
          <input
            aria-label="示例输入"
            className={`${inputControl} px-3 py-2`}
            placeholder="输入内容"
          />
        </div>
      </section>
      <section className="space-y-3">
        <h2>状态反馈</h2>
        {(["neutral", "success", "warning", "error"] as const).map((tone) => (
          <InlineStatus key={tone} tone={tone}>
            {tone} · 示例状态说明
          </InlineStatus>
        ))}
      </section>
      <section className="flex items-center gap-4">
        <Avatar name="设计体验" className="h-10 w-10" />
        <button
          className={`${buttonControl} px-4 py-2`}
          onClick={() => setDialog(true)}
        >
          打开确认弹窗
        </button>
        <button
          className={`${buttonControl} px-4 py-2`}
          onClick={() => setSheet(true)}
        >
          打开底部面板
        </button>
      </section>
      {dialog && (
        <ConfirmDialog
          title="确认操作？"
          body="此处用于查看布局、焦点与关闭行为。"
          confirmLabel="确认"
          onConfirm={() => setDialog(false)}
          onCancel={() => setDialog(false)}
        />
      )}
      <BottomSheet
        ariaLabel="操作"
        open={sheet}
        onClose={() => setSheet(false)}
      >
        <button
          className={`${buttonControl} w-full p-4`}
          onClick={() => setSheet(false)}
        >
          完成
        </button>
      </BottomSheet>
    </main>
  );
}

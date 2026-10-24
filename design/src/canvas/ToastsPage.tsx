import { useDesignActions } from "../runtime/context";
import { buttonControl, toastSurface } from "../ui/classes";
import type { ToastTone } from "../ui/state";
import { toastPresentations } from "../ui/toastPresentations";

type ToastCase = {
  scene: string;
  message: string;
  source: string;
  // Introduced by a candidate proposal rather than shipped in frontend/.
  proposal?: string;
};

// Inventory of every toast frontend/ raises, grouped by tone. Sources are the
// frontend files that call the toast; keep this list in step with them.
const inventory: { tone: ToastTone; title: string; cases: ToastCase[] }[] = [
  {
    tone: "success",
    title: "成功",
    cases: [
      { scene: "会话 · 置顶", message: "已置顶", source: "Sidebar / ThreadActions" },
      { scene: "会话 · 取消置顶", message: "已取消置顶", source: "Sidebar / ThreadActions" },
      { scene: "会话 · 收藏", message: "已加入收藏", source: "Sidebar / ThreadActions" },
      { scene: "会话 · 取消收藏", message: "已取消收藏", source: "Sidebar / ThreadActions" },
      { scene: "分享 · 快速分享", message: "公开链接已复制到剪贴板", source: "useQuickShare" },
      { scene: "分享 · 创建链接", message: "已创建分享链接", source: "ShareDialog" },
      { scene: "分享 · 复制链接", message: "链接已复制", source: "ShareDialog, MySharesCard" },
      { scene: "分享 · 撤销链接", message: "已撤销分享", source: "ShareDialog, MySharesCard" },
      { scene: "账号 · 修改昵称", message: "昵称已更新", source: "AccountCard" },
      { scene: "账号 · 更换头像", message: "头像已更新", source: "AccountCard" },
      { scene: "账号 · 重发验证邮件", message: "验证邮件已发送", source: "AccountCard" },
      { scene: "验证横幅 · 重发邮件", message: "Verification email sent. Check your inbox.", source: "VerifyEmailBanner" },
    ],
  },
  {
    tone: "warning",
    title: "提醒",
    cases: [
      { scene: "会话 · 置顶已达上限", message: "最多置顶 10 个对话", source: "Sidebar / ThreadActions" },
      { scene: "会话 · 链接失效", message: "会话 ID 无效或已失效，已回到新对话", source: "useConversationLoader" },
      { scene: "输入框 · 上传图片（当前模型不支持）", message: "Switch to a vision model before uploading images.", source: "AppShell" },
      { scene: "输入框 · 上传图片（无可用视觉模型）", message: "No compatible vision model is currently available.", source: "AppShell" },
      { scene: "账号 · 未验证邮箱上传头像", message: "Verify your email before uploading an avatar.", source: "AccountCard" },
    ],
  },
  {
    tone: "error",
    title: "失败",
    cases: [
      { scene: "对话 · 发送消息", message: "发送失败，请重试", source: "useSendMessage" },
      { scene: "对话 · 发送图片（当前模型不支持）", message: "Switch to a vision model before sending images.", source: "useSendMessage" },
      { scene: "对话 · 需要视觉模型", message: "This conversation requires a compatible vision model.", source: "useSendMessage" },
      { scene: "对话 · 原图片消息需升级", message: "Upgrade the original image message with a vision model first.", source: "useSendMessage" },
      { scene: "对话 · 重新生成", message: "操作失败，请重试", source: "useRegenerate" },
      { scene: "对话 · 停止生成", message: "停止失败，请重试", source: "useRunStream" },
      { scene: "对话 · 引用的回复已不存在", message: "The quoted reply is no longer available.", source: "AppShell" },
      { scene: "搜索 · 结果内容已变化", message: "原搜索内容已变化，已打开对应对话。", source: "AppShell" },
      { scene: "搜索 · 无法打开结果", message: "无法打开这段对话，请重新搜索后再试。", source: "AppShell" },
      { scene: "分享 · 加载链接", message: "加载分享链接失败", source: "ShareDialog" },
      { scene: "分享 · 创建链接", message: "创建分享失败", source: "ShareDialog, useQuickShare" },
      { scene: "分享 · 复制链接", message: "复制失败", source: "ShareDialog, MySharesCard, useQuickShare" },
      { scene: "分享 · 撤销链接", message: "撤销失败", source: "ShareDialog, MySharesCard" },
      { scene: "分享 · 加载我的分享", message: "分享列表加载失败", source: "MySharesCard" },
      { scene: "账号 · 修改昵称", message: "Failed to save nickname. Please try again.", source: "AccountCard" },
      { scene: "账号 · 重发验证邮件（限流）", message: "Too many requests. Please try again later.", source: "AccountCard" },
      { scene: "账号 · 重发验证邮件", message: "Failed to send the verification email. Please try again.", source: "AccountCard" },
      { scene: "账号 · 更换头像", message: "（透传上传接口返回的错误信息）", source: "AccountCard" },
      { scene: "验证横幅 · 重发邮件（限流）", message: "Please try again later.", source: "VerifyEmailBanner" },
      { scene: "验证横幅 · 重发邮件", message: "Could not send the email. Try again.", source: "VerifyEmailBanner" },
    ],
  },
  { tone: "neutral", title: "中性", cases: [] },
];

function ToastSample({ tone, message }: { tone: ToastTone; message: string }) {
  const { Icon, classes } = toastPresentations[tone];
  // Same surface as the live toast, rendered in flow instead of fixed.
  return (
    <div className={`toast inline-flex max-w-full ${toastSurface} ${classes}`} data-tone={tone}>
      <Icon className="shrink-0" size={15} strokeWidth={1.9} aria-hidden="true" />
      <span className="min-w-0">{message}</span>
    </div>
  );
}

export function ToastsPage() {
  const { dispatch } = useDesignActions();
  const total = inventory.reduce((sum, group) => sum + group.cases.length, 0);
  return (
    <main className="mx-auto max-w-[1080px] space-y-10 p-8 text-text-primary max-[760px]:p-4">
      <header className="space-y-2">
        <h1 className="text-2xl">Toast 反馈汇总</h1>
        <p className="text-[13.5px] text-text-muted">
          共 {total} 个操作场景。来源为 frontend/ 中触发该 toast 的文件；“候选”标记表示仅存在于设计提案中。点击“触发”查看真实弹出效果。
        </p>
      </header>
      {inventory.map((group) => (
        <section key={group.tone} className="space-y-3" aria-labelledby={`toast-${group.tone}`}>
          <div className="flex items-center gap-3">
            <h2 id={`toast-${group.tone}`} className="text-[16px]">
              {group.title}
            </h2>
            <ToastSample tone={group.tone} message={`${group.cases.length} 个场景`} />
          </div>
          {group.cases.length === 0 ? (
            <p className="text-[13px] text-text-muted">前端当前没有使用中性 toast。</p>
          ) : (
            <div className="overflow-x-auto rounded-control border border-border">
              <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
                <thead className="bg-sunken text-text-muted">
                  <tr>
                    <th className="px-3 py-2 font-normal">操作场景</th>
                    <th className="px-3 py-2 font-normal">反馈</th>
                    <th className="px-3 py-2 font-normal">来源</th>
                    <th className="w-[72px] px-3 py-2 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {group.cases.map((item) => (
                    <tr key={`${item.scene}-${item.message}`} className="border-t border-border align-middle">
                      <td className="px-3 py-2.5">
                        {item.scene}
                        {item.proposal && (
                          <span className="ml-2 rounded-full border border-border px-1.5 py-px text-[11px] text-text-muted">
                            候选 · {item.proposal}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <ToastSample tone={group.tone} message={item.message} />
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[12px] text-text-muted">{item.source}</td>
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          className={`${buttonControl} px-2.5 py-1 text-[12.5px]`}
                          aria-label={`触发：${item.message}`}
                          onClick={() =>
                            dispatch({ type: "ui/showToast", message: item.message, tone: group.tone })
                          }
                        >
                          触发
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </main>
  );
}

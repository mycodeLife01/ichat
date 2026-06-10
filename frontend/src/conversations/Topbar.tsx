import { iconBtn, titleSkeleton } from "../ui/classes";
import { Icons } from "../ui/icons";

type TopbarProps = {
  title: string | null;
  titlePending: boolean;
  isMobile: boolean;
  sidebarCollapsed: boolean;
  onOpenMobile: () => void;
  onToggleSidebar: () => void;
  onNewMobile: () => void;
};

const topbarTitle = "flex-1 truncate text-sm";

export function Topbar({
  title,
  titlePending,
  isMobile,
  sidebarCollapsed,
  onOpenMobile,
  onToggleSidebar,
  onNewMobile,
}: TopbarProps) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-bg px-5 max-[760px]:px-3">
      {isMobile ? (
        <button className={iconBtn} aria-label="打开历史" onClick={onOpenMobile}>
          <Icons.Menu size={16} />
        </button>
      ) : sidebarCollapsed ? (
        <button className={iconBtn} aria-label="展开侧栏" onClick={onToggleSidebar}>
          <Icons.PanelLeft size={15} />
        </button>
      ) : null}

      {titlePending ? (
        <span className={`${topbarTitle} font-normal text-fg-subtle`}>
          <span className={titleSkeleton} style={{ width: 120, verticalAlign: "middle" }} />
        </span>
      ) : (
        <span
          className={`${topbarTitle}${title ? " font-medium text-fg" : " font-normal text-fg-subtle"}`}
        >
          {title || "新对话"}
        </span>
      )}

      {isMobile && (
        <button className={iconBtn} aria-label="新建对话" onClick={onNewMobile}>
          <Icons.Plus size={16} />
        </button>
      )}
    </header>
  );
}

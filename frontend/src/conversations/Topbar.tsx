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
    <header className="topbar">
      {isMobile ? (
        <button className="icon-btn" aria-label="打开历史" onClick={onOpenMobile}>
          <Icons.Menu size={16} />
        </button>
      ) : sidebarCollapsed ? (
        <button className="icon-btn" aria-label="展开侧栏" onClick={onToggleSidebar}>
          <Icons.PanelLeft size={15} />
        </button>
      ) : null}

      {titlePending ? (
        <span className="title muted">
          <span className="title-skeleton" style={{ width: 120, verticalAlign: "middle" }} />
        </span>
      ) : (
        <span className={`title${title ? "" : " muted"}`}>{title || "新对话"}</span>
      )}

      {isMobile && (
        <button className="icon-btn" aria-label="新建对话" onClick={onNewMobile}>
          <Icons.Plus size={16} />
        </button>
      )}
    </header>
  );
}

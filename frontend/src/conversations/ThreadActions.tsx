import { useEffect, useRef, useState } from "react";

import { dangerMenuItem, iconControl, neutralMenuItem, popoverSurface } from "../ui/classes";
import { Icons } from "../ui/icons";

type ThreadActionsProps = {
  isMobile: boolean;
  // Share and delete need a materialized conversation; the blank new chat only
  // keeps the mobile navigation controls.
  hasConversation: boolean;
  onOpenMobileSidebar: () => void;
  onNew: () => void;
  onShare: () => void;
  onDelete: () => void;
};

// The chat page has no header row: these controls float over the top of the
// thread so the reading column keeps the full height.
const floatingControl = `${iconControl} pointer-events-auto bg-bg/85 backdrop-blur-[2px]`;

export function ThreadActions({
  isMobile,
  hasConversation,
  onOpenMobileSidebar,
  onNew,
  onShare,
  onDelete,
}: ThreadActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!menuRootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!hasConversation) setMenuOpen(false);
  }, [hasConversation]);

  const controlSize = isMobile ? "h-11 w-11" : "h-9 w-9";

  return (
    // pointer-events-none on the strip keeps the thread scrollable underneath;
    // every actual control opts back in.
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between px-4 pt-2 max-[760px]:px-2">
      {isMobile ? (
        <button
          className={`${floatingControl} ${controlSize}`}
          aria-label="打开历史"
          onClick={onOpenMobileSidebar}
        >
          <Icons.Menu size={18} />
        </button>
      ) : (
        <span />
      )}

      <div className="flex items-center gap-1">
        {isMobile && (
          <button
            className={`${floatingControl} ${controlSize}`}
            aria-label="新建对话"
            onClick={onNew}
          >
            <Icons.NewChat size={20} />
          </button>
        )}
        {!isMobile && hasConversation && (
          <button
            className={`${floatingControl} ${controlSize}`}
            aria-label="分享"
            onClick={onShare}
          >
            <Icons.Upload size={18} />
          </button>
        )}
        {hasConversation && (
          <div className="relative" ref={menuRootRef}>
            <button
              className={`${floatingControl} ${controlSize}`}
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Icons.More size={18} />
            </button>
            {menuOpen && (
              <div
                className={`pointer-events-auto absolute top-[calc(100%+6px)] right-0 z-40 w-[156px] p-1.5 ${popoverSurface}`}
                role="menu"
                aria-label="对话操作"
              >
                {/* Mobile has no room for a separate share button, so the menu
                    carries it there. */}
                {isMobile && (
                  <button
                    className={neutralMenuItem}
                    role="menuitem"
                    data-variant="neutral"
                    onClick={() => {
                      setMenuOpen(false);
                      onShare();
                    }}
                  >
                    <Icons.Upload size={18} />
                    分享
                  </button>
                )}
                <button
                  className={dangerMenuItem}
                  role="menuitem"
                  data-variant="danger"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                >
                  <Icons.Trash size={18} />
                  删除
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

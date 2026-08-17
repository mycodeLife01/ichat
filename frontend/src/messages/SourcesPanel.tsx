import { useState } from "react";

import type { MessageSource } from "../api/types";
import {
  iconControl,
  interactiveItem,
  sourceMeta,
  sourceTitle,
} from "../ui/classes";
import { Icons } from "../ui/icons";
import { domainOf } from "./sourceUtils";

type SourcesPanelProps = {
  sources: MessageSource[];
  open: boolean;
  isMobile?: boolean;
  onClose: () => void;
};

// Site favicon via Google's favicon service (far more reliable than hitting
// each site's /favicon.ico, which 404s or sits at a non-root path for many
// sites); falls back to a globe glyph when the icon is missing or blocked.
// `key`ed on the domain so switching sources swaps the <img> cleanly while a
// stable domain keeps the same node (no reload / flash on parent re-renders).
export function SourceFavicon({ url, size = 16 }: { url: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const domain = domainOf(url);
  if (failed || !domain) {
    return <Icons.Globe size={size} className="shrink-0 text-text-faint" />;
  }
  return (
    <img
      key={domain}
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-detail"
      onError={() => setFailed(true)}
    />
  );
}

// ChatGPT-style sources panel: a right-hand sidebar on desktop (in-flow flex
// sibling of <main>), a right drawer over a scrim on mobile.
export function SourcesPanel({
  sources,
  open,
  isMobile = false,
  onClose,
}: SourcesPanelProps) {
  const panel = (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between px-4 pt-3.5 pb-2.5">
        <div className={sourceTitle}>
          来源 <span className={sourceMeta}>· {sources.length}</span>
        </div>
        <button
          className={`${iconControl} h-7 w-7 max-[760px]:min-h-11 max-[760px]:min-w-11`}
          type="button"
          aria-label="关闭来源"
          onClick={onClose}
        >
          <Icons.Close size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {sources.map((source) => (
          <a
            key={`${source.id}:${source.url}`}
            className={`${interactiveItem} block px-2 py-2.5 no-underline`}
            href={source.url}
            target="_blank"
            rel="noreferrer"
          >
            <div className={`flex items-center gap-1.5 ${sourceMeta}`}>
              <SourceFavicon url={source.url} size={16} />
              <span className="truncate">{domainOf(source.url)}</span>
            </div>
            <div className={`mt-1 ${sourceTitle}`}>
              {source.title}
            </div>
            {source.snippet && (
              <div className={`mt-0.5 line-clamp-2 ${sourceMeta}`}>
                {source.snippet}
              </div>
            )}
          </a>
        ))}
      </div>
    </div>
  );

  // Both variants stay mounted and animate via the `open` prop (same pattern
  // as the Sidebar): the desktop column transitions its width, the mobile
  // drawer its transform — so opening and closing both get a transition.
  if (isMobile) {
    return (
      <>
        <div
          className={`scrim fixed inset-0 z-[29] bg-overlay transition-opacity duration-200 ${
            open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
          }`}
          onClick={onClose}
          aria-hidden="true"
        />
        <aside
          className={`sources-panel fixed inset-y-0 right-0 z-30 w-[min(86vw,360px)] border-l border-border bg-surface transition-transform duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
            open ? "open translate-x-0" : "translate-x-full"
          }`}
        >
          {panel}
        </aside>
      </>
    );
  }

  return (
    <aside
      className={`sources-panel shrink-0 overflow-hidden bg-canvas transition-[width] duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
        open ? "open w-[340px] border-l border-border" : "w-0"
      }`}
    >
      {/* Fixed inner width so the content doesn't reflow while the column
          width sweeps. */}
      <div className="h-full w-[340px]">{panel}</div>
    </aside>
  );
}

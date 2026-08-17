import type { Ref } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { MessageSource } from "../api/types";
import {
  focusRing,
  iconControl,
  popoverSurface,
  sourceMeta,
  sourceTitle,
} from "../ui/classes";
import { Icons } from "../ui/icons";
import { domainOf, siteName } from "./sourceUtils";
import { SourceFavicon } from "./SourcesPanel";

type CitationProps = {
  // Injected by react-markdown for the custom <citation> element. The marker
  // ids live in properties.citeIds (set by the rehypeCitations plugin).
  node?: { properties?: Record<string, unknown> };
  sources: MessageSource[];
  isMobile?: boolean;
};

const CARD_WIDTH = 320;
const MARGIN = 8;
const EST_HEIGHT = 200;
const CLOSE_DELAY = 120;

type Coords = { left: number; top?: number; bottom?: number };

export function Citation({ node, sources, isMobile = false }: CitationProps) {
  const raw = node?.properties?.citeIds;
  const ids = String(raw ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const cited = ids
    .map((id) => sources.find((s) => s.id === id))
    .filter((s): s is MessageSource => s != null);

  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [coords, setCoords] = useState<Coords>({ left: 0 });
  const chipRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close on outside click / scroll while open (covers mobile tap-to-open, and
  // a fixed card that would otherwise detach from the chip on scroll).
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (chipRef.current?.contains(target) || cardRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  // No resolvable sources: render the original marker text unchanged.
  if (cited.length === 0) {
    return <span>[{ids.join("][")}]</span>;
  }

  const primary = cited[0];
  const extra = cited.length - 1;

  const place = () => {
    const r = chipRef.current?.getBoundingClientRect();
    if (!r) return;
    const cardWidth = Math.min(CARD_WIDTH, window.innerWidth - MARGIN * 2);
    const left = Math.min(
      Math.max(r.left, MARGIN),
      window.innerWidth - cardWidth - MARGIN,
    );
    const above = r.bottom + EST_HEIGHT > window.innerHeight && r.top > EST_HEIGHT;
    setCoords(
      above
        ? { left, bottom: window.innerHeight - r.top + 6 }
        : { left, top: r.bottom + 6 },
    );
  };

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY);
  };

  const openCard = () => {
    setPage(0);
    place();
    setOpen(true);
  };

  return (
    <span className="citation-wrap relative inline-block align-text-bottom">
      <button
        ref={chipRef}
        type="button"
        className={`citation-chip ${focusRing} mx-0.5 inline-flex max-w-[160px] cursor-pointer items-center gap-0.5 rounded-pill border border-border bg-sunken px-1.5 py-px align-middle !whitespace-nowrap transition-colors duration-[120ms] hover:bg-accent hover:text-accent-foreground data-[open=true]:bg-accent data-[open=true]:text-accent-foreground ${sourceMeta}`}
        data-open={open ? "true" : "false"}
        aria-label={`查看 ${cited.length} 个引用来源`}
        onMouseEnter={
          isMobile
            ? undefined
            : () => {
                cancelClose();
                openCard();
              }
        }
        onMouseLeave={isMobile ? undefined : scheduleClose}
        onClick={() => {
          if (open) setOpen(false);
          else openCard();
        }}
      >
        <SourceFavicon url={primary.url} size={12} />
        <span className="truncate">{siteName(primary.url)}</span>
        {extra > 0 && <span className="opacity-70">+{extra}</span>}
      </button>
      {open && (
        <CitationCard
          ref={cardRef}
          sources={cited}
          page={page}
          setPage={setPage}
          coords={coords}
          onMouseEnter={isMobile ? undefined : cancelClose}
          onMouseLeave={isMobile ? undefined : scheduleClose}
        />
      )}
    </span>
  );
}

type CitationCardProps = {
  ref: Ref<HTMLDivElement>;
  sources: MessageSource[];
  page: number;
  setPage: (n: number) => void;
  coords: Coords;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

function CitationCard({
  ref,
  sources,
  page,
  setPage,
  coords,
  onMouseEnter,
  onMouseLeave,
}: CitationCardProps) {
  const total = sources.length;
  const current = sources[Math.min(page, total - 1)];
  const date = current.published_at ? String(current.published_at).slice(0, 10) : null;

  // Portaled to <body>: the card is a block element but the chip lives inside a
  // markdown <p>, where a nested block would be invalid HTML. Fixed positioning
  // keeps it anchored to the chip's viewport coords regardless of DOM parent.
  return createPortal(
    <div
      ref={ref}
      className={`citation-card ${popoverSurface} fixed z-50 w-[calc(100vw-16px)] max-w-[320px] p-3`}
      style={{ left: coords.left, top: coords.top, bottom: coords.bottom }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {total > 1 && (
        <div className={`mb-2 flex items-center justify-between ${sourceMeta}`}>
          <span>
            {page + 1}/{total}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              className={`${iconControl} h-6 w-6`}
              aria-label="上一个来源"
              disabled={page === 0}
              onClick={() => setPage(Math.max(0, page - 1))}
            >
              <Icons.Chevron size={14} className="rotate-90" />
            </button>
            <button
              type="button"
              className={`${iconControl} h-6 w-6`}
              aria-label="下一个来源"
              disabled={page >= total - 1}
              onClick={() => setPage(Math.min(total - 1, page + 1))}
            >
              <Icons.Chevron size={14} className="-rotate-90" />
            </button>
          </span>
        </div>
      )}
      <a
        className={`${focusRing} block rounded-item no-underline`}
        href={current.url}
        target="_blank"
        rel="noreferrer"
      >
        <div className={`flex items-center gap-1.5 ${sourceMeta}`}>
          <SourceFavicon url={current.url} size={16} />
          <span className="truncate">{domainOf(current.url)}</span>
          {date && <span className="ml-auto shrink-0">{date}</span>}
        </div>
        <div className={`mt-1 ${sourceTitle}`}>
          {current.title}
        </div>
        {current.snippet && (
          <div className={`mt-1 line-clamp-4 ${sourceMeta}`}>
            {current.snippet}
          </div>
        )}
      </a>
    </div>,
    document.body,
  );
}

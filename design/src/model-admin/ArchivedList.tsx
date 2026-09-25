import { Archive, ArchiveRestore } from "lucide-react";

import type { ModelAdminCatalog } from "../api/modelAdmin";
import { buttonControl, cardSurface } from "../ui/classes";
import { archivedEntries, type ArchivedEntry } from "./catalogView";

const kindLabel: Record<ArchivedEntry["kind"], string> = {
  model: "模型",
  upstream: "上游",
  route: "路由",
};

export function ArchivedList({
  catalog,
  busy,
  onRestore,
  className = "",
}: {
  catalog: ModelAdminCatalog;
  busy: boolean;
  onRestore: (entry: ArchivedEntry) => void;
  className?: string;
}) {
  const entries = archivedEntries(catalog);
  if (!entries.length) {
    return (
      <p
        className={`rounded-control border border-dashed border-border-strong bg-surface px-3 py-6 text-center text-[11.5px] text-text-muted ${className}`}
      >
        No archived items.
      </p>
    );
  }
  return (
    <ul className={`${cardSurface} divide-y divide-border overflow-hidden ${className}`}>
      {entries.map((entry) => (
        <li
          key={entry.ref}
          aria-label={entry.title}
          className="flex items-center justify-between gap-3 px-4 py-3"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-sunken text-text-faint">
              <Archive size={13} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="break-all text-[12.5px] font-medium">{entry.title}</p>
                <span className="rounded-pill bg-neutral-soft px-2 py-0.5 font-mono text-[9.5px] text-neutral-foreground">
                  {kindLabel[entry.kind]}
                </span>
              </div>
              <p className="mt-0.5 break-all font-mono text-[10px] text-text-muted">
                {entry.detail} · {entry.ref}
              </p>
            </div>
          </div>
          <button
            type="button"
            className={`${buttonControl} h-8 shrink-0 gap-1.5 border border-border-strong px-2.5 text-[11.5px]`}
            disabled={busy}
            onClick={() => onRestore(entry)}
          >
            <ArchiveRestore size={13} aria-hidden="true" />
            恢复
          </button>
        </li>
      ))}
    </ul>
  );
}

import type { ComponentPropsWithoutRef } from "react";
import { useEffect, useRef, useState } from "react";

import { iconControl } from "../../ui/classes";
import { Icons } from "../../ui/icons";
import { copyText } from "./copyText";
import { tableToTsv } from "./tableTsv";

export function TableBlock({ children }: ComponentPropsWithoutRef<"table">) {
  const tableRef = useRef<HTMLTableElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyAttempt = useRef(0);
  const [copyState, setCopyState] = useState<"idle" | "success" | "failure">("idle");

  useEffect(
    () => () => {
      copyAttempt.current += 1;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    if (!tableRef.current) return;
    const attempt = ++copyAttempt.current;
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    const copied = await copyText(tableToTsv(tableRef.current));
    if (attempt !== copyAttempt.current) return;

    if (!copied) {
      setCopyState("failure");
      return;
    }

    setCopyState("success");
    copiedTimer.current = setTimeout(() => setCopyState("idle"), 1500);
  };

  const copied = copyState === "success";

  return (
    <div
      className="table-block table-block-viewport"
      data-table-block
      data-table-viewport
      role="region"
      aria-label="表格（可横向滚动）"
      tabIndex={0}
    >
      <div className="table-block-inner">
        <div className="table-block-header">
          <button
            className={`${iconControl} h-7 w-7 p-1`}
            type="button"
            aria-label={copied ? "已复制表格" : "复制表格"}
            onClick={handleCopy}
          >
            {copied ? <Icons.Check size={20} /> : <Icons.CopyFilled size={20} />}
          </button>
          {copyState === "failure" ? (
            <span className="sr-only" role="status">
              Copy failed. Try again.
            </span>
          ) : null}
        </div>
        <table ref={tableRef}>{children}</table>
      </div>
    </div>
  );
}

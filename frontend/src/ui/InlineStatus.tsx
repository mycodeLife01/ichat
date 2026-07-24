import type { ReactNode } from "react";
import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { statusNotice } from "./classes";

export type InlineStatusTone = "neutral" | "success" | "error" | "warning";

interface InlineStatusProps {
  tone: InlineStatusTone;
  children: ReactNode;
  className?: string;
  id?: string;
}

const presentations = {
  neutral: {
    Icon: Info,
    classes: "border-neutral-border bg-neutral-soft text-neutral-foreground",
  },
  success: {
    Icon: CircleCheck,
    classes: "border-success-border bg-success-soft text-success-foreground",
  },
  error: {
    Icon: CircleAlert,
    classes: "border-error-border bg-error-soft text-error-foreground",
  },
  warning: {
    Icon: TriangleAlert,
    classes: "border-warning-border bg-warning-soft text-warning-foreground",
  },
} satisfies Record<InlineStatusTone, { Icon: LucideIcon; classes: string }>;

export function InlineStatus({ tone, children, className = "", id }: InlineStatusProps) {
  const { Icon, classes } = presentations[tone];
  const role = tone === "error" ? "alert" : "status";

  return (
    <div
      id={id}
      className={`${statusNotice} ${classes} ${className}`.trim()}
      data-tone={tone}
      role={role}
      aria-atomic="true"
    >
      <Icon
        className="mt-px shrink-0"
        data-status-icon={tone}
        size={15}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span>{children}</span>
    </div>
  );
}

import { Search } from "lucide-react";

import { inputControl } from "../ui/classes";

export function SearchField({
  value,
  label,
  onChange,
  className = "",
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{label}</span>
      <Search
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        placeholder={label}
        className={`${inputControl} h-9 w-full pl-9 pr-3 text-[12.5px]`}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className = "",
}: {
  label: string;
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`inline-flex shrink-0 rounded-control border border-border bg-sunken p-0.5 ${className}`}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 text-[12px] transition-[background,color] duration-[120ms] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring ${
            option.value === value
              ? "bg-surface font-medium text-text-primary shadow-[0_1px_2px_rgba(20,20,19,0.08)]"
              : "text-text-muted hover:text-text-primary"
          }`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined ? (
            <span className="font-mono text-[10px] text-text-faint">{option.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

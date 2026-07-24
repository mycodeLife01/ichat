import { LoaderCircle } from "lucide-react";

type LoadingButtonContentProps = {
  loading: boolean;
  label: string;
};

export function LoadingButtonContent({ loading, label }: LoadingButtonContentProps) {
  return (
    <span className="relative inline-flex items-center justify-center">
      <span className={loading ? "opacity-0" : undefined}>{label}</span>
      {loading && (
        <LoaderCircle
          className="absolute animate-spin"
          size={15}
          strokeWidth={1.9}
          aria-hidden="true"
        />
      )}
    </span>
  );
}

import { statusVisual } from "@/lib/statusVisual";

/** A run or step status as a labelled pill. Reused by the run detail page. */
export function StatusBadge({ status }: { status: string }) {
  const { label, className } = statusVisual(status);
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}
    >
      {label}
    </span>
  );
}

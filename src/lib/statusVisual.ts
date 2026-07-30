import type { RunStatus, StepStatus } from "@/lib/types";

/**
 * Run and step statuses share one badge vocabulary because a reader scanning a
 * run does not care which table a value came from — `SUCCEEDED` on a step and
 * `COMPLETED` on a run mean the same thing to them and must look the same.
 */
export type DisplayStatus = RunStatus | StepStatus;

export interface StatusVisual {
  /** Sentence-case label. Raw enum values are shouty and hard to scan. */
  label: string;
  /** Tailwind classes for the badge surface, text, and ring. */
  className: string;
}

const NEUTRAL = "bg-slate-100 text-slate-700 ring-slate-300";

const VISUALS: Record<DisplayStatus, StatusVisual> = {
  PENDING: { label: "Pending", className: NEUTRAL },
  RUNNING: { label: "Running", className: "bg-blue-50 text-blue-700 ring-blue-200" },
  AWAITING_APPROVAL: {
    label: "Awaiting approval",
    className: "bg-amber-50 text-amber-800 ring-amber-300",
  },
  SUCCEEDED: {
    label: "Succeeded",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  COMPLETED: {
    label: "Completed",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  FAILED: { label: "Failed", className: "bg-rose-50 text-rose-700 ring-rose-200" },
  CANCELLED: {
    label: "Cancelled",
    className: "bg-slate-100 text-slate-600 ring-slate-300",
  },
  SKIPPED: {
    label: "Skipped",
    className: "bg-slate-50 text-slate-500 ring-slate-200",
  },
};

/** `AWAITING_APPROVAL` to `Awaiting approval`, for values not in the table. */
function humanise(status: string): string {
  const spaced = status.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Never throws and never returns nothing: an unrecognised status is rendered
 * neutrally rather than dropped, because a badge that disappears when the
 * enum grows hides the very state the reader is looking for.
 */
export function statusVisual(status: string): StatusVisual {
  return (
    VISUALS[status as DisplayStatus] ?? {
      label: status ? humanise(status) : "Unknown",
      className: NEUTRAL,
    }
  );
}

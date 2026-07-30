/** Loading indicators. Skeletons mirror the real rows' height and padding so arriving data
 *  does not make the list jump, and each is announced rather than silent. */

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600 ${className}`}
    />
  );
}

export function InlineLoading({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-sm text-slate-500"
    >
      <Spinner />
      {label}
    </div>
  );
}

/** Placeholder list rows: two text lines and a badge, in a bordered card. */
export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex animate-pulse items-center justify-between p-4">
          <div className="w-full space-y-2">
            <div className="h-4 w-1/3 rounded bg-slate-200" />
            <div className="h-3 w-1/4 rounded bg-slate-100" />
          </div>
          <div className="h-5 w-20 shrink-0 rounded-full bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

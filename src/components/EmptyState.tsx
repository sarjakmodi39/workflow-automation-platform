import type { ReactNode } from "react";

/** A deliberate empty state: what is missing and what to do. An empty list rendered as
 *  nothing is indistinguishable from a bug, so every list here renders this instead. */
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white/60 p-6 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {children ? (
        <div className="mx-auto mt-1 max-w-prose text-sm text-slate-500">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A shell command a reader is expected to run, styled to be copyable by eye. */
export function Command({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">
      {children}
    </code>
  );
}

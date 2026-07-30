import type { ReactNode } from "react";

/** A titled block. One layout for every section so the pages read the same. */
export function Section({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {aside}
      </div>
      {description ? (
        <p className="mt-1 max-w-prose text-sm text-slate-600">{description}</p>
      ) : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

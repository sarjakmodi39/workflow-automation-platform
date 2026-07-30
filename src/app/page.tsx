import { RecentRuns } from "@/app/RecentRuns";
import { WorkflowList } from "@/app/WorkflowList";

/**
 * A Server Component shell around two client-side data panels.
 *
 * Nothing is fetched here at request time, so nothing on this page depends on a
 * database being configured at build time. The panels fetch the same routes the
 * API exposes, which is also how their loading and failure states become
 * visible rather than theoretical.
 */
export const dynamic = "force-dynamic";

const PROPERTIES = [
  {
    title: "Validated before it can run",
    body: "A definition is checked for unknown step types, ungranted permissions, missing config and backward branch jumps. An invalid version is refused at save time, not discovered mid-run.",
  },
  {
    title: "Stops for a human",
    body: "An approval step halts the run. Nothing after it executes until a person approves, and a rejection ends the run permanently.",
  },
  {
    title: "Fully reconstructible",
    body: "Every state transition is a database write, so a run can be cancelled, resumed, or selectively retried, and the audit trail explains every decision.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Workflow Automation Platform
        </h1>
        <p className="mt-2 max-w-prose text-sm text-slate-600">
          Define a bounded business workflow, validate it, execute it step by step
          with AI reasoning and a human approval gate, and inspect exactly what
          happened afterwards.
        </p>
      </header>

      <ul className="mt-6 grid gap-3 sm:grid-cols-3">
        {PROPERTIES.map((property) => (
          <li
            key={property.title}
            className="rounded-lg border border-slate-200 bg-white p-4"
          >
            <h2 className="text-sm font-semibold text-slate-900">
              {property.title}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              {property.body}
            </p>
          </li>
        ))}
      </ul>

      <WorkflowList />
      <RecentRuns />
    </main>
  );
}

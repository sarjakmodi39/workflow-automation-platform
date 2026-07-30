import Link from "next/link";
import { WorkflowDetailView } from "@/app/workflows/[id]/WorkflowDetailView";

/**
 * A Server Component that resolves the route param and nothing else.
 *
 * Next 15 hands `params` over as a Promise, so it is awaited. Nothing is read
 * from the database here, which is what lets the build succeed with no
 * `DATABASE_URL` and lets a missing database surface as this page's failure
 * state rather than as an exception during render.
 */
export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href="/"
        className="text-sm text-blue-700 underline-offset-2 hover:underline"
      >
        ← All workflows
      </Link>
      <div className="mt-4">
        <WorkflowDetailView id={id} />
      </div>
    </main>
  );
}

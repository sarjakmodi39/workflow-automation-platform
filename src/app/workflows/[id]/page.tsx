import Link from "next/link";
import { WorkflowDetailView } from "@/app/workflows/[id]/WorkflowDetailView";

/** Resolves the route param and nothing else. Reading no database here is what lets the
 *  build succeed with no DATABASE_URL and turns a missing one into a failure state. */
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

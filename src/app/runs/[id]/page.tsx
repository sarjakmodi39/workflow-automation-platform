import Link from "next/link";
import { RunView } from "@/app/runs/[id]/RunView";

/** A Server Component shell fetching nothing, so no database is needed at build time;
 *  `RunView` fetches in the browser, which makes its loading and failure states real. */
export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // In Next 15 a dynamic route's params is a Promise.
  const { id } = await params;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href="/"
        className="text-sm font-medium text-blue-700 hover:underline"
      >
        ← All workflows
      </Link>
      <RunView runId={id} />
    </main>
  );
}

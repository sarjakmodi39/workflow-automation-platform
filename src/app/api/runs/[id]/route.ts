import { fail, ok, publicRun } from "@/lib/api";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The whole run in one response: `{ run, workflow, version, steps, audit,
 * llmCalls }`. The audit trail and the LLM call ledger are the point of the
 * product, so the detail page gets them in the same round trip as the run
 * rather than discovering them through follow-up requests.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const run = await prisma.run.findUnique({
      where: { id },
      include: {
        workflowVersion: { include: { workflow: true } },
        stepExecutions: {
          // The same three-key ordering the RunStore contract requires. Two
          // attempts can share a millisecond, and without the `id` tiebreak they
          // present in either order between refreshes.
          orderBy: [
            { startedAt: { sort: "asc", nulls: "first" } },
            { attempt: "asc" },
            { id: "asc" },
          ],
          include: { approval: true },
        },
        auditEvents: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        llmCalls: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      },
    });

    if (!run) throw new NotFoundError(`Run ${id}`);

    return ok({
      run: publicRun(run),
      workflow: run.workflowVersion.workflow,
      version: run.workflowVersion,
      steps: run.stepExecutions,
      audit: run.auditEvents,
      llmCalls: run.llmCalls,
    });
  } catch (e) {
    return fail(e);
  }
}

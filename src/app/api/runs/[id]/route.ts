import { fail, ok, publicRun } from "@/lib/api";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tick drives the run for up to 40s, but Vercel defaults a handler to 10s and would
// answer 504 mid-step. 60s is the Hobby ceiling and clears the budget.
export const maxDuration = 60;

/** The whole run in one response. The audit trail and LLM ledger are the point of the
 *  product, so they arrive in the same round trip rather than as follow-up requests. */
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
          // The three-key ordering the RunStore contract requires: two attempts can share
          // a millisecond, and without the `id` tiebreak they reorder between refreshes.
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

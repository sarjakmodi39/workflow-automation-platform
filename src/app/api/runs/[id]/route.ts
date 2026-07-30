import { fail, ok } from "@/lib/api";
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
          orderBy: [{ startedAt: "asc" }, { attempt: "asc" }],
          include: { approval: true },
        },
        auditEvents: { orderBy: { createdAt: "asc" } },
        llmCalls: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!run) throw new NotFoundError(`Run ${id}`);

    return ok({
      run,
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

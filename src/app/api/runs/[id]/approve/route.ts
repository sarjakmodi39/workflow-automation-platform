import { z } from "zod";
import {
  fail,
  ok,
  parseJsonBody,
  publicRun,
} from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { decideApproval } from "@/lib/engine/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionBodySchema = z.object({
  stepExecutionId: z.string().min(1, "stepExecutionId is required."),
  decision: z.enum(["APPROVED", "REJECTED"], {
    message: "decision must be APPROVED or REJECTED.",
  }),
  reason: z.string().nullish(),
});

/**
 * Records a human decision on an approval gate.
 *
 * `decideApproval` refuses a run that is not AWAITING_APPROVAL and a step that
 * is not awaiting a decision, both with ConflictError, and a rejection stops the
 * run permanently. None of that is re-checked or retried here: the route's only
 * jobs are to validate the body and to report what the runner decided.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await parseJsonBody(request, decisionBodySchema);

    const run = await decideApproval(
      createRunnerDeps(),
      id,
      body.stepExecutionId,
      body.decision,
      body.reason ?? null,
    );
    return ok({ run: publicRun(run) });
  } catch (e) {
    return fail(e);
  }
}

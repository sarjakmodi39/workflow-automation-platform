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
// A tick drives the run for up to 40s, but Vercel defaults a handler to 10s and would
// answer 504 mid-step. 60s is the Hobby ceiling and clears the budget.
export const maxDuration = 60;

const decisionBodySchema = z.object({
  stepExecutionId: z.string().min(1, "stepExecutionId is required."),
  decision: z.enum(["APPROVED", "REJECTED"], {
    message: "decision must be APPROVED or REJECTED.",
  }),
  reason: z.string().nullish(),
});

/** Records a human decision. `decideApproval` owns every guard and makes a rejection
 *  permanent; this route only validates the body and reports what the runner decided. */
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

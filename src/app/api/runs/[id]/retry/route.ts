import { z } from "zod";
import { fail, ok, parseJsonBody } from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { retryStep } from "@/lib/engine/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const retryBodySchema = z.object({
  stepExecutionId: z.string().min(1, "stepExecutionId is required."),
});

/**
 * Manually retries one failed step.
 *
 * `retryStep` raises ConflictError for a run another worker has locked and for a
 * run stopped by a rejected approval; both surface as 409. A locked run is the
 * one case where "try again shortly" is the right client behaviour, but that is
 * the client's call to make with the retryable flag in the body — this route
 * does not loop, because a route that retried a lock conflict itself would also
 * retry a rejected approval.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await parseJsonBody(request, retryBodySchema);

    const run = await retryStep(createRunnerDeps(), id, body.stepExecutionId);
    return ok({ run });
  } catch (e) {
    return fail(e);
  }
}

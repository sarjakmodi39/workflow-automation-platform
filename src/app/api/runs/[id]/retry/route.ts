import { z } from "zod";
import {
  fail,
  ok,
  parseJsonBody,
  publicRun,
} from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { retryStep } from "@/lib/engine/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/*
 * A tick advances the run for up to BUDGET_MS (40s) before handing control back
 * to the browser. Vercel defaults a route handler to 10s, which would kill a
 * long tick mid-step and answer 504 — the engine would recover on the next tick,
 * but every slow run would look broken. 60s is the Hobby-plan ceiling and sits
 * above the 40s budget with room for the failure writes.
 */
export const maxDuration = 60;

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
    return ok({ run: publicRun(run) });
  } catch (e) {
    return fail(e);
  }
}

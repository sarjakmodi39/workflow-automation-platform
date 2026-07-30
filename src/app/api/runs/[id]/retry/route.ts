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
// A tick drives the run for up to 40s, but Vercel defaults a handler to 10s and would
// answer 504 mid-step. 60s is the Hobby ceiling and clears the budget.
export const maxDuration = 60;

const retryBodySchema = z.object({
  stepExecutionId: z.string().min(1, "stepExecutionId is required."),
});

/** Manually retries one failed step. A locked run and a rejected approval both surface as
 *  409; this route never loops, since retrying a lock would also retry a rejection. */
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

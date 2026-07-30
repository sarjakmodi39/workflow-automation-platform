import {
  fail,
  ok,
  publicRun,
} from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { advanceRun } from "@/lib/engine/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tick drives the run for up to 40s, but Vercel defaults a handler to 10s and would
// answer 504 mid-step. 60s is the Hobby ceiling and clears the budget.
export const maxDuration = 60;

/** Drives one locked tick, idempotent by design: work already done is never redone. No
 *  status guard here, because a second copy of the runner's rules could only disagree. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const run = await advanceRun(createRunnerDeps(), id);
    return ok({ run: publicRun(run) });
  } catch (e) {
    return fail(e);
  }
}

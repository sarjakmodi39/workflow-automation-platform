import {
  fail,
  ok,
  publicRun,
} from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { resumeRun } from "@/lib/engine/runner";

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

/**
 * Resumes a run that stopped without finishing.
 *
 * `resumeRun` permits FAILED, RUNNING and PENDING and refuses CANCELLED,
 * AWAITING_APPROVAL and COMPLETED with ConflictError, which this route reports
 * as 409 and does not retry. That refusal is load-bearing: a run stopped by a
 * rejected approval is CANCELLED, so catching the conflict and driving the run
 * anyway would step over a human's "no". The client's remedy for a 409 is to
 * decide the approval or to start a new run — never to call this again.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const run = await resumeRun(createRunnerDeps(), id);
    return ok({ run: publicRun(run) });
  } catch (e) {
    return fail(e);
  }
}

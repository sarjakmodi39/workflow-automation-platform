import {
  fail,
  ok,
  publicRun,
} from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { advanceRun } from "@/lib/engine/runner";

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
 * Drives one locked tick. Idempotent by design: `advanceRun` never redoes work
 * already done, returns the run unchanged when it is terminal or parked at an
 * approval gate, and yields to whoever already holds the lock. So this route
 * has no status guard of its own — the runner owns that decision, and a second
 * copy of it here could only disagree.
 */
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

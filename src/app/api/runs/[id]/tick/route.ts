import {
  fail,
  ok,
  publicRun,
} from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { advanceRun } from "@/lib/engine/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

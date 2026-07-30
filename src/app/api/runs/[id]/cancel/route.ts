import { fail, ok } from "@/lib/api";
import { createRunnerDeps } from "@/lib/engine/deps";
import { cancelRun } from "@/lib/engine/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cancels a run. `cancelRun` returns an already-terminal run unchanged rather
 * than raising, so cancelling twice is a 200 both times — there is no state to
 * conflict over once a run has stopped.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const run = await cancelRun(createRunnerDeps(), id);
    return ok({ run });
  } catch (e) {
    return fail(e);
  }
}

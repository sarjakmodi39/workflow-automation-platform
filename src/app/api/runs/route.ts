import { z } from "zod";
import {
  fail,
  ok,
  parseJsonBody,
  publicRun,
} from "@/lib/api";
import { prisma } from "@/lib/db";
import { createRunnerDeps } from "@/lib/engine/deps";
import { advanceRun, startRun } from "@/lib/engine/runner";

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

const createBodySchema = z.object({
  workflowVersionId: z.string().min(1, "workflowVersionId is required."),
  input: z.unknown().optional(),
});

export async function GET() {
  try {
    const runs = await prisma.run.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        workflowVersion: { include: { workflow: { select: { name: true } } } },
      },
    });
    return ok({ runs: runs.map(publicRun) });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createBodySchema);

    const deps = createRunnerDeps();
    // startRun resolves the version and throws NotFoundError when the id does
    // not exist, so the Run row is never written against a missing foreign key.
    const created = await startRun(deps, body.workflowVersionId, body.input ?? {});
    const run = await advanceRun(deps, created.id);

    return ok({ run: publicRun(run) }, 201);
  } catch (e) {
    return fail(e);
  }
}

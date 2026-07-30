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

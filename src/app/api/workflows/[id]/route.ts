import { fail, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";

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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Next 15: params is a Promise. Awaiting it is not optional.
    const { id } = await params;

    const workflow = await prisma.workflow.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    if (!workflow) throw new NotFoundError(`Workflow ${id}`);

    return ok({ workflow });
  } catch (e) {
    return fail(e);
  }
}

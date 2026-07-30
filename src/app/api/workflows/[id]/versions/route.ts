import {
  definitionBodySchema,
  fail,
  ok,
  parseJsonBody,
  toWorkflowDefinition,
} from "@/lib/api";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requiredJson } from "@/lib/engine/store.prisma";
import { validateWorkflow } from "@/lib/engine/validator";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await parseJsonBody(request, definitionBodySchema);

    // The parent is confirmed before anything referencing it is written: a
    // WorkflowVersion row carries a foreign key to Workflow, and an unchecked id
    // from the URL would surface as an opaque Prisma failure rather than a 404.
    const workflow = await prisma.workflow.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!workflow) throw new NotFoundError(`Workflow ${id}`);

    const definition = toWorkflowDefinition(body.definition);
    const grants = body.grantedPermissions ?? [];

    const issues = validateWorkflow(definition, grants);
    if (issues.length > 0) {
      throw new ValidationError("Workflow definition is not valid.", { issues });
    }

    const nextVersion = (workflow.versions[0]?.version ?? 0) + 1;

    // Reading the highest version and then inserting is not atomic, and
    // @@unique([workflowId, version]) is what stops two concurrent editors from
    // both claiming the same number. Translate that collision rather than
    // letting it reach the generic handler: a concurrent edit is the client's to
    // retry, and reporting it as a 500 tells them the opposite.
    let version;
    try {
      version = await prisma.workflowVersion.create({
        data: {
          workflowId: id,
          version: nextVersion,
          definition: requiredJson(definition),
          grantedPermissions: requiredJson(grants),
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        throw new ConflictError(
          `Workflow ${id} was modified concurrently; reload and try again.`,
        );
      }
      throw e;
    }

    return ok({ version }, 201);
  } catch (e) {
    return fail(e);
  }
}

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
// A tick drives the run for up to 40s, but Vercel defaults a handler to 10s and would
// answer 504 mid-step. 60s is the Hobby ceiling and clears the budget.
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await parseJsonBody(request, definitionBodySchema);

    // The parent is confirmed first: a version carries a foreign key, and an unchecked
    // id from the URL would surface as an opaque Prisma failure rather than a 404.
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

    // Read-then-insert is not atomic; the unique constraint stops two editors claiming one
    // number. Translated here, because a concurrent edit is the client's to retry, not a 500.
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

import {
  definitionBodySchema,
  fail,
  ok,
  parseJsonBody,
  toWorkflowDefinition,
} from "@/lib/api";
import { prisma } from "@/lib/db";
import { validateWorkflow } from "@/lib/engine/validator";
import { NotFoundError, ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    const version = await prisma.workflowVersion.create({
      data: {
        workflowId: id,
        version: nextVersion,
        definition: definition as never,
        grantedPermissions: grants as never,
      },
    });

    return ok({ version }, 201);
  } catch (e) {
    return fail(e);
  }
}

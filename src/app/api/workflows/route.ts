import { z } from "zod";
import {
  definitionBodySchema,
  fail,
  ok,
  parseJsonBody,
  toWorkflowDefinition,
} from "@/lib/api";
import { prisma } from "@/lib/db";
import { validateWorkflow } from "@/lib/engine/validator";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createBodySchema = definitionBodySchema.extend({
  name: z.string().min(1, "A workflow name is required."),
});

export async function GET() {
  try {
    const workflows = await prisma.workflow.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        versions: {
          orderBy: { version: "desc" },
          select: { id: true, version: true, createdAt: true },
        },
      },
    });
    return ok({ workflows });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createBodySchema);
    const definition = toWorkflowDefinition(body.definition);
    const grants = body.grantedPermissions ?? [];

    // Before persistence, not at execution time: a version that cannot execute
    // must never reach the database, because the run that reads it back has no
    // better moment to discover that than halfway through.
    const issues = validateWorkflow(definition, grants);
    if (issues.length > 0) {
      throw new ValidationError("Workflow definition is not valid.", { issues });
    }

    const workflow = await prisma.workflow.create({
      data: {
        name: body.name,
        versions: {
          create: {
            version: 1,
            definition: definition as never,
            grantedPermissions: grants as never,
          },
        },
      },
      include: { versions: true },
    });

    return ok({ workflow }, 201);
  } catch (e) {
    return fail(e);
  }
}

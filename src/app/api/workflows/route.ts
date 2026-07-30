import { z } from "zod";
import {
  definitionBodySchema,
  fail,
  ok,
  parseJsonBody,
  toWorkflowDefinition,
} from "@/lib/api";
import { prisma } from "@/lib/db";
import { requiredJson } from "@/lib/engine/store.prisma";
import { validateWorkflow } from "@/lib/engine/validator";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tick drives the run for up to 40s, but Vercel defaults a handler to 10s and would
// answer 504 mid-step. 60s is the Hobby ceiling and clears the budget.
export const maxDuration = 60;

const createBodySchema = definitionBodySchema.extend({
  name: z.string().min(1, "A workflow name is required."),
});

export async function GET() {
  try {
    // Bounded deliberately. An unbounded list grows without limit and the
    // response is rendered by the home page; the runs list caps the same way.
    const workflows = await prisma.workflow.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 20,
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

    // Before persistence, not at execution: a version that cannot execute must never
    // reach the database, since a run has no better moment to discover that mid-flight.
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
            definition: requiredJson(definition),
            grantedPermissions: requiredJson(grants),
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

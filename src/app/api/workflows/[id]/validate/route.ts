import {
  definitionBodySchema,
  fail,
  ok,
  parseJsonBody,
  toWorkflowDefinition,
} from "@/lib/api";
import { validateWorkflow } from "@/lib/engine/validator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dry-run validation. Issues are the successful answer here, not an error: the
 * editor asks "would this save?" and gets 200 with `valid: false` and the same
 * issue list the create routes would refuse with. Nothing is read or written,
 * so the `[id]` in the path is not resolved — it only scopes the endpoint to the
 * workflow being edited.
 */
export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, definitionBodySchema);
    const issues = validateWorkflow(
      toWorkflowDefinition(body.definition),
      body.grantedPermissions ?? [],
    );
    return ok({ valid: issues.length === 0, issues });
  } catch (e) {
    return fail(e);
  }
}

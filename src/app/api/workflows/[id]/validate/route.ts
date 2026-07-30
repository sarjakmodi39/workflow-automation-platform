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
// A tick drives the run for up to 40s, but Vercel defaults a handler to 10s and would
// answer 504 mid-step. 60s is the Hobby ceiling and clears the budget.
export const maxDuration = 60;

/** Dry-run validation: issues are the successful answer, not an error, so "would this save?"
 *  returns 200 with `valid: false` and the same list the create routes would refuse with. */
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

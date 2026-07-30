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
/*
 * A tick advances the run for up to BUDGET_MS (40s) before handing control back
 * to the browser. Vercel defaults a route handler to 10s, which would kill a
 * long tick mid-step and answer 504 — the engine would recover on the next tick,
 * but every slow run would look broken. 60s is the Hobby-plan ceiling and sits
 * above the 40s budget with room for the failure writes.
 */
export const maxDuration = 60;

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

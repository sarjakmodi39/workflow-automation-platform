import { getStepSpec } from "@/lib/engine/registry";
import { PermissionDeniedError } from "@/lib/errors";
import type { StepDefinition } from "@/lib/types";

/** Permissions the step needs that the version has not granted. */
export function missingPermissions(
  step: StepDefinition,
  granted: string[],
): string[] {
  const spec = getStepSpec(step.type);
  const required = spec.requiredPermissions(step.config ?? {});
  const grantedSet = new Set(granted);
  return required.filter((p) => !grantedSet.has(p));
}

/** Throws PermissionDeniedError for the first missing permission. */
export function assertPermitted(
  step: StepDefinition,
  granted: string[],
): void {
  const missing = missingPermissions(step, granted);
  if (missing.length > 0) {
    throw new PermissionDeniedError(missing[0]);
  }
}

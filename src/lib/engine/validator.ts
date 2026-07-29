import { REGISTRY } from "@/lib/engine/registry";
import { missingPermissions } from "@/lib/engine/permissions";
import type { Condition, StepDefinition, StepType, WorkflowDefinition } from "@/lib/types";

export interface ValidationIssue {
  stepId: string | null;
  code: string;
  message: string;
}

/** Collects every `$.steps.<id>` reference inside an arbitrary config value. */
function collectStepRefs(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith("$.steps.")) {
      const parts = value.split(".");
      if (parts[2]) out.add(parts[2]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStepRefs(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStepRefs(v, out);
  }
}

function collectConditionRefs(cond: Condition | undefined, out: Set<string>): void {
  if (!cond) return;
  if ("allOf" in cond) {
    for (const c of cond.allOf) collectConditionRefs(c, out);
    return;
  }
  if ("anyOf" in cond) {
    for (const c of cond.anyOf) collectConditionRefs(c, out);
    return;
  }
  collectStepRefs(cond.left, out);
  collectStepRefs(cond.right, out);
}

export function validateWorkflow(
  def: WorkflowDefinition,
  granted: string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const steps = def?.steps ?? [];

  if (steps.length === 0) {
    issues.push({
      stepId: null,
      code: "EMPTY_WORKFLOW",
      message: "A workflow must contain at least one step.",
    });
    return issues;
  }

  // Unique ids
  const seen = new Set<string>();
  for (const step of steps) {
    if (!step.id) {
      issues.push({
        stepId: null,
        code: "MISSING_STEP_ID",
        message: "Every step needs an id.",
      });
      continue;
    }
    if (seen.has(step.id)) {
      issues.push({
        stepId: step.id,
        code: "DUPLICATE_STEP_ID",
        message: `Step id "${step.id}" is used more than once.`,
      });
    }
    seen.add(step.id);
  }

  const indexById = new Map<string, number>();
  steps.forEach((s, i) => {
    if (s.id && !indexById.has(s.id)) indexById.set(s.id, i);
  });

  steps.forEach((step: StepDefinition, index: number) => {
    const spec = REGISTRY[step.type as StepType];

    if (!spec) {
      issues.push({
        stepId: step.id,
        code: "UNKNOWN_STEP_TYPE",
        message: `Unknown step type "${step.type}".`,
      });
      return;
    }

    // Per-type config validity
    for (const message of spec.validateConfig(step.config ?? {})) {
      issues.push({ stepId: step.id, code: "INVALID_STEP_CONFIG", message });
    }

    // Permission grants
    for (const permission of missingPermissions(step, granted)) {
      issues.push({
        stepId: step.id,
        code: "PERMISSION_NOT_GRANTED",
        message: `Step "${step.name || step.id}" requires ${permission}, which this workflow version does not grant.`,
      });
    }

    // Step references must point at an earlier step
    const refs = new Set<string>();
    collectStepRefs(step.config ?? {}, refs);
    collectConditionRefs(step.condition, refs);

    for (const ref of refs) {
      const refIndex = indexById.get(ref);
      if (refIndex === undefined) {
        issues.push({
          stepId: step.id,
          code: "UNKNOWN_SOURCE_STEP",
          message: `Step "${step.id}" references "${ref}", which does not exist.`,
        });
      } else if (refIndex >= index) {
        issues.push({
          stepId: step.id,
          code: "FORWARD_SOURCE_REFERENCE",
          message: `Step "${step.id}" references "${ref}", which does not run before it.`,
        });
      }
    }

    // Condition steps: condition present, branch targets valid and forward-only
    if (step.type === "deterministic_condition") {
      if (!step.condition) {
        issues.push({
          stepId: step.id,
          code: "MISSING_CONDITION",
          message: `Condition step "${step.id}" has no condition defined.`,
        });
      }

      for (const [branch, target] of [
        ["onTrue", step.onTrue],
        ["onFalse", step.onFalse],
      ] as const) {
        if (target === undefined || target === "end") continue;

        const targetIndex = indexById.get(target);
        if (targetIndex === undefined) {
          issues.push({
            stepId: step.id,
            code: "UNKNOWN_BRANCH_TARGET",
            message: `Branch ${branch} of "${step.id}" points at "${target}", which does not exist.`,
          });
        } else if (targetIndex <= index) {
          issues.push({
            stepId: step.id,
            code: "BACKWARD_BRANCH",
            message: `Branch ${branch} of "${step.id}" jumps backward to "${target}". Jumps must move forward so every run terminates.`,
          });
        }
      }
    }
  });

  return issues;
}

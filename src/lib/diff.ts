import type { StepDefinition } from "@/lib/types";

/* Field-level comparison of two workflow versions. Pure and store-free, so the interesting
 * cases are unit-testable without a database or a rendered page. */

export type ChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface FieldChange {
  /** Dotted path within the step, e.g. `config.topK`. */
  field: string;
  before: unknown;
  after: unknown;
}

export interface StepDiff {
  stepId: string;
  name: string;
  kind: ChangeKind;
  /** Populated only when `kind` is "changed". */
  fields: FieldChange[];
  /** Set when a step kept its identity but moved position. */
  movedFrom?: number;
  movedTo?: number;
}

export interface VersionDiff {
  steps: StepDiff[];
  permissionsAdded: string[];
  permissionsRemoved: string[];
  /** True when nothing at all differs — worth saying explicitly. */
  identical: boolean;
}

/** Order-insensitive deep equality, so a re-serialised object does not read as a change. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }

  const ak = Object.keys(a as object).sort();
  const bk = Object.keys(b as object).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) =>
    sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Flattens a step to comparable leaf paths, so a diff can name `config.topK` and not "config". */
function leaves(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    // An object that became empty still has to register, or removing its last key reads
    // as no change at all.
    if (entries.length === 0) out.set(prefix, value);
    for (const [k, v] of entries) leaves(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.set(prefix, value);
}

function comparableFields(step: StepDefinition): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const key of ["type", "name", "config", "condition", "onTrue", "onFalse"] as const) {
    const value = (step as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    leaves(value, key, out);
  }
  return out;
}

function changedFields(before: StepDefinition, after: StepDefinition): FieldChange[] {
  const a = comparableFields(before);
  const b = comparableFields(after);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();

  const changes: FieldChange[] = [];
  for (const field of keys) {
    if (!sameValue(a.get(field), b.get(field))) {
      changes.push({ field, before: a.get(field), after: b.get(field) });
    }
  }
  return changes;
}

/**
 * Diffs two definitions by step id, not by position: matching on position would report a
 * step inserted at the top as though every following step had been rewritten.
 */
export function diffVersions(
  beforeSteps: StepDefinition[],
  afterSteps: StepDefinition[],
  beforeGrants: string[] = [],
  afterGrants: string[] = [],
): VersionDiff {
  const beforeById = new Map(beforeSteps.map((s, i) => [s.id, { step: s, index: i }]));
  const afterById = new Map(afterSteps.map((s, i) => [s.id, { step: s, index: i }]));

  const steps: StepDiff[] = [];

  // Walk the *after* order, so the result reads like the version being moved to.
  for (const [i, step] of afterSteps.entries()) {
    const prior = beforeById.get(step.id);
    if (!prior) {
      steps.push({ stepId: step.id, name: step.name || step.id, kind: "added", fields: [] });
      continue;
    }
    const fields = changedFields(prior.step, step);
    const moved = prior.index !== i;
    steps.push({
      stepId: step.id,
      name: step.name || step.id,
      kind: fields.length > 0 ? "changed" : "unchanged",
      fields,
      ...(moved ? { movedFrom: prior.index + 1, movedTo: i + 1 } : {}),
    });
  }

  for (const step of beforeSteps) {
    if (afterById.has(step.id)) continue;
    steps.push({ stepId: step.id, name: step.name || step.id, kind: "removed", fields: [] });
  }

  const beforeSet = new Set(beforeGrants);
  const afterSet = new Set(afterGrants);
  const permissionsAdded = afterGrants.filter((p) => !beforeSet.has(p));
  const permissionsRemoved = beforeGrants.filter((p) => !afterSet.has(p));

  const identical =
    permissionsAdded.length === 0 &&
    permissionsRemoved.length === 0 &&
    steps.every((s) => s.kind === "unchanged" && s.movedFrom === undefined);

  return { steps, permissionsAdded, permissionsRemoved, identical };
}

import { createHash } from "node:crypto";
import { evaluateCondition, resolvePath } from "@/lib/engine/expression";
import type { ExecutionContext } from "@/lib/engine/context";
import type { FieldKind, JsonShape } from "@/lib/engine/registry";
import type { RunStore } from "@/lib/engine/store";
import { StepExecutionError } from "@/lib/errors";
import { callLlm } from "@/lib/llm";
import type { LlmProvider } from "@/lib/llm/types";
import { searchCorpus } from "@/seed/corpus";
import type { StepDefinition, StepType } from "@/lib/types";

export interface StepHandlerDeps {
  store: RunStore;
  runId: string;
  stepExecutionId: string | null;
  providers: LlmProvider[];
  maxLlmCalls: number;
  ctx: ExecutionContext;
  now: () => Date;
}

export interface StepHandlerResult {
  output: unknown;
  explanation?: unknown;
  /** Only condition steps set this. "end" terminates the run. */
  nextStepId?: string;
}

export type StepHandler = (
  step: StepDefinition,
  deps: StepHandlerDeps,
) => Promise<StepHandlerResult>;

interface FieldSpec {
  name: string;
  kind: FieldKind;
}

function fieldsOf(config: Record<string, unknown>): FieldSpec[] {
  return Array.isArray(config.fields) ? (config.fields as FieldSpec[]) : [];
}

function shapeOf(fields: FieldSpec[]): JsonShape {
  const shape: JsonShape = {};
  for (const f of fields) shape[f.name] = f.kind;
  return shape;
}

function kindMatches(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "any":
      return true;
  }
}

function assertFields(
  source: Record<string, unknown>,
  fields: FieldSpec[],
  what: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source?.[field.name];
    if (value === undefined || value === null) {
      throw new StepExecutionError(
        `${what} is missing required field "${field.name}".`,
        true,
        { field: field.name },
      );
    }
    if (!kindMatches(value, field.kind)) {
      throw new StepExecutionError(
        `${what} field "${field.name}" should be a ${field.kind} but was ${typeof value}.`,
        true,
        { field: field.name, expected: field.kind },
      );
    }
    out[field.name] = value;
  }
  return out;
}

/** Deterministic, order-insensitive JSON stringify for hashing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}

export function buildIdempotencyKey(
  runId: string,
  stepId: string,
  action: string,
  payload: unknown,
): string {
  const material = `${runId}|${stepId}|${action}|${stableStringify(payload)}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 48);
}

/** Recursively resolves any `$.`-prefixed string inside a config value. */
function resolveDeep(value: unknown, ctx: ExecutionContext): unknown {
  if (typeof value === "string") return resolvePath(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, ctx);
    return out;
  }
  return value;
}

const structuredInput: StepHandler = async (step, deps) => {
  const fields = fieldsOf(step.config);
  const input = (deps.ctx.input ?? {}) as Record<string, unknown>;
  return { output: assertFields(input, fields, "Run input") };
};

const documentRetrieval: StepHandler = async (step, deps) => {
  const rawQuery = String(step.config.query ?? "");
  const resolved = resolvePath(rawQuery, deps.ctx);
  const query = typeof resolved === "string" ? resolved : stableStringify(resolved);
  const topK = typeof step.config.topK === "number" ? step.config.topK : 3;

  const documents = searchCorpus(query, topK);
  return {
    output: { documents, matchCount: documents.length },
    explanation: { query, topK },
  };
};

const aiExtraction: StepHandler = async (step, deps) => {
  const fields = fieldsOf(step.config);
  const source = resolveDeep(step.config.source, deps.ctx);

  const data = await callLlm<Record<string, unknown>>(
    {
      store: deps.store,
      runId: deps.runId,
      stepExecutionId: deps.stepExecutionId,
      providers: deps.providers,
      maxCalls: deps.maxLlmCalls,
    },
    {
      system:
        "You extract structured data from business documents. Return only the requested fields. Use null for anything genuinely absent.",
      user: `Extract these fields: ${fields
        .map((f) => `${f.name} (${f.kind})`)
        .join(", ")}\n\nSource:\n${stableStringify(source)}`,
      schema: shapeOf(fields),
    },
  );

  return { output: assertFields(data ?? {}, fields, "Model output") };
};

const aiClassification: StepHandler = async (step, deps) => {
  const labels = Array.isArray(step.config.labels)
    ? (step.config.labels as string[])
    : [];
  const source = resolveDeep(step.config.source, deps.ctx);

  const data = await callLlm<{
    label: string;
    confidence: number;
    rationale: string;
  }>(
    {
      store: deps.store,
      runId: deps.runId,
      stepExecutionId: deps.stepExecutionId,
      providers: deps.providers,
      maxCalls: deps.maxLlmCalls,
    },
    {
      system:
        "You classify business records. Choose exactly one label from the provided list and explain your choice in one sentence.",
      user: `Labels: ${labels.join(", ")}\n\nRecord:\n${stableStringify(source)}`,
      schema: { label: "string", confidence: "number", rationale: "string" },
    },
  );

  if (!labels.includes(data?.label)) {
    throw new StepExecutionError(
      `Model returned label "${data?.label}", which is not one of: ${labels.join(", ")}.`,
      true,
      { returned: data?.label, allowed: labels },
    );
  }

  return {
    output: {
      label: data.label,
      confidence: typeof data.confidence === "number" ? data.confidence : 0,
      rationale: String(data.rationale ?? ""),
    },
  };
};

const deterministicCondition: StepHandler = async (step, deps) => {
  if (!step.condition) {
    throw new StepExecutionError(
      `Condition step "${step.id}" has no condition defined.`,
      false,
    );
  }

  const evaluated = evaluateCondition(step.condition, deps.ctx);
  const branchTaken = evaluated.result ? step.onTrue : step.onFalse;

  return {
    output: { result: evaluated.result, branchTaken: branchTaken ?? "end" },
    explanation: {
      condition: step.condition,
      resolvedInputs: evaluated.resolvedInputs,
      result: evaluated.result,
      description: evaluated.description,
      branchTaken: branchTaken ?? "end",
    },
    nextStepId: branchTaken ?? "end",
  };
};

const mockExternalAction: StepHandler = async (step, deps) => {
  const action = String(step.config.action ?? "unknown");
  const payload = resolveDeep(step.config.payload ?? {}, deps.ctx);
  const key = buildIdempotencyKey(deps.runId, step.id, action, payload);

  const response = {
    ref: `EXT-${key.slice(0, 8).toUpperCase()}`,
    action,
    submittedAt: deps.now().toISOString(),
  };

  const inserted = await deps.store.insertExternalAction({
    idempotencyKey: key,
    runId: deps.runId,
    stepId: step.id,
    request: payload,
    response,
  });

  if (!inserted.created) {
    await deps.store.appendAudit({
      runId: deps.runId,
      stepExecutionId: deps.stepExecutionId,
      type: "DUPLICATE_WRITE_PREVENTED",
      payload: { idempotencyKey: key, action, stepId: step.id },
    });
  } else {
    await deps.store.appendAudit({
      runId: deps.runId,
      stepExecutionId: deps.stepExecutionId,
      type: "TOOL_CALL",
      payload: { action, stepId: step.id, idempotencyKey: key, request: payload },
    });
  }

  const stored = inserted.record.response as { ref: string };

  return {
    output: {
      actionId: stored.ref,
      status: "SUBMITTED",
      duplicatePrevented: !inserted.created,
    },
    explanation: { idempotencyKey: key, action },
  };
};

const finalReport: StepHandler = async (step, deps) => {
  const title = String(step.config.title ?? "Report");
  const sections = Object.entries(deps.ctx.steps).map(([stepId, output]) => ({
    stepId,
    output,
  }));

  if (step.config.summarize !== true) {
    return { output: { title, sections } };
  }

  const data = await callLlm<{ summary: string }>(
    {
      store: deps.store,
      runId: deps.runId,
      stepExecutionId: deps.stepExecutionId,
      providers: deps.providers,
      maxCalls: deps.maxLlmCalls,
    },
    {
      system:
        "You summarise the outcome of an automated business workflow in two or three sentences for a reviewer who did not watch it run.",
      user: stableStringify(sections),
      schema: { summary: "string" },
    },
  );

  return { output: { title, sections, summary: String(data?.summary ?? "") } };
};

const notDispatchable: StepHandler = async (step) => {
  throw new StepExecutionError(
    `Step type "${step.type}" is handled by the runner, not by a handler.`,
    false,
  );
};

export const HANDLERS: Record<StepType, StepHandler> = {
  structured_input: structuredInput,
  document_retrieval: documentRetrieval,
  ai_extraction: aiExtraction,
  ai_classification: aiClassification,
  deterministic_condition: deterministicCondition,
  human_approval: notDispatchable,
  mock_external_action: mockExternalAction,
  final_report: finalReport,
};

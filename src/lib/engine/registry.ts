import { ValidationError } from "@/lib/errors";
import type { StepType } from "@/lib/types";

export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "any";

/** Field-name to kind map. Deliberately smaller than JSON Schema. */
export type JsonShape = Record<string, FieldKind>;

export interface StepTypeSpec {
  type: StepType;
  label: string;
  description: string;
  retrySafe: boolean;
  /** Permissions this step needs, derived from its configuration. */
  requiredPermissions(config: Record<string, unknown>): string[];
  /** Fields this step expects to find in the accumulated context. */
  inputSchema(config: Record<string, unknown>): JsonShape;
  /** Fields this step guarantees to produce. */
  outputSchema(config: Record<string, unknown>): JsonShape;
  /** Returns human-readable config problems; empty array means valid. */
  validateConfig(config: Record<string, unknown>): string[];
}

interface ExtractionField {
  name: string;
  kind: FieldKind;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export const REGISTRY: Record<StepType, StepTypeSpec> = {
  structured_input: {
    type: "structured_input",
    label: "Structured Input",
    description: "Validates the run input against a declared field shape.",
    retrySafe: true,
    requiredPermissions: () => [],
    inputSchema: () => ({}),
    outputSchema: (config) => {
      const shape: JsonShape = {};
      for (const f of asArray<ExtractionField>(config.fields)) {
        shape[f.name] = f.kind;
      }
      return shape;
    },
    validateConfig: (config) => {
      const fields = asArray<ExtractionField>(config.fields);
      if (fields.length === 0) return ["Structured input must declare at least one field."];
      const errors: string[] = [];
      for (const f of fields) {
        if (!f.name) errors.push("Every input field needs a name.");
      }
      return errors;
    },
  },

  document_retrieval: {
    type: "document_retrieval",
    label: "Document Retrieval",
    description: "Keyword-scored lookup over the seeded document corpus.",
    retrySafe: true,
    requiredPermissions: () => ["tool:document_search"],
    inputSchema: () => ({}),
    outputSchema: () => ({ documents: "array", matchCount: "number" }),
    validateConfig: (config) => {
      const errors: string[] = [];
      if (typeof config.query !== "string" || config.query.length === 0) {
        errors.push("Document retrieval needs a query.");
      }
      const topK = config.topK;
      if (topK !== undefined && (typeof topK !== "number" || topK < 1)) {
        errors.push("topK must be a positive number.");
      }
      return errors;
    },
  },

  ai_extraction: {
    type: "ai_extraction",
    label: "AI Extraction",
    description: "Extracts declared fields from prior step output using an LLM.",
    retrySafe: true,
    requiredPermissions: () => ["tool:llm"],
    inputSchema: () => ({}),
    outputSchema: (config) => {
      const shape: JsonShape = {};
      for (const f of asArray<ExtractionField>(config.fields)) {
        shape[f.name] = f.kind;
      }
      return shape;
    },
    validateConfig: (config) => {
      const fields = asArray<ExtractionField>(config.fields);
      if (fields.length === 0) {
        return ["AI extraction must declare at least one field to extract."];
      }
      const errors: string[] = [];
      if (typeof config.source !== "string" || config.source.length === 0) {
        errors.push("AI extraction needs a source path (e.g. $.steps.retrieve.documents).");
      }
      for (const f of fields) {
        if (!f.name) errors.push("Every extraction field needs a name.");
        // `JsonShape` is one level deep, so an array or object field cannot
        // describe its element or property types. The Gemini adapter turns the
        // shape into a responseSchema, and Gemini rejects an ARRAY without
        // `items` with a 400 — which the adapter classifies as non-retryable,
        // so the run would fail mid-execution with a schema complaint from the
        // model API. Refuse it here instead: a workflow that cannot work is
        // caught when it is saved, not when someone runs it.
        if (f.kind === "array" || f.kind === "object") {
          errors.push(
            `Extraction field "${f.name}" cannot be a ${f.kind}: the AI response schema is one level deep. Extract scalar fields, or use a document retrieval step.`,
          );
        }
      }
      return errors;
    },
  },

  ai_classification: {
    type: "ai_classification",
    label: "AI Classification",
    description: "Assigns one of a declared label set, with confidence and rationale.",
    retrySafe: true,
    requiredPermissions: () => ["tool:llm"],
    inputSchema: () => ({}),
    outputSchema: () => ({
      label: "string",
      confidence: "number",
      rationale: "string",
    }),
    validateConfig: (config) => {
      const labels = asArray<string>(config.labels);
      const errors: string[] = [];
      if (labels.length < 2) {
        errors.push("AI classification needs at least two labels.");
      }
      if (typeof config.source !== "string" || config.source.length === 0) {
        errors.push("AI classification needs a source path.");
      }
      return errors;
    },
  },

  deterministic_condition: {
    type: "deterministic_condition",
    label: "Condition",
    description: "Evaluates a declarative comparator and selects a branch.",
    retrySafe: true,
    requiredPermissions: () => [],
    inputSchema: () => ({}),
    outputSchema: () => ({ result: "boolean", branchTaken: "string" }),
    validateConfig: () => [],
  },

  human_approval: {
    type: "human_approval",
    label: "Human Approval",
    description: "Halts the run until a person approves or rejects.",
    retrySafe: true,
    requiredPermissions: () => [],
    inputSchema: () => ({}),
    outputSchema: () => ({ decision: "string", reason: "string" }),
    validateConfig: (config) => {
      if (typeof config.prompt !== "string" || config.prompt.length === 0) {
        return ["Human approval needs a prompt explaining what is being approved."];
      }
      return [];
    },
  },

  mock_external_action: {
    type: "mock_external_action",
    label: "External Action (mock)",
    description: "Simulated write, guarded by the idempotency ledger.",
    retrySafe: false,
    requiredPermissions: (config) => {
      const action = typeof config.action === "string" ? config.action : "unknown";
      return [`action:${action}`];
    },
    inputSchema: () => ({}),
    outputSchema: () => ({
      actionId: "string",
      status: "string",
      duplicatePrevented: "boolean",
    }),
    validateConfig: (config) => {
      const errors: string[] = [];
      if (typeof config.action !== "string" || config.action.length === 0) {
        errors.push("External action needs an action name.");
      }
      if (config.payload !== undefined && typeof config.payload !== "object") {
        errors.push("External action payload must be an object.");
      }
      return errors;
    },
  },

  final_report: {
    type: "final_report",
    label: "Final Report",
    description: "Assembles a structured report from all prior step outputs.",
    retrySafe: true,
    requiredPermissions: (config) => (config.summarize === true ? ["tool:llm"] : []),
    inputSchema: () => ({}),
    outputSchema: (config): JsonShape => {
      const shape: JsonShape = { title: "string", sections: "array" };
      if (config.summarize === true) shape.summary = "string";
      return shape;
    },
    validateConfig: (config) => {
      if (typeof config.title !== "string" || config.title.length === 0) {
        return ["Final report needs a title."];
      }
      return [];
    },
  },
};

export function getStepSpec(type: string): StepTypeSpec {
  const spec = REGISTRY[type as StepType];
  if (!spec) {
    throw new ValidationError(`Unknown step type: ${type}`, { type });
  }
  return spec;
}

export const ALL_STEP_TYPES = Object.keys(REGISTRY) as StepType[];

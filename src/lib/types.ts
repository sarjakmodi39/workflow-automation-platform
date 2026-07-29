export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type StepStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "SKIPPED"
  | "AWAITING_APPROVAL"
  | "CANCELLED";

export type StepType =
  | "structured_input"
  | "document_retrieval"
  | "ai_extraction"
  | "ai_classification"
  | "deterministic_condition"
  | "human_approval"
  | "mock_external_action"
  | "final_report";

export type AuditEventType =
  | "RUN_CREATED"
  | "STEP_STARTED"
  | "STEP_SUCCEEDED"
  | "STEP_FAILED"
  | "LLM_CALL"
  | "TOOL_CALL"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_DECIDED"
  | "RETRY_ATTEMPTED"
  | "DUPLICATE_WRITE_PREVENTED"
  | "PERMISSION_DENIED"
  | "RUN_CANCELLED"
  | "RUN_RESUMED"
  | "RUN_COMPLETED"
  | "RUN_FAILED";

export type ComparatorOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "contains";

/** A single comparison against a resolved path or literal. */
export interface Comparator {
  left: string;
  op: ComparatorOp;
  right: unknown;
}

/** A comparator, or a boolean grouping of conditions. */
export type Condition =
  | Comparator
  | { allOf: Condition[] }
  | { anyOf: Condition[] };

export interface StepDefinition {
  id: string;
  type: StepType;
  name: string;
  /** Step-type-specific configuration. Validated per type by the registry. */
  config: Record<string, unknown>;
  /** Only present on deterministic_condition steps. */
  condition?: Condition;
  /** Forward step id or "end". Only on deterministic_condition steps. */
  onTrue?: string;
  onFalse?: string;
}

export interface WorkflowDefinition {
  steps: StepDefinition[];
}

export interface RunRecord {
  id: string;
  workflowVersionId: string;
  status: RunStatus;
  input: unknown;
  cursor: string | null;
  lockToken: string | null;
  lockedUntil: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StepExecutionRecord {
  id: string;
  runId: string;
  stepId: string;
  stepType: StepType;
  status: StepStatus;
  attempt: number;
  retrySafe: boolean;
  input: unknown;
  output: unknown;
  explanation: unknown;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface AuditEventRecord {
  id: string;
  runId: string;
  stepExecutionId: string | null;
  type: AuditEventType;
  payload: unknown;
  createdAt: Date;
}

export interface LlmCallRecord {
  id: string;
  stepExecutionId: string | null;
  runId: string;
  provider: string;
  model: string;
  prompt: string;
  response: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status: "SUCCESS" | "ERROR";
  error: string | null;
  createdAt: Date;
}

export interface ExternalActionRecord {
  id: string;
  idempotencyKey: string;
  runId: string;
  stepId: string;
  request: unknown;
  response: unknown;
  createdAt: Date;
}

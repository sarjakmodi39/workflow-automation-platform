import type {
  ApprovalRecord,
  AuditEventRecord,
  AuditEventType,
  ExternalActionRecord,
  LlmCallRecord,
  RunRecord,
  RunStatus,
  StepExecutionRecord,
  StepStatus,
  StepType,
  WorkflowVersionRecord,
} from "@/lib/types";

export interface CreateRunInput {
  workflowVersionId: string;
  input: unknown;
}

export interface CreateStepExecutionInput {
  runId: string;
  stepId: string;
  stepType: StepType;
  status: StepStatus;
  attempt: number;
  retrySafe: boolean;
  input: unknown;
}

export interface UpdateStepExecutionInput {
  status?: StepStatus;
  output?: unknown;
  explanation?: unknown;
  error?: string | null;
  finishedAt?: Date | null;
}

export interface UpdateRunInput {
  status?: RunStatus;
  cursor?: string | null;
  error?: string | null;
}

export interface AppendAuditInput {
  runId: string;
  stepExecutionId?: string | null;
  type: AuditEventType;
  payload: unknown;
}

export interface RecordLlmCallInput {
  runId: string;
  stepExecutionId?: string | null;
  provider: string;
  model: string;
  prompt: string;
  response: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status: "SUCCESS" | "ERROR";
  error: string | null;
}

export interface InsertExternalActionInput {
  idempotencyKey: string;
  runId: string;
  stepId: string;
  request: unknown;
  response: unknown;
}

export interface InsertExternalActionResult {
  /** False when the key already existed — a duplicate write was prevented. */
  created: boolean;
  record: ExternalActionRecord;
}

/** Everything the engine needs from persistence. It depends on this interface only, never
 *  on Prisma, so the whole engine suite runs against MemoryRunStore with no database. */
export interface RunStore {
  getWorkflowVersion(id: string): Promise<WorkflowVersionRecord | null>;

  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  updateRun(runId: string, patch: UpdateRunInput): Promise<RunRecord>;

  /** Conditional acquire; false when another worker holds an unexpired lock. `now` comes from
   *  the caller so no implementation reads an ambient clock and stops being a lock. */
  acquireLock(
    runId: string,
    token: string,
    now: Date,
    until: Date,
  ): Promise<boolean>;
  releaseLock(runId: string, token: string): Promise<void>;

  /** Every attempt in creation order, oldest first. Load-bearing: the runner reads the last
   *  row per stepId, so an unstable sort re-executes completed steps. Tiebreak required. */
  listStepExecutions(runId: string): Promise<StepExecutionRecord[]>;
  createStepExecution(input: CreateStepExecutionInput): Promise<StepExecutionRecord>;
  updateStepExecution(
    id: string,
    patch: UpdateStepExecutionInput,
  ): Promise<StepExecutionRecord>;

  createApproval(
    stepExecutionId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string | null,
  ): Promise<ApprovalRecord>;
  getApproval(stepExecutionId: string): Promise<ApprovalRecord | null>;

  appendAudit(input: AppendAuditInput): Promise<AuditEventRecord>;
  listAudit(runId: string): Promise<AuditEventRecord[]>;

  recordLlmCall(input: RecordLlmCallInput): Promise<LlmCallRecord>;
  countLlmCalls(runId: string): Promise<number>;
  listLlmCalls(runId: string): Promise<LlmCallRecord[]>;

  /** Insert-if-absent on idempotencyKey. Never overwrites an existing row. */
  insertExternalAction(
    input: InsertExternalActionInput,
  ): Promise<InsertExternalActionResult>;
}

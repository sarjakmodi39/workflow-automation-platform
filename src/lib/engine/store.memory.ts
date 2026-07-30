import { ConflictError, NotFoundError } from "@/lib/errors";
import type {
  AppendAuditInput,
  CreateRunInput,
  CreateStepExecutionInput,
  InsertExternalActionInput,
  InsertExternalActionResult,
  RecordLlmCallInput,
  RunStore,
  UpdateRunInput,
  UpdateStepExecutionInput,
} from "@/lib/engine/store";
import type {
  ApprovalRecord,
  AuditEventRecord,
  ExternalActionRecord,
  LlmCallRecord,
  RunRecord,
  StepExecutionRecord,
  WorkflowVersionRecord,
} from "@/lib/types";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export interface MemorySeed {
  versions?: WorkflowVersionRecord[];
}

export class MemoryRunStore implements RunStore {
  private versions = new Map<string, WorkflowVersionRecord>();
  private runs = new Map<string, RunRecord>();
  private steps: StepExecutionRecord[] = [];
  private approvals = new Map<string, ApprovalRecord>();
  private audit: AuditEventRecord[] = [];
  private llmCalls: LlmCallRecord[] = [];
  private externalActions = new Map<string, ExternalActionRecord>();

  constructor(seed: MemorySeed = {}) {
    for (const v of seed.versions ?? []) this.versions.set(v.id, v);
  }

  async getWorkflowVersion(id: string): Promise<WorkflowVersionRecord | null> {
    return this.versions.get(id) ?? null;
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const now = new Date();
    const run: RunRecord = {
      id: nextId("run"),
      workflowVersionId: input.workflowVersionId,
      status: "PENDING",
      input: input.input,
      cursor: null,
      lockToken: null,
      lockedUntil: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return { ...run };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  async updateRun(runId: string, patch: UpdateRunInput): Promise<RunRecord> {
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundError(`Run ${runId}`);
    if (patch.status !== undefined) run.status = patch.status;
    if (patch.cursor !== undefined) run.cursor = patch.cursor;
    if (patch.error !== undefined) run.error = patch.error;
    run.updatedAt = new Date();
    return { ...run };
  }

  // `now` comes from the caller, never from Date.now(): the runner takes its
  // clock from RunnerDeps, and a store that judged expiry on the ambient clock
  // would treat every lock written on an injected timeline as already stale.
  async acquireLock(
    runId: string,
    token: string,
    now: Date,
    until: Date,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundError(`Run ${runId}`);
    const held =
      run.lockToken !== null &&
      run.lockedUntil !== null &&
      run.lockedUntil.getTime() > now.getTime();
    if (held) return false;
    run.lockToken = token;
    run.lockedUntil = until;
    return true;
  }

  // Deliberately asymmetric with acquireLock: release is idempotent, so a
  // missing run (or a token mismatch) is a silent no-op rather than a
  // NotFoundError. Task 12's Prisma implementation must reproduce this.
  async releaseLock(runId: string, token: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.lockToken !== token) return;
    run.lockToken = null;
    run.lockedUntil = null;
  }

  // Insertion order into `this.steps` is creation order, which is exactly the
  // ordering the interface requires — the runner's skip rule reads the last row
  // per stepId. Task 12 has to reproduce it with an explicit, tiebroken orderBy.
  async listStepExecutions(runId: string): Promise<StepExecutionRecord[]> {
    return this.steps.filter((s) => s.runId === runId).map((s) => ({ ...s }));
  }

  async createStepExecution(
    input: CreateStepExecutionInput,
  ): Promise<StepExecutionRecord> {
    const record: StepExecutionRecord = {
      id: nextId("step"),
      runId: input.runId,
      stepId: input.stepId,
      stepType: input.stepType,
      status: input.status,
      attempt: input.attempt,
      retrySafe: input.retrySafe,
      input: input.input,
      output: null,
      explanation: null,
      error: null,
      startedAt: new Date(),
      finishedAt: null,
    };
    this.steps.push(record);
    return { ...record };
  }

  async updateStepExecution(
    id: string,
    patch: UpdateStepExecutionInput,
  ): Promise<StepExecutionRecord> {
    const record = this.steps.find((s) => s.id === id);
    if (!record) throw new NotFoundError(`StepExecution ${id}`);
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.output !== undefined) record.output = patch.output;
    if (patch.explanation !== undefined) record.explanation = patch.explanation;
    if (patch.error !== undefined) record.error = patch.error;
    if (patch.finishedAt !== undefined) record.finishedAt = patch.finishedAt;
    return { ...record };
  }

  /**
   * Mirrors the `@unique` constraint on `Approval.stepExecutionId` in
   * prisma/schema.prisma. A step execution may be decided once; a second
   * call must fail loudly here exactly as it will fail with P2002 against
   * Postgres, rather than silently overwriting the first decision.
   */
  async createApproval(
    stepExecutionId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string | null,
  ): Promise<ApprovalRecord> {
    if (this.approvals.has(stepExecutionId)) {
      throw new ConflictError(
        `Approval already recorded for step execution ${stepExecutionId}`,
      );
    }
    const record: ApprovalRecord = {
      id: nextId("appr"),
      stepExecutionId,
      decision,
      reason,
      decidedAt: new Date(),
    };
    this.approvals.set(stepExecutionId, record);
    return { ...record };
  }

  async getApproval(stepExecutionId: string): Promise<ApprovalRecord | null> {
    return this.approvals.get(stepExecutionId) ?? null;
  }

  async appendAudit(input: AppendAuditInput): Promise<AuditEventRecord> {
    const record: AuditEventRecord = {
      id: nextId("evt"),
      runId: input.runId,
      stepExecutionId: input.stepExecutionId ?? null,
      type: input.type,
      payload: input.payload,
      createdAt: new Date(),
    };
    this.audit.push(record);
    return { ...record };
  }

  async listAudit(runId: string): Promise<AuditEventRecord[]> {
    return this.audit.filter((e) => e.runId === runId).map((e) => ({ ...e }));
  }

  async recordLlmCall(input: RecordLlmCallInput): Promise<LlmCallRecord> {
    const record: LlmCallRecord = {
      id: nextId("llm"),
      runId: input.runId,
      stepExecutionId: input.stepExecutionId ?? null,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      response: input.response,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      latencyMs: input.latencyMs,
      status: input.status,
      error: input.error,
      createdAt: new Date(),
    };
    this.llmCalls.push(record);
    return { ...record };
  }

  async countLlmCalls(runId: string): Promise<number> {
    return this.llmCalls.filter((c) => c.runId === runId).length;
  }

  async listLlmCalls(runId: string): Promise<LlmCallRecord[]> {
    return this.llmCalls.filter((c) => c.runId === runId).map((c) => ({ ...c }));
  }

  async insertExternalAction(
    input: InsertExternalActionInput,
  ): Promise<InsertExternalActionResult> {
    const existing = this.externalActions.get(input.idempotencyKey);
    if (existing) return { created: false, record: { ...existing } };

    const record: ExternalActionRecord = {
      id: nextId("ext"),
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      stepId: input.stepId,
      request: input.request,
      response: input.response,
      createdAt: new Date(),
    };
    this.externalActions.set(input.idempotencyKey, record);
    return { created: true, record: { ...record } };
  }
}

export function createMemoryStore(seed: MemorySeed = {}): MemoryRunStore {
  return new MemoryRunStore(seed);
}

import { Prisma } from "@prisma/client";
import type {
  Approval as ApprovalRow,
  AuditEvent as AuditEventRow,
  ExternalAction as ExternalActionRow,
  LlmCall as LlmCallRow,
  Run as RunRow,
  StepExecution as StepExecutionRow,
  WorkflowVersion as WorkflowVersionRow,
} from "@prisma/client";
import { prisma } from "@/lib/db";
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
  AuditEventType,
  ExternalActionRecord,
  LlmCallRecord,
  RunRecord,
  StepExecutionRecord,
  StepType,
  WorkflowDefinition,
  WorkflowVersionRecord,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* JSON boundary                                                              */
/* -------------------------------------------------------------------------- */

/** The file's only JSON casts. `Json?` takes DbNull (real SQL NULL), `Json` takes
 *  JsonNull; both read back as `null`, matching MemoryRunStore for an absent payload. */
export function nullableJson(
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (value === null || value === undefined) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

export function requiredJson(
  value: unknown,
): Prisma.InputJsonValue | Prisma.JsonNullValueInput {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

/** `WorkflowVersion.grantedPermissions` is a JSON array; validated on read. */
function toPermissions(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/* -------------------------------------------------------------------------- */
/* Error translation                                                          */
/* -------------------------------------------------------------------------- */

/** One error taxonomy whichever store is behind the interface. Only P2002 -> Conflict
 *  and P2025 -> NotFound are translated; anything else propagates untouched. */
function isPrismaError(
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

/* -------------------------------------------------------------------------- */
/* Row -> record mapping                                                      */
/* -------------------------------------------------------------------------- */

/* Rows are mapped field by field, never returned raw: a raw row leaks relation scalars,
 * and `stepType` / `type` are String columns needing narrowing to their domain unions. */

function toWorkflowVersion(row: WorkflowVersionRow): WorkflowVersionRecord {
  return {
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    // The one shape assertion here: a JSON column has no static type, and
    // `validateWorkflow` already ran before any run started, so no re-validation.
    definition: row.definition as unknown as WorkflowDefinition,
    grantedPermissions: toPermissions(row.grantedPermissions),
    createdAt: row.createdAt,
  };
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    workflowVersionId: row.workflowVersionId,
    status: row.status,
    input: row.input,
    cursor: row.cursor,
    lockToken: row.lockToken,
    lockedUntil: row.lockedUntil,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStepExecution(row: StepExecutionRow): StepExecutionRecord {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    // `stepType` is a String column, not an enum, so the union is narrowed here.
    stepType: row.stepType as StepType,
    status: row.status,
    attempt: row.attempt,
    retrySafe: row.retrySafe,
    input: row.input,
    output: row.output,
    explanation: row.explanation,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function toApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    stepExecutionId: row.stepExecutionId,
    decision: row.decision,
    reason: row.reason,
    decidedAt: row.decidedAt,
  };
}

function toAuditEvent(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    runId: row.runId,
    stepExecutionId: row.stepExecutionId,
    // `type` is a String column, not an enum, so the union is narrowed here.
    type: row.type as AuditEventType,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

function toLlmCall(row: LlmCallRow): LlmCallRecord {
  return {
    id: row.id,
    runId: row.runId,
    stepExecutionId: row.stepExecutionId,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    response: row.response,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
  };
}

function toExternalAction(row: ExternalActionRow): ExternalActionRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    runId: row.runId,
    stepId: row.stepId,
    request: row.request,
    response: row.response,
    createdAt: row.createdAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

/** Production `RunStore`; behaviour must match `MemoryRunStore` method for method, since
 *  the engine suite runs against memory. Only the lock acquire and ledger insert need SQL. */
export class PrismaRunStore implements RunStore {
  async getWorkflowVersion(id: string): Promise<WorkflowVersionRecord | null> {
    const row = await prisma.workflowVersion.findUnique({ where: { id } });
    return row ? toWorkflowVersion(row) : null;
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const row = await prisma.run.create({
      data: {
        workflowVersionId: input.workflowVersionId,
        status: "PENDING",
        input: requiredJson(input.input),
      },
    });
    return toRun(row);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = await prisma.run.findUnique({ where: { id: runId } });
    return row ? toRun(row) : null;
  }

  /** Patch semantics: an absent key leaves the column alone; `null` clears it. */
  async updateRun(runId: string, patch: UpdateRunInput): Promise<RunRecord> {
    try {
      const row = await prisma.run.update({
        where: { id: runId },
        data: {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
        },
      });
      return toRun(row);
    } catch (error) {
      // MemoryRunStore throws NotFoundError for a missing run; Prisma raises
      // P2025. Same condition, so the same error must come out.
      if (isPrismaError(error, "P2025")) throw new NotFoundError(`Run ${runId}`);
      throw error;
    }
  }

  /** Conditional acquire as one UPDATE; `updateMany` reports a row count instead of throwing,
   *  and the `where` is the exact negation of the memory store's `held` predicate. */
  async acquireLock(
    runId: string,
    token: string,
    now: Date,
    until: Date,
  ): Promise<boolean> {
    const result = await prisma.run.updateMany({
      where: {
        id: runId,
        OR: [
          { lockToken: null },
          { lockedUntil: null },
          { lockedUntil: { lte: now } },
        ],
      },
      data: { lockToken: token, lockedUntil: until },
    });
    if (result.count > 0) return true;

    // Zero conflates "locked" with "no such run", which the memory store distinguishes.
    // Not a race: the write was already attempted and refused; this only names the failure.
    const exists = await prisma.run.findUnique({
      where: { id: runId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError(`Run ${runId}`);
    return false;
  }

  /** Asymmetric with `acquireLock` by design: release is idempotent, so a missing run or
   *  token mismatch is a silent no-op — both keys in the `where` gets that for free. */
  async releaseLock(runId: string, token: string): Promise<void> {
    await prisma.run.updateMany({
      where: { id: runId, lockToken: token },
      data: { lockToken: null, lockedUntil: null },
    });
  }

  /** Creation order with a deterministic tiebreak: ms-precision timestamps collide, so
   *  `attempt` then `id` break ties, and `nulls: "first"` keeps a null row from masking. */
  async listStepExecutions(runId: string): Promise<StepExecutionRecord[]> {
    const rows = await prisma.stepExecution.findMany({
      where: { runId },
      orderBy: [
        { startedAt: { sort: "asc", nulls: "first" } },
        { attempt: "asc" },
        { id: "asc" },
      ],
    });
    return rows.map(toStepExecution);
  }

  /** `@@unique([runId, stepId, attempt])` makes attempt numbering safe; P2002 becomes the
   *  same ConflictError the memory store raises rather than leaking a Prisma type. */
  async createStepExecution(
    input: CreateStepExecutionInput,
  ): Promise<StepExecutionRecord> {
    try {
      const row = await prisma.stepExecution.create({
        data: {
          runId: input.runId,
          stepId: input.stepId,
          stepType: input.stepType,
          status: input.status,
          attempt: input.attempt,
          retrySafe: input.retrySafe,
          input: nullableJson(input.input),
          // No database default, and the memory store stamps it at insert;
          // matching that is the point.
          startedAt: new Date(),
        },
      });
      return toStepExecution(row);
    } catch (error) {
      if (isPrismaError(error, "P2002")) {
        throw new ConflictError(
          `Step execution already exists for run ${input.runId} step ${input.stepId} attempt ${input.attempt}`,
        );
      }
      throw error;
    }
  }

  async updateStepExecution(
    id: string,
    patch: UpdateStepExecutionInput,
  ): Promise<StepExecutionRecord> {
    try {
      const row = await prisma.stepExecution.update({
        where: { id },
        data: {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.output !== undefined
            ? { output: nullableJson(patch.output) }
            : {}),
          ...(patch.explanation !== undefined
            ? { explanation: nullableJson(patch.explanation) }
            : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.finishedAt !== undefined
            ? { finishedAt: patch.finishedAt }
            : {}),
        },
      });
      return toStepExecution(row);
    } catch (error) {
      if (isPrismaError(error, "P2025")) {
        throw new NotFoundError(`StepExecution ${id}`);
      }
      throw error;
    }
  }

  /** `Approval.stepExecutionId` is `@unique`: a gate is decided once. A second decision
   *  must fail with ConflictError, not overwrite — a replaced decision is a governance failure. */
  async createApproval(
    stepExecutionId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string | null,
  ): Promise<ApprovalRecord> {
    try {
      const row = await prisma.approval.create({
        data: { stepExecutionId, decision, reason },
      });
      return toApproval(row);
    } catch (error) {
      if (isPrismaError(error, "P2002")) {
        throw new ConflictError(
          `Approval already recorded for step execution ${stepExecutionId}`,
        );
      }
      throw error;
    }
  }

  async getApproval(stepExecutionId: string): Promise<ApprovalRecord | null> {
    const row = await prisma.approval.findUnique({ where: { stepExecutionId } });
    return row ? toApproval(row) : null;
  }

  async appendAudit(input: AppendAuditInput): Promise<AuditEventRecord> {
    const row = await prisma.auditEvent.create({
      data: {
        runId: input.runId,
        stepExecutionId: input.stepExecutionId ?? null,
        type: input.type,
        payload: requiredJson(input.payload),
      },
    });
    return toAuditEvent(row);
  }

  /** `createdAt` is millisecond-precision and events append in tight sequence, so `id`
   *  breaks the tie — otherwise the audit trail could reorder between reads. */
  async listAudit(runId: string): Promise<AuditEventRecord[]> {
    const rows = await prisma.auditEvent.findMany({
      where: { runId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toAuditEvent);
  }

  async recordLlmCall(input: RecordLlmCallInput): Promise<LlmCallRecord> {
    const row = await prisma.llmCall.create({
      data: {
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
      },
    });
    return toLlmCall(row);
  }

  async countLlmCalls(runId: string): Promise<number> {
    return prisma.llmCall.count({ where: { runId } });
  }

  async listLlmCalls(runId: string): Promise<LlmCallRecord[]> {
    const rows = await prisma.llmCall.findMany({
      where: { runId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toLlmCall);
  }

  /** Insert-if-absent via the `@unique` on `idempotencyKey`: insert first, catch the conflict.
   *  Read-then-create leaves a window where two workers both write — the double-write itself. */
  async insertExternalAction(
    input: InsertExternalActionInput,
  ): Promise<InsertExternalActionResult> {
    try {
      const row = await prisma.externalAction.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          runId: input.runId,
          stepId: input.stepId,
          request: requiredJson(input.request),
          response: requiredJson(input.response),
        },
      });
      return { created: true, record: toExternalAction(row) };
    } catch (error) {
      if (!isPrismaError(error, "P2002")) throw error;

      const existing = await prisma.externalAction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });

      // P2002 on another index, or the row was deleted. Reporting `created: false` would
      // claim the write was deduplicated when it was not, so surface the real cause.
      if (!existing) throw error;

      return { created: false, record: toExternalAction(existing) };
    }
  }
}

/** Shared instance. Holds no state of its own; the client singleton is in db.ts. */
export const prismaRunStore = new PrismaRunStore();

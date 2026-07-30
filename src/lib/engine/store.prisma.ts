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

/**
 * A JSON column is untyped in the database, so the engine's record types carry
 * `unknown` for every JSON payload. Prisma's `InputJsonValue` cannot express
 * `unknown`, so a cast is structurally unavoidable on the way in. Both casts
 * live here, in these two functions, and nowhere else in this file: every
 * *field* mapping below stays fully type-checked against the generated client,
 * which is what catches a mis-mapped column.
 *
 * Nullable and non-nullable JSON columns need different null sentinels:
 *
 *   - Nullable column (`Json?`): `Prisma.DbNull` writes a real SQL NULL.
 *   - Non-nullable column (`Json`): SQL NULL is not permitted, so the only
 *     available null is `Prisma.JsonNull` — the JSON value `null`.
 *
 * Both read back as JavaScript `null`, which is what `MemoryRunStore` stores
 * for an absent payload. `undefined` is folded into null on the way in so a
 * record can never come back holding `undefined` where memory holds `null`.
 */
function nullableJson(
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (value === null || value === undefined) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

function requiredJson(
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

/**
 * Callers must see one error taxonomy regardless of which store is behind the
 * interface, because the engine tests only ever exercise `MemoryRunStore`.
 * Only the two codes the interface actually has semantics for are translated:
 *
 *   P2002 — unique constraint violation  -> ConflictError
 *   P2025 — record required but not found -> NotFoundError
 *
 * Anything else propagates untouched. Inventing a domain error for, say, a
 * foreign-key violation would claim a parity with the memory store that does
 * not exist (see the constraint audit in the task report).
 */
function isPrismaError(
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

/* -------------------------------------------------------------------------- */
/* Row -> record mapping                                                      */
/* -------------------------------------------------------------------------- */

/*
 * Every row is mapped field by field rather than returned raw. Two reasons:
 * a raw row carries relation scalars the engine has no business seeing, and
 * `stepType` / `type` are `String` columns that have to be narrowed to their
 * domain unions — silently returning the row would leave those unions unproven.
 */

function toWorkflowVersion(row: WorkflowVersionRow): WorkflowVersionRecord {
  return {
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    // The one shape assertion in this file. A JSON column has no static type,
    // and the definition is validated by `validateWorkflow` before a run is
    // ever started, so this store does not re-validate (nor does the memory
    // store, which holds an already-typed record).
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

/**
 * Production `RunStore`. Behaviour must match `MemoryRunStore` method for
 * method — including which calls throw and which are silent no-ops — because
 * the entire engine suite runs against the memory store and would otherwise be
 * verifying semantics this class does not have.
 *
 * Two operations rely on database guarantees rather than read-then-write, and
 * they are the reason this class exists at all: the conditional lock acquire
 * and the insert-if-absent for external actions.
 */
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

  /**
   * Conditional acquire, as a single UPDATE. `updateMany` is used rather than
   * `update` precisely because it reports a row count instead of throwing on a
   * no-match: the row count *is* the answer.
   *
   * The `where` clause is the exact negation of the memory store's `held`
   * predicate (`lockToken !== null && lockedUntil !== null && lockedUntil >
   * now`). The `lockedUntil: null` branch matters even though this store never
   * writes that combination: without it, a row carrying a token but no expiry
   * would be locked forever against Postgres while the memory store treats it
   * as free — a stuck run that no test could ever reproduce.
   *
   * `lte`, not `lt`: the memory store frees the lock the instant
   * `lockedUntil === now`.
   */
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

    // A count of zero conflates "someone holds the lock" with "no such run",
    // and the memory store distinguishes them: it throws NotFoundError for a
    // missing run, and `retryStep` reports a busy run as a ConflictError, so
    // collapsing the two would report a nonexistent run as merely busy.
    //
    // This extra read is not the read-then-write race the conditional UPDATE
    // exists to prevent: the write has already been attempted and refused, and
    // this only chooses between two ways of having failed.
    const exists = await prisma.run.findUnique({
      where: { id: runId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError(`Run ${runId}`);
    return false;
  }

  /**
   * Deliberately asymmetric with `acquireLock`: release is idempotent, so a
   * missing run or a token mismatch is a silent no-op rather than an error.
   * Putting both `id` and `lockToken` in the `where` gets that for free — a
   * non-matching token simply updates nothing.
   */
  async releaseLock(runId: string, token: string): Promise<void> {
    await prisma.run.updateMany({
      where: { id: runId, lockToken: token },
      data: { lockToken: null, lockedUntil: null },
    });
  }

  /**
   * Creation order, with the deterministic tiebreak the interface requires.
   *
   * The runner's skip rule takes the *last* row per `stepId`, so an unstable
   * order here re-executes completed steps. `startedAt` alone is not enough:
   * Prisma maps `DateTime` to millisecond precision, and two attempts of the
   * same step routinely land in the same millisecond, so `attempt` and then
   * `id` break the tie.
   *
   * `nulls: "first"` guards a row written outside this store (a seed script)
   * with no `startedAt`: sorting such a row first means it can never mask the
   * later SUCCEEDED attempt that supersedes it. Postgres would otherwise sort
   * NULLs last in an ascending order and hand the runner the wrong row.
   */
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

  /**
   * `@@unique([runId, stepId, attempt])` is what makes attempt numbering safe.
   * The memory store raises ConflictError on a clash; P2002 is the same event,
   * so it becomes the same error rather than leaking a Prisma type to callers.
   */
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
          // `startedAt` has no database default, and the memory store stamps it
          // at insert. Matching that is the point; the interface has no `now`
          // parameter to thread through here.
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

  /**
   * `Approval.stepExecutionId` is `@unique`: a step execution may be decided
   * once. A second decision must fail, not overwrite — a silently replaced
   * approval decision is a governance failure, not a data-layer detail — and it
   * must fail with the same ConflictError the memory store raises.
   */
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

  /**
   * `createdAt` is millisecond-precision and several events are appended in a
   * tight sequence, so `id` breaks the tie. Without it the audit trail — the
   * artefact the whole platform exists to produce — could present two events
   * from the same millisecond in either order between reads.
   */
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

  /**
   * Insert-if-absent, enforced by the `@unique` on `idempotencyKey`.
   *
   * The insert is attempted first and the conflict is caught. Reading first and
   * then creating would leave a window in which two workers both see no row and
   * both write one — the exact double-write this ledger exists to prevent, and
   * a window a unique index closes and a `findUnique` does not.
   */
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

      // The P2002 was on some other unique index, or the row has since been
      // deleted. Either way there is no prior action to report, and returning
      // `created: false` with a fabricated record would tell the caller its
      // write was safely deduplicated when it was not. Surface the real cause.
      if (!existing) throw error;

      return { created: false, record: toExternalAction(existing) };
    }
  }
}

/** Shared instance. Holds no state of its own; the client singleton is in db.ts. */
export const prismaRunStore = new PrismaRunStore();

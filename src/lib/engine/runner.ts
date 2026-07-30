import type { ExecutionContext } from "@/lib/engine/context";
import { assertPermitted } from "@/lib/engine/permissions";
import { getStepSpec } from "@/lib/engine/registry";
import type { RunStore } from "@/lib/engine/store";
import { ConflictError, NotFoundError, isAppError, toErrorMessage } from "@/lib/errors";
import type { LlmProvider } from "@/lib/llm/types";
import { HANDLERS } from "@/lib/steps";
import type {
  RunRecord,
  StepDefinition,
  StepExecutionRecord,
  WorkflowVersionRecord,
} from "@/lib/types";

export interface RunnerDeps {
  store: RunStore;
  providers: LlmProvider[];
  maxLlmCalls: number;
  /** Wall-clock budget for a single advanceRun call. */
  budgetMs: number;
  /** How long the run lock is held. */
  lockMs: number;
  /** Total attempts permitted for an auto-retryable step, including the first. */
  maxAutoAttempts: number;
  now: () => Date;
  newToken: () => string;
}

const TERMINAL: RunRecord["status"][] = ["COMPLETED", "FAILED", "CANCELLED"];

/** Resumable: FAILED (cause addressed), RUNNING (tick ran out of budget),
 *  PENDING (created but never advanced). */
const RESUMABLE: RunRecord["status"][] = ["PENDING", "RUNNING", "FAILED"];

/** Highest attempt per step id. Keyed on `attempt`, never list order: ordering is
 *  by `startedAt`, so clock skew could let a stale FAILED row win and re-execute. */
function latestByStep(
  steps: StepExecutionRecord[],
): Map<string, StepExecutionRecord> {
  const map = new Map<string, StepExecutionRecord>();
  for (const s of steps) {
    const seen = map.get(s.stepId);
    if (!seen || s.attempt >= seen.attempt) map.set(s.stepId, s);
  }
  return map;
}

export function buildContext(
  run: RunRecord,
  steps: StepExecutionRecord[],
): ExecutionContext {
  const ctx: ExecutionContext = { input: run.input, steps: {} };
  for (const step of steps) {
    if (step.status === "SUCCEEDED") ctx.steps[step.stepId] = step.output;
  }
  return ctx;
}

function findStep(
  version: WorkflowVersionRecord,
  stepId: string,
): StepDefinition | undefined {
  return version.definition.steps.find((s) => s.id === stepId);
}

function stepAfter(
  version: WorkflowVersionRecord,
  stepId: string,
): string | null {
  const steps = version.definition.steps;
  const index = steps.findIndex((s) => s.id === stepId);
  if (index === -1 || index === steps.length - 1) return null;
  return steps[index + 1].id;
}

async function requireRun(deps: RunnerDeps, runId: string): Promise<RunRecord> {
  const run = await deps.store.getRun(runId);
  if (!run) throw new NotFoundError(`Run ${runId}`);
  return run;
}

async function loadVersion(
  deps: RunnerDeps,
  run: RunRecord,
): Promise<WorkflowVersionRecord> {
  const version = await deps.store.getWorkflowVersion(run.workflowVersionId);
  if (!version) throw new NotFoundError(`WorkflowVersion ${run.workflowVersionId}`);
  return version;
}

/** Takes the run lock, returning the token or null if another worker holds it.
 *  Lease and expiry both derive from deps.now(), so an injected clock is honoured. */
async function acquireRunLock(
  deps: RunnerDeps,
  runId: string,
): Promise<string | null> {
  const token = deps.newToken();
  const now = deps.now();
  const until = new Date(now.getTime() + deps.lockMs);
  const acquired = await deps.store.acquireLock(runId, token, now, until);
  return acquired ? token : null;
}

/** The decision on a gate, or null if undecided. Reads the Approval row (written first),
 *  never step status: a rejected gate is SUCCEEDED too, so status would step over a "no". */
async function recordedDecision(
  deps: RunnerDeps,
  execution: StepExecutionRecord,
): Promise<"APPROVED" | "REJECTED" | null> {
  const approval = await deps.store.getApproval(execution.id);
  if (approval) return approval.decision;

  const output = execution.output as { decision?: unknown } | null;
  if (output?.decision === "APPROVED") return "APPROVED";
  if (output?.decision === "REJECTED") return "REJECTED";
  return null;
}

/** The first gate a human rejected, if any. Scans the whole run, not just the cursor:
 *  a rejection is permanent and cursor-independent, so it is a run-wide invariant. */
async function findRejectedGate(
  deps: RunnerDeps,
  executions: StepExecutionRecord[],
): Promise<StepExecutionRecord | null> {
  for (const execution of executions) {
    if (execution.stepType !== "human_approval") continue;
    if ((await recordedDecision(deps, execution)) === "REJECTED") return execution;
  }
  return null;
}

/** Terminal stop for a rejected gate, shared by the decision and replay paths.
 *  Cursor stays on the gate so any future pass arrives back at the rejection. */
async function stopForRejection(
  deps: RunnerDeps,
  runId: string,
  stepId: string,
): Promise<RunRecord> {
  await deps.store.appendAudit({
    runId,
    type: "RUN_CANCELLED",
    payload: { reason: "Approval rejected", stepId },
  });
  return deps.store.updateRun(runId, {
    status: "CANCELLED",
    cursor: stepId,
    error: null,
  });
}

export async function startRun(
  deps: RunnerDeps,
  workflowVersionId: string,
  input: unknown,
): Promise<RunRecord> {
  const version = await deps.store.getWorkflowVersion(workflowVersionId);
  if (!version) throw new NotFoundError(`WorkflowVersion ${workflowVersionId}`);

  const run = await deps.store.createRun({ workflowVersionId, input });
  await deps.store.appendAudit({
    runId: run.id,
    type: "RUN_CREATED",
    payload: { workflowVersionId, input },
  });
  return run;
}

/** Executes one step and persists the outcome. Returns the next cursor,
 *  or null when the run should complete. */
async function executeStep(
  deps: RunnerDeps,
  run: RunRecord,
  version: WorkflowVersionRecord,
  step: StepDefinition,
  ctx: ExecutionContext,
  attempt: number,
): Promise<{ nextCursor: string | null; failed: boolean }> {
  const spec = getStepSpec(step.type);

  const execution = await deps.store.createStepExecution({
    runId: run.id,
    stepId: step.id,
    stepType: step.type,
    status: "RUNNING",
    attempt,
    retrySafe: spec.retrySafe,
    input: step.config,
  });

  await deps.store.appendAudit({
    runId: run.id,
    stepExecutionId: execution.id,
    type: "STEP_STARTED",
    payload: { stepId: step.id, stepType: step.type, attempt },
  });

  try {
    assertPermitted(step, version.grantedPermissions);

    const handler = HANDLERS[step.type];
    const result = await handler(step, {
      store: deps.store,
      runId: run.id,
      stepExecutionId: execution.id,
      providers: deps.providers,
      maxLlmCalls: deps.maxLlmCalls,
      ctx,
      now: deps.now,
    });

    await deps.store.updateStepExecution(execution.id, {
      status: "SUCCEEDED",
      output: result.output,
      explanation: result.explanation ?? null,
      finishedAt: deps.now(),
    });

    await deps.store.appendAudit({
      runId: run.id,
      stepExecutionId: execution.id,
      type: "STEP_SUCCEEDED",
      payload: { stepId: step.id, output: result.output },
    });

    ctx.steps[step.id] = result.output;

    const next =
      result.nextStepId !== undefined
        ? result.nextStepId === "end"
          ? null
          : result.nextStepId
        : stepAfter(version, step.id);

    return { nextCursor: next, failed: false };
  } catch (error) {
    const message = toErrorMessage(error);
    const isPermission = isAppError(error) && error.code === "PERMISSION_DENIED";

    await deps.store.updateStepExecution(execution.id, {
      status: "FAILED",
      error: message,
      finishedAt: deps.now(),
    });

    if (isPermission) {
      await deps.store.appendAudit({
        runId: run.id,
        stepExecutionId: execution.id,
        type: "PERMISSION_DENIED",
        payload: { stepId: step.id, error: message },
      });
    }

    await deps.store.appendAudit({
      runId: run.id,
      stepExecutionId: execution.id,
      type: "STEP_FAILED",
      payload: {
        stepId: step.id,
        attempt,
        error: message,
        retryable: isAppError(error) ? error.retryable : false,
        retrySafe: spec.retrySafe,
      },
    });

    const canAutoRetry =
      spec.retrySafe &&
      isAppError(error) &&
      error.retryable &&
      attempt < deps.maxAutoAttempts;

    if (canAutoRetry) {
      await deps.store.appendAudit({
        runId: run.id,
        stepExecutionId: execution.id,
        type: "RETRY_ATTEMPTED",
        payload: { stepId: step.id, attempt: attempt + 1, automatic: true },
      });
      return executeStep(deps, run, version, step, ctx, attempt + 1);
    }

    return { nextCursor: null, failed: true };
  }
}

/** Parks the run at an approval gate, reusing an existing undecided one so a repeated
 *  tick cannot leave two decidable records for one logical approval. */
async function park(
  deps: RunnerDeps,
  runId: string,
  step: StepDefinition,
  previous: StepExecutionRecord | undefined,
): Promise<RunRecord> {
  if (previous?.status !== "AWAITING_APPROVAL") {
    const execution = await deps.store.createStepExecution({
      runId,
      stepId: step.id,
      stepType: step.type,
      status: "AWAITING_APPROVAL",
      attempt: (previous?.attempt ?? 0) + 1,
      retrySafe: true,
      input: step.config,
    });
    await deps.store.appendAudit({
      runId,
      stepExecutionId: execution.id,
      type: "APPROVAL_REQUESTED",
      payload: { stepId: step.id, prompt: step.config.prompt },
    });
  }

  return deps.store.updateRun(runId, {
    status: "AWAITING_APPROVAL",
    cursor: step.id,
  });
}

/** Drives the run until a gate, terminal state, failure, or the wall-clock budget;
 *  every transition is persisted first. Assumes the run lock is already held. */
async function drive(deps: RunnerDeps, runId: string): Promise<RunRecord> {
  let run = await requireRun(deps, runId);
  if (TERMINAL.includes(run.status) || run.status === "AWAITING_APPROVAL") {
    return run;
  }

  const version = await loadVersion(deps, run);
  const executions = await deps.store.listStepExecutions(runId);

  // Before any cursor is honoured: a rejection anywhere in this run outranks
  // the cursor, whoever set it and however the run got back to RUNNING.
  const rejected = await findRejectedGate(deps, executions);
  if (rejected) return await stopForRejection(deps, runId, rejected.stepId);

  const ctx = buildContext(run, executions);
  const latest = latestByStep(executions);

  let cursor: string | null = run.cursor ?? version.definition.steps[0]?.id ?? null;
  run = await deps.store.updateRun(runId, { status: "RUNNING", cursor });

  // Clock comes from deps so tests can control it and so the budget is never
  // read from an ambient source the caller cannot see.
  const deadline = deps.now().getTime() + deps.budgetMs;

  while (cursor !== null) {
    if (deps.now().getTime() > deadline) {
      // Out of budget, not out of work. The cursor is already persisted, so
      // the next tick picks up exactly here.
      return await deps.store.updateRun(runId, { status: "RUNNING", cursor });
    }

    const step = findStep(version, cursor);
    if (!step) {
      return await completeRun(deps, runId);
    }

    const previous = latest.get(step.id);

    if (step.type === "human_approval") {
      const decision = previous ? await recordedDecision(deps, previous) : null;

      // Second line of defence behind the run-wide scan. Redundant by design:
      // one extra read costs nothing next to walking past a human "no".
      if (decision === "REJECTED") {
        return await stopForRejection(deps, runId, step.id);
      }
      if (decision === null) {
        return await park(deps, runId, step, previous);
      }
      // Approved — fall through to the skip rule below.
    }

    if (previous?.status === "SUCCEEDED") {
      // Already done on an earlier pass. Replay its output into the context
      // and its branch decision into the cursor, but never re-execute it.
      ctx.steps[step.id] = previous.output;
      const explanation = previous.explanation as { branchTaken?: string } | null;
      cursor =
        step.type === "deterministic_condition" && explanation?.branchTaken
          ? explanation.branchTaken === "end"
            ? null
            : explanation.branchTaken
          : stepAfter(version, step.id);
      await deps.store.updateRun(runId, { cursor });
      continue;
    }

    // Continue attempt numbering rather than restarting at 1: (runId, stepId, attempt)
    // is unique, so restarting makes the resume path a constraint violation.
    const { nextCursor, failed } = await executeStep(
      deps,
      run,
      version,
      step,
      ctx,
      (previous?.attempt ?? 0) + 1,
    );

    if (failed) {
      await deps.store.appendAudit({
        runId,
        type: "RUN_FAILED",
        payload: { stepId: step.id },
      });
      return await deps.store.updateRun(runId, {
        status: "FAILED",
        cursor: step.id,
        error: `Step "${step.id}" failed.`,
      });
    }

    cursor = nextCursor;
    await deps.store.updateRun(runId, { cursor });
  }

  return await completeRun(deps, runId);
}

/** One locked tick. Safe to call repeatedly; work already done is never redone. */
export async function advanceRun(
  deps: RunnerDeps,
  runId: string,
): Promise<RunRecord> {
  const token = await acquireRunLock(deps, runId);

  // Losing the race is normal for a background tick rather than an error: the
  // worker holding the lock is already making the progress this call wanted.
  if (token === null) return requireRun(deps, runId);

  try {
    return await drive(deps, runId);
  } finally {
    await releaseQuietly(deps, runId, token);
  }
}

/** Releases the lock without letting a fault in `finally` discard the caller's error
 *  (a 409 becoming an opaque 500). An unreleased lock expires on its own anyway. */
async function releaseQuietly(
  deps: RunnerDeps,
  runId: string,
  token: string,
): Promise<void> {
  try {
    await deps.store.releaseLock(runId, token);
  } catch {
    // Intentionally swallowed; see above. The lock expires on its own.
  }
}

async function completeRun(deps: RunnerDeps, runId: string): Promise<RunRecord> {
  await deps.store.appendAudit({ runId, type: "RUN_COMPLETED", payload: {} });
  return deps.store.updateRun(runId, {
    status: "COMPLETED",
    cursor: null,
    error: null,
  });
}

export async function decideApproval(
  deps: RunnerDeps,
  runId: string,
  stepExecutionId: string,
  decision: "APPROVED" | "REJECTED",
  reason: string | null,
): Promise<RunRecord> {
  const run = await requireRun(deps, runId);
  if (run.status !== "AWAITING_APPROVAL") {
    throw new ConflictError(`Run ${runId} is not awaiting approval.`);
  }

  const executions = await deps.store.listStepExecutions(runId);
  const execution = executions.find((s) => s.id === stepExecutionId);
  if (!execution) throw new NotFoundError(`StepExecution ${stepExecutionId}`);
  if (execution.status !== "AWAITING_APPROVAL") {
    throw new ConflictError(`Step ${execution.stepId} is not awaiting approval.`);
  }

  await deps.store.createApproval(stepExecutionId, decision, reason);
  await deps.store.updateStepExecution(stepExecutionId, {
    status: "SUCCEEDED",
    output: { decision, reason },
    finishedAt: deps.now(),
  });
  await deps.store.appendAudit({
    runId,
    stepExecutionId,
    type: "APPROVAL_DECIDED",
    payload: { stepId: execution.stepId, decision, reason },
  });

  // A rejection is a decision, not a fault: the step succeeded in producing an answer,
  // so the run stops CANCELLED (terminal, refused by resumeRun) rather than FAILED.
  if (decision === "REJECTED") {
    return stopForRejection(deps, runId, execution.stepId);
  }

  const version = await loadVersion(deps, run);
  await deps.store.updateRun(runId, {
    status: "RUNNING",
    cursor: stepAfter(version, execution.stepId),
  });

  return advanceRun(deps, runId);
}

export async function cancelRun(
  deps: RunnerDeps,
  runId: string,
): Promise<RunRecord> {
  const run = await requireRun(deps, runId);
  if (TERMINAL.includes(run.status)) return run;

  await deps.store.appendAudit({
    runId,
    type: "RUN_CANCELLED",
    payload: { previousStatus: run.status },
  });
  return deps.store.updateRun(runId, { status: "CANCELLED" });
}

/** Resumes a stopped run (FAILED, RUNNING, PENDING). Everything else is refused loudly:
 *  CANCELLED covers rejected approvals, AWAITING_APPROVAL needs a decision, COMPLETED is done. */
export async function resumeRun(
  deps: RunnerDeps,
  runId: string,
): Promise<RunRecord> {
  const run = await requireRun(deps, runId);

  if (run.status === "AWAITING_APPROVAL") {
    throw new ConflictError(
      `Run ${runId} is awaiting an approval decision and cannot be resumed.`,
    );
  }

  // CANCELLED covers two events with opposite fates: an operator meaning to return, and a
  // person saying no. Distinguished by the approval rows, never by the status alone.
  if (run.status === "CANCELLED") {
    const rejected = await findRejectedGate(
      deps,
      await deps.store.listStepExecutions(runId),
    );
    if (rejected) {
      throw new ConflictError(
        `Run ${runId} was stopped by a rejected approval and cannot be resumed.`,
      );
    }
  } else if (!RESUMABLE.includes(run.status)) {
    throw new ConflictError(
      `Run ${runId} is ${run.status} and cannot be resumed.`,
    );
  }

  await deps.store.appendAudit({
    runId,
    type: "RUN_RESUMED",
    payload: { previousStatus: run.status },
  });
  await deps.store.updateRun(runId, { status: "RUNNING", error: null });

  return advanceRun(deps, runId);
}

/** Manual retry of one failed step, permitted even when not auto-retry-safe because the
 *  idempotency ledger backs it. Holds the run lock across the tick that follows. */
export async function retryStep(
  deps: RunnerDeps,
  runId: string,
  stepExecutionId: string,
): Promise<RunRecord> {
  const token = await acquireRunLock(deps, runId);

  // An explicit operator command, unlike a background tick: an unchanged run would look
  // like a retry that ran and changed nothing, so a busy run fails loudly instead.
  if (token === null) {
    throw new ConflictError(
      `Run ${runId} is locked by another worker; retry once it is free.`,
    );
  }

  try {
    const run = await requireRun(deps, runId);

    const executions = await deps.store.listStepExecutions(runId);
    const execution = executions.find((s) => s.id === stepExecutionId);
    if (!execution) throw new NotFoundError(`StepExecution ${stepExecutionId}`);

    const rejected = await findRejectedGate(deps, executions);
    if (rejected) {
      throw new ConflictError(
        `Run ${runId} was stopped by a rejected approval and cannot be retried.`,
      );
    }

    const version = await loadVersion(deps, run);
    const step = findStep(version, execution.stepId);
    if (!step) throw new NotFoundError(`Step ${execution.stepId}`);

    await deps.store.appendAudit({
      runId,
      stepExecutionId,
      type: "RETRY_ATTEMPTED",
      payload: {
        stepId: execution.stepId,
        attempt: execution.attempt + 1,
        automatic: false,
        retrySafe: execution.retrySafe,
      },
    });

    const ctx = buildContext(run, executions);
    const { nextCursor, failed } = await executeStep(
      deps,
      run,
      version,
      step,
      ctx,
      execution.attempt + 1,
    );

    if (failed) {
      return await deps.store.updateRun(runId, {
        status: "FAILED",
        cursor: step.id,
        error: `Step "${step.id}" failed on retry.`,
      });
    }

    await deps.store.updateRun(runId, {
      status: "RUNNING",
      cursor: nextCursor,
      error: null,
    });

    return await drive(deps, runId);
  } finally {
    await releaseQuietly(deps, runId, token);
  }
}

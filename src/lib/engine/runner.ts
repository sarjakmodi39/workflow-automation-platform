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

/** Latest attempt per step id, in creation order. */
function latestByStep(
  steps: StepExecutionRecord[],
): Map<string, StepExecutionRecord> {
  const map = new Map<string, StepExecutionRecord>();
  for (const s of steps) map.set(s.stepId, s);
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

async function loadVersion(
  deps: RunnerDeps,
  run: RunRecord,
): Promise<WorkflowVersionRecord> {
  const version = await deps.store.getWorkflowVersion(run.workflowVersionId);
  if (!version) throw new NotFoundError(`WorkflowVersion ${run.workflowVersionId}`);
  return version;
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

/**
 * Executes one step and persists the outcome.
 * Returns the next cursor, or null when the run should complete.
 */
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

/**
 * Drives the run forward until it hits an approval gate, a terminal state,
 * a step failure, or the wall-clock budget. Every transition is persisted,
 * so the run is always resumable from storage alone.
 */
export async function advanceRun(
  deps: RunnerDeps,
  runId: string,
): Promise<RunRecord> {
  const token = deps.newToken();
  const until = new Date(deps.now().getTime() + deps.lockMs);

  const acquired = await deps.store.acquireLock(runId, token, until);
  if (!acquired) {
    const current = await deps.store.getRun(runId);
    if (!current) throw new NotFoundError(`Run ${runId}`);
    return current;
  }

  try {
    let run = await deps.store.getRun(runId);
    if (!run) throw new NotFoundError(`Run ${runId}`);
    if (TERMINAL.includes(run.status) || run.status === "AWAITING_APPROVAL") {
      return run;
    }

    const version = await loadVersion(deps, run);
    const executions = await deps.store.listStepExecutions(runId);
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

      if (step.type === "human_approval") {
        const execution = await deps.store.createStepExecution({
          runId,
          stepId: step.id,
          stepType: step.type,
          status: "AWAITING_APPROVAL",
          attempt: 1,
          retrySafe: true,
          input: step.config,
        });
        await deps.store.appendAudit({
          runId,
          stepExecutionId: execution.id,
          type: "APPROVAL_REQUESTED",
          payload: { stepId: step.id, prompt: step.config.prompt },
        });
        return await deps.store.updateRun(runId, {
          status: "AWAITING_APPROVAL",
          cursor: step.id,
        });
      }

      const { nextCursor, failed } = await executeStep(
        deps,
        run,
        version,
        step,
        ctx,
        1,
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
  } finally {
    await deps.store.releaseLock(runId, token);
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
  const run = await deps.store.getRun(runId);
  if (!run) throw new NotFoundError(`Run ${runId}`);
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

  // A rejection is a decision, not a fault: the approval step itself succeeded
  // in producing an answer, and the run stops as CANCELLED rather than FAILED.
  if (decision === "REJECTED") {
    await deps.store.appendAudit({
      runId,
      type: "RUN_CANCELLED",
      payload: { reason: "Approval rejected", stepId: execution.stepId },
    });
    return deps.store.updateRun(runId, {
      status: "CANCELLED",
      cursor: null,
      error: null,
    });
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
  const run = await deps.store.getRun(runId);
  if (!run) throw new NotFoundError(`Run ${runId}`);
  if (TERMINAL.includes(run.status)) return run;

  await deps.store.appendAudit({
    runId,
    type: "RUN_CANCELLED",
    payload: { previousStatus: run.status },
  });
  return deps.store.updateRun(runId, { status: "CANCELLED" });
}

export async function resumeRun(
  deps: RunnerDeps,
  runId: string,
): Promise<RunRecord> {
  const run = await deps.store.getRun(runId);
  if (!run) throw new NotFoundError(`Run ${runId}`);

  // The audit entry records the resume request, which is worth keeping even
  // when there is nothing left to resume — the operator did ask for it.
  await deps.store.appendAudit({
    runId,
    type: "RUN_RESUMED",
    payload: { previousStatus: run.status },
  });

  if (run.status === "COMPLETED") return run;

  await deps.store.updateRun(runId, { status: "RUNNING", error: null });

  return advanceRun(deps, runId);
}

/**
 * Manual retry of a single failed step. Permitted even for steps that are not
 * auto-retry-safe — the idempotency ledger is what makes that safe.
 */
export async function retryStep(
  deps: RunnerDeps,
  runId: string,
  stepExecutionId: string,
): Promise<RunRecord> {
  const run = await deps.store.getRun(runId);
  if (!run) throw new NotFoundError(`Run ${runId}`);

  const executions = await deps.store.listStepExecutions(runId);
  const execution = executions.find((s) => s.id === stepExecutionId);
  if (!execution) throw new NotFoundError(`StepExecution ${stepExecutionId}`);

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
    return deps.store.updateRun(runId, {
      status: "FAILED",
      cursor: step.id,
      error: `Step "${step.id}" failed on retry.`,
    });
  }

  await deps.store.updateRun(runId, { status: "RUNNING", cursor: nextCursor, error: null });
  return advanceRun(deps, runId);
}

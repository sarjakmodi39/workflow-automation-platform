"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApprovalPanel } from "@/app/runs/[id]/ApprovalPanel";
import { useRunDetail } from "@/app/runs/[id]/useRunDetail";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { EmptyState } from "@/components/EmptyState";
import { JsonBlock } from "@/components/JsonBlock";
import { InlineLoading, SkeletonRows, Spinner } from "@/components/Loading";
import { StatusBadge } from "@/components/StatusBadge";
import {
  postJson,
  toStepList,
  type ApiFailure,
  type AuditRow,
  type LlmCallRow,
  type RunControlResponse,
  type RunDetailResponse,
  type StepExecutionRow,
} from "@/lib/client-api";
import { REGISTRY } from "@/lib/engine/registry";
import { formatDuration, formatTimeOfDay, formatTimestamp } from "@/lib/format";
import type { StepType } from "@/lib/types";

/* The run detail page, and home of the tick loop: each POST drives one wall-clock-bounded
 * slice, so turning bounded ticks into visible progress is the client's job. */

/** One second between ticks: fast enough to feel live, slow enough to read. */
const TICK_INTERVAL_MS = 1000;

/** Hard ceiling on automatic ticks; unreachable in principle. Without it, a run stuck in
 *  RUNNING turns every open tab into a self-inflicted load test. Manual advance survives. */
const MAX_AUTOMATIC_TICKS = 60;

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];

type Tab = "steps" | "ai" | "audit";

/* -------------------------------------------------------------------------- */
/* Audit vocabulary                                                           */
/* -------------------------------------------------------------------------- */

/** Plain-language readings of audit event types, since the trail is the evidence a reviewer
 *  reads. Unlisted types fall back to their raw value so nothing can vanish. */
const AUDIT_LABELS: Record<string, string> = {
  RUN_CREATED: "Run created",
  STEP_STARTED: "Step started",
  STEP_SUCCEEDED: "Step succeeded",
  STEP_FAILED: "Step failed",
  LLM_CALL: "AI call",
  TOOL_CALL: "External action performed",
  APPROVAL_REQUESTED: "Approval requested",
  APPROVAL_DECIDED: "Approval decided by a person",
  RETRY_ATTEMPTED: "Retry attempted",
  DUPLICATE_WRITE_PREVENTED: "Duplicate external write prevented",
  PERMISSION_DENIED: "Permission denied",
  RUN_CANCELLED: "Run cancelled",
  RUN_RESUMED: "Run resumed",
  RUN_COMPLETED: "Run completed",
  RUN_FAILED: "Run failed",
};

/** Events that are the product's control story, not routine bookkeeping. */
const NOTABLE_AUDIT_TYPES = new Set([
  "APPROVAL_REQUESTED",
  "APPROVAL_DECIDED",
  "DUPLICATE_WRITE_PREVENTED",
  "PERMISSION_DENIED",
  "TOOL_CALL",
  "RETRY_ATTEMPTED",
]);

/* -------------------------------------------------------------------------- */
/* Small pieces                                                              */
/* -------------------------------------------------------------------------- */

function Tabs({
  tab,
  setTab,
  counts,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  counts: Record<Tab, number>;
}) {
  const labels: Record<Tab, string> = {
    steps: "Steps",
    ai: "AI calls",
    audit: "Audit trail",
  };
  return (
    <div role="tablist" aria-label="Run detail sections" className="flex flex-wrap gap-2">
      {(["steps", "ai", "audit"] as Tab[]).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => setTab(t)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            tab === t
              ? "bg-slate-900 text-white"
              : "bg-white text-slate-700 ring-1 ring-slate-200 ring-inset hover:bg-slate-50"
          }`}
        >
          {labels[t]}
          <span
            className={`ml-1.5 font-mono text-xs ${
              tab === t ? "text-slate-300" : "text-slate-400"
            }`}
          >
            {counts[t]}
          </span>
        </button>
      ))}
    </div>
  );
}

/** A step execution row. `stepName` comes from the definition keyed by `stepId`, since the
 *  row stores only the id and `extract_fields` wastes the name the author wrote. */
function StepRow({
  step,
  stepName,
  index,
}: {
  step: StepExecutionRow;
  stepName: string | undefined;
  index: number;
}) {
  const spec = REGISTRY[step.stepType as StepType];
  const duration = formatDuration(step.startedAt, step.finishedAt);

  // The ledger refused a second write — the most interesting thing the platform can
  // report about an external action, so it is called out, not buried in the output.
  const duplicatePrevented =
    !!step.output &&
    typeof step.output === "object" &&
    (step.output as { duplicatePrevented?: unknown }).duplicatePrevented === true;

  const branch =
    step.explanation && typeof step.explanation === "object"
      ? (step.explanation as { branchTaken?: unknown; description?: unknown })
      : null;

  const isApproval = step.stepType === "human_approval";

  return (
    <li
      className={`rounded-lg border p-4 ${
        isApproval
          ? "border-amber-300 border-l-4 border-l-amber-400 bg-amber-50/60"
          : step.status === "FAILED"
            ? "border-rose-200 border-l-4 border-l-rose-400 bg-white"
            : "border-slate-200 border-l-4 border-l-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-slate-900">
          <span className="mr-2 inline-block min-w-5 text-slate-400">{index + 1}.</span>
          {stepName ?? step.stepId}
        </h3>
        <StatusBadge status={step.status} />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{spec?.label ?? step.stepType}</span>
        <span className="font-mono">{step.stepId}</span>
        {step.attempt > 1 ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900">
            attempt {step.attempt}
          </span>
        ) : null}
        {!step.retrySafe ? (
          <span className="rounded bg-rose-100 px-1.5 py-0.5 font-medium text-rose-900">
            never retried automatically
          </span>
        ) : null}
        {duration ? <span>{duration}</span> : null}
        {step.startedAt ? <span>{formatTimeOfDay(step.startedAt)}</span> : null}
      </div>

      {step.error ? (
        <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 p-2.5 text-sm text-rose-900">
          {step.error}
        </p>
      ) : null}

      {step.approval ? (
        <div
          className={`mt-2 rounded-md border p-2.5 text-sm ${
            step.approval.decision === "APPROVED"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-rose-300 bg-rose-50 text-rose-900"
          }`}
        >
          <p className="font-semibold">
            {step.approval.decision === "APPROVED"
              ? "Approved by a person"
              : "Rejected by a person"}{" "}
            <span className="font-normal">
              · {formatTimestamp(step.approval.decidedAt)}
            </span>
          </p>
          <p className="mt-0.5">
            {step.approval.reason ? (
              <span className="italic">“{step.approval.reason}”</span>
            ) : (
              <span className="opacity-70">No reason was recorded.</span>
            )}
          </p>
        </div>
      ) : null}

      {duplicatePrevented ? (
        <p className="mt-2 rounded-md border border-emerald-300 bg-emerald-50 p-2.5 text-sm text-emerald-900">
          <span className="font-semibold">Duplicate write prevented.</span> This
          attempt matched an idempotency key already in the ledger, so the external
          action was not performed a second time — the stored result was returned
          instead.
        </p>
      ) : null}

      {typeof branch?.branchTaken === "string" ? (
        <p className="mt-2 rounded-md bg-slate-50 p-2.5 text-sm text-slate-700">
          Took the{" "}
          <span className="font-mono font-medium text-slate-900">
            {branch.branchTaken}
          </span>{" "}
          branch
          {typeof branch.description === "string" ? ` because ${branch.description}` : null}
        </p>
      ) : null}

      <JsonBlock value={step.output} label="output" />
      <JsonBlock value={step.explanation} label="explanation" />
    </li>
  );
}

/** One AI call, prompt and response included — that is what makes the AI auditable rather
 *  than asserted. Collapsed because long, and escaped because it is model output. */
function LlmCallRowView({
  call,
  stepLabel,
}: {
  call: LlmCallRow;
  stepLabel: string | null;
}) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-slate-900">
          {call.provider}
          <span className="ml-2 font-mono text-xs font-normal text-slate-500">
            {call.model}
          </span>
        </p>
        <StatusBadge status={call.status === "SUCCESS" ? "SUCCEEDED" : "FAILED"} />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        {stepLabel ? <span>{stepLabel}</span> : null}
        <span>{call.latencyMs} ms</span>
        <span>
          tokens in {call.inputTokens ?? "—"} · out {call.outputTokens ?? "—"}
        </span>
        <span>{formatTimeOfDay(call.createdAt)}</span>
      </div>

      {call.error ? (
        <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 p-2.5 text-sm text-rose-900">
          {call.error}
        </p>
      ) : null}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-900">
          Prompt and response
        </summary>
        <JsonBlock value={call.prompt} label="prompt" />
        {call.response === null ? (
          <p className="mt-2 text-xs text-slate-500">
            No response body was recorded — the call did not return one.
          </p>
        ) : (
          <JsonBlock value={call.response} label="raw response" />
        )}
      </details>
    </li>
  );
}

function AuditRowView({
  event,
  stepLabel,
}: {
  event: AuditRow;
  stepLabel: string | null;
}) {
  const notable = NOTABLE_AUDIT_TYPES.has(event.type);
  return (
    <li className={`p-3 ${notable ? "bg-amber-50/60" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium text-slate-900">
          {AUDIT_LABELS[event.type] ?? event.type}
          {stepLabel ? (
            <span className="ml-2 text-xs font-normal text-slate-500">{stepLabel}</span>
          ) : null}
        </p>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-slate-400">{event.type}</span>
          <span className="text-xs text-slate-500">
            {formatTimeOfDay(event.createdAt)}
          </span>
        </div>
      </div>
      {event.payload && Object.keys(event.payload as object).length > 0 ? (
        <JsonBlock value={event.payload} />
      ) : null}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Run view                                                                   */
/* -------------------------------------------------------------------------- */

export function RunView({ runId }: { runId: string }) {
  const { data, failure, refreshing, refresh } = useRunDetail(runId);

  const [tab, setTab] = useState<Tab>("steps");
  const [busy, setBusy] = useState<string | null>(null);
  const [controlFailure, setControlFailure] = useState<ApiFailure | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const [autoAdvance, setAutoAdvance] = useState(true);
  const [ticks, setTicks] = useState(0);
  const [tickFailure, setTickFailure] = useState<ApiFailure | null>(null);

  const status = data?.run.status;
  const isRunning = status === "RUNNING";
  const tickBudgetSpent = ticks >= MAX_AUTOMATIC_TICKS;

  // The tick loop. `ticks` is a dependency, and that is what makes it repeat: depending
  // only on run status fires once, since RUNNING never changes, and the run stalls.
  useEffect(() => {
    if (!isRunning || !autoAdvance || tickBudgetSpent) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const result = await postJson<RunControlResponse>(
          `/api/runs/${runId}/tick`,
          {},
        );

        if (!result.ok) {
          // Stop, do not retry: it will fail the same way, and hammering an unhealthy
          // server makes it worse. Shown with a manual advance button, so the reader decides.
          if (!cancelled) {
            setTickFailure(result.failure);
            setAutoAdvance(false);
          }
          return;
        }

        // The tick already happened server-side, so refresh even if cancelled mid-flight;
        // only loop-control updates are skipped. `refresh` has its own unmount guard.
        if (!cancelled) {
          setTickFailure(null);
          setTicks((n) => n + 1);
        }
        await refresh();
      })();
    }, TICK_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isRunning, autoAdvance, tickBudgetSpent, ticks, runId, refresh]);

  async function control(label: string, path: string, body: unknown = {}) {
    setBusy(label);
    setControlFailure(null);
    setConfirmation(null);

    const result = await postJson<RunControlResponse>(`/api/runs/${runId}${path}`, body);
    setBusy(null);

    if (!result.ok) {
      setControlFailure(result.failure);
      // Still refresh: a 409 means the run moved on, and the most useful thing
      // to show next to "not possible in the current state" is the state.
      await refresh();
      return;
    }

    setConfirmation(`${label} — the run is now ${result.data.run.status}.`);

    // Re-arm auto-advance and reset the budget, only here: every caller is a button a
    // person pressed, and the budget exists to stop *unattended* tabs, not watching ones.
    setAutoAdvance(true);
    setTicks(0);
    setTickFailure(null);
    await refresh();
  }

  /* ---- first load and hard failure ------------------------------------- */

  if (!data) {
    if (failure) {
      return (
        <div className="mt-6">
          <ApiErrorNotice
            failure={failure}
            context="loading this run"
            onRetry={() => void refresh()}
          />
        </div>
      );
    }
    return (
      <div className="mt-6 space-y-4">
        <InlineLoading label="Loading run…" />
        <SkeletonRows rows={4} label="Loading run steps" />
      </div>
    );
  }

  /* ---- derived ---------------------------------------------------------- */

  const definitionSteps = toStepList(data.version.definition);
  const stepNames = new Map(definitionSteps.map((s) => [s.id, s.name || s.id]));

  /** Step execution id to a readable label, for AI calls and audit events. */
  const executionLabels = new Map(
    data.steps.map((s) => [s.id, stepNames.get(s.stepId) ?? s.stepId]),
  );

  const awaitingApproval = data.steps.find((s) => s.status === "AWAITING_APPROVAL");

  // The last failed step, not the first: earlier attempts stay on the record, and
  // retrying the older row would resubmit work that has since been superseded.
  let failedStep: StepExecutionRow | undefined;
  for (const step of data.steps) if (step.status === "FAILED") failedStep = step;

  const rejectedGate = data.steps.find((s) => s.approval?.decision === "REJECTED");
  const isTerminal = TERMINAL_STATUSES.includes(data.run.status);

  // Mirrors the engine's guards: RESUMABLE is [PENDING, RUNNING, FAILED]. Offering Resume
  // on a CANCELLED run would invite stepping over a rejection, refusal notwithstanding.
  const canResume = data.run.status === "FAILED" || data.run.status === "PENDING";
  const canCancel = !isTerminal;

  const counts: Record<Tab, number> = {
    steps: data.steps.length,
    ai: data.llmCalls.length,
    audit: data.audit.length,
  };

  return (
    <div className="mt-4">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              {data.workflow.name}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              <Link
                href={`/workflows/${data.workflow.id}`}
                className="font-medium text-blue-700 hover:underline"
              >
                Version {data.version.version}
              </Link>
              <span className="mx-2 text-slate-300">·</span>
              started {formatTimestamp(data.run.createdAt)}
            </p>
            <p className="mt-0.5 font-mono text-xs text-slate-400">{data.run.id}</p>
          </div>
          <div className="flex items-center gap-3">
            {refreshing ? <Spinner /> : null}
            <StatusBadge status={data.run.status} />
          </div>
        </div>
      </header>

      {/* A failed refresh, shown beside the run rather than instead of it. */}
      {failure ? (
        <div className="mt-4">
          <ApiErrorNotice
            failure={failure}
            context="refreshing this run"
            onRetry={() => void refresh()}
          />
          <p className="mt-1 text-xs text-slate-500">
            The run below is the last state that loaded successfully, so it may be
            out of date.
          </p>
        </div>
      ) : null}

      {data.run.error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900"
        >
          <span className="font-semibold">The run stopped with an error: </span>
          {data.run.error}
        </p>
      ) : null}

      {rejectedGate ? (
        <div className="mt-4 rounded-lg border border-rose-300 bg-rose-50 p-4">
          <p className="text-sm font-semibold text-rose-900">
            Stopped by a rejected approval
          </p>
          <p className="mt-1 max-w-prose text-sm text-rose-900">
            A person rejected the gate at{" "}
            <span className="font-mono">{rejectedGate.stepId}</span>, so the run was
            cancelled and cannot be restarted. Resume and retry both refuse it — the
            rejection is permanent, and no route can undo it. Start a new run to try
            again.
          </p>
          {rejectedGate.approval?.reason ? (
            <p className="mt-2 border-l-2 border-rose-300 pl-3 text-sm text-rose-900 italic">
              “{rejectedGate.approval.reason}”
            </p>
          ) : null}
        </div>
      ) : null}

      {isRunning ? (
        <div
          role="status"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4"
        >
          <div className="flex items-center gap-2 text-sm text-blue-900">
            {autoAdvance && !tickBudgetSpent ? <Spinner /> : null}
            <span>
              {tickBudgetSpent
                ? `Automatic advance stopped after ${MAX_AUTOMATIC_TICKS} ticks. Use the button to continue.`
                : autoAdvance
                  ? "Running — advancing one step at a time."
                  : "Paused. The run is unchanged; nothing is being driven."}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-blue-900">
              <input
                type="checkbox"
                checked={autoAdvance && !tickBudgetSpent}
                disabled={tickBudgetSpent}
                onChange={(e) => {
                  setAutoAdvance(e.target.checked);
                  setTickFailure(null);
                }}
                className="size-4"
              />
              Advance automatically
            </label>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void control("Advanced one step", "/tick")}
              className="rounded-md border border-blue-300 bg-white px-3 py-1.5 text-sm font-medium text-blue-900 hover:bg-blue-100 disabled:opacity-50"
            >
              Advance now
            </button>
          </div>
        </div>
      ) : null}

      {tickFailure ? (
        <div className="mt-4">
          <ApiErrorNotice
            failure={tickFailure}
            context="advancing the run"
            onRetry={() => {
              setTickFailure(null);
              setAutoAdvance(true);
            }}
          />
          <p className="mt-1 text-xs text-slate-500">
            Automatic advance was switched off after this failure so the server is
            not polled once a second while it is unhealthy.
          </p>
        </div>
      ) : null}

      {awaitingApproval && data.run.status === "AWAITING_APPROVAL" ? (
        <ApprovalPanel
          step={awaitingApproval}
          busy={busy !== null}
          onDecide={(stepExecutionId, decision, reason) =>
            void control(
              decision === "APPROVED" ? "Approved" : "Rejected",
              "/approve",
              { stepExecutionId, decision, reason },
            )
          }
        />
      ) : null}

      {confirmation ? (
        // Toned by the state the run landed in, not by the request succeeding. A green
        // banner reading "the run is now FAILED" says the opposite of what it means.
        <p
          role="status"
          className={`mt-4 rounded-lg border p-3 text-sm ${
            data.run.status === "FAILED"
              ? "border-rose-300 bg-rose-50 text-rose-900"
              : data.run.status === "CANCELLED"
                ? "border-slate-300 bg-slate-100 text-slate-800"
                : data.run.status === "AWAITING_APPROVAL"
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : "border-emerald-300 bg-emerald-50 text-emerald-900"
          }`}
        >
          {confirmation}
        </p>
      ) : null}

      {controlFailure ? (
        <div className="mt-4">
          <ApiErrorNotice failure={controlFailure} context="applying that action" />
        </div>
      ) : null}

      {data.run.status === "COMPLETED" ? (
        <p
          role="status"
          className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          <span className="font-semibold">Run completed.</span> Every step below
          executed in order, and the audit trail records each decision the engine
          and the reviewer made.
        </p>
      ) : null}

      <section className="mt-6 flex flex-wrap items-center gap-2">
        <Tabs tab={tab} setTab={setTab} counts={counts} />

        <div className="ml-auto flex flex-wrap gap-2">
          {failedStep && !rejectedGate ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void control("Retried the failed step", "/retry", {
                  stepExecutionId: failedStep.id,
                })
              }
              className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy === "Retried the failed step" ? (
                <Spinner className="border-blue-200 border-t-white" />
              ) : null}
              Retry {stepNames.get(failedStep.stepId) ?? failedStep.stepId}
            </button>
          ) : null}

          {canResume ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void control("Resumed the run", "/resume")}
              className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
            >
              Resume run
            </button>
          ) : null}

          {canCancel ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void control("Cancelled the run", "/cancel")}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel run
            </button>
          ) : null}
        </div>
      </section>

      {failedStep && !failedStep.retrySafe && !rejectedGate ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <span className="font-semibold">
            This failed step is not retry-safe, so the engine never retried it
            itself.
          </span>{" "}
          Retrying it is a human decision. If the action did in fact reach the
          external system, the idempotency ledger recognises the key and refuses the
          duplicate instead of writing twice — the audit trail will show{" "}
          <span className="font-mono text-xs">DUPLICATE_WRITE_PREVENTED</span>.
        </p>
      ) : null}

      <div className="mt-4">
        {tab === "steps" ? (
          data.steps.length === 0 ? (
            <EmptyState title="No steps have executed yet">
              The run exists but has not advanced. If it is running, the first step
              appears within a second or two.
            </EmptyState>
          ) : (
            <ol className="space-y-3">
              {data.steps.map((step, i) => (
                <StepRow
                  key={step.id}
                  step={step}
                  stepName={stepNames.get(step.stepId)}
                  index={i}
                />
              ))}
            </ol>
          )
        ) : null}

        {tab === "ai" ? (
          data.llmCalls.length === 0 ? (
            <EmptyState title="No AI calls recorded for this run">
              Every model call is logged here with its provider, model, latency,
              token counts, prompt and raw response. An empty list means the run has
              not reached an AI step yet, or the workflow has none.
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {data.llmCalls.map((call) => (
                <LlmCallRowView
                  key={call.id}
                  call={call}
                  stepLabel={
                    call.stepExecutionId
                      ? (executionLabels.get(call.stepExecutionId) ?? null)
                      : null
                  }
                />
              ))}
            </ul>
          )
        ) : null}

        {tab === "audit" ? (
          data.audit.length === 0 ? (
            <EmptyState title="No audit events recorded">
              This should not happen: creating a run writes a{" "}
              <span className="font-mono text-xs">RUN_CREATED</span> event. An empty
              trail means the run row exists without its audit history.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {data.audit.map((event) => (
                <AuditRowView
                  key={event.id}
                  event={event}
                  stepLabel={
                    event.stepExecutionId
                      ? (executionLabels.get(event.stepExecutionId) ?? null)
                      : null
                  }
                />
              ))}
            </ul>
          )
        ) : null}
      </div>

      <section className="mt-10 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">Run input</h2>
        <p className="mt-1 text-sm text-slate-600">
          The input this run was started with. Steps read it by field name as{" "}
          <span className="font-mono text-xs">$.input.&lt;field&gt;</span>.
        </p>
        <JsonBlock value={data.run.input} />
      </section>
    </div>
  );
}

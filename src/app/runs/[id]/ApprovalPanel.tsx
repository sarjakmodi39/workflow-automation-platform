"use client";

import { useState } from "react";
import { JsonBlock } from "@/components/JsonBlock";
import { Spinner } from "@/components/Loading";
import type { StepExecutionRow } from "@/lib/client-api";

/* The one place a person, not the engine, decides. Evidence before controls, a reason the
 * reviewer writes, and a second press to reject — a rejected run is CANCELLED for good. */

/* -------------------------------------------------------------------------- */
/* The two-stage rejection rule                                               */
/* -------------------------------------------------------------------------- */

/** `deciding`: the initial choice. `confirming`: rejection has been asked for. */
export type RejectStage = "deciding" | "confirming";

/** What a Reject press does, as a function so the two-press rule is testable rather than an
 *  arrangement of JSX. Proves the rule, not the wiring — that would need click simulation. */
export function pressReject(stage: RejectStage): "confirm" | "submit" {
  return stage === "deciding" ? "confirm" : "submit";
}

/** Whatever the awaiting step recorded for a reviewer to read. */
function ProposedAction({ step }: { step: StepExecutionRow }) {
  const prompt =
    step.explanation && typeof step.explanation === "object"
      ? (step.explanation as { prompt?: unknown }).prompt
      : undefined;

  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-white p-3">
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
        What you are being asked to approve
      </p>
      {typeof prompt === "string" && prompt.length > 0 ? (
        <p className="mt-1.5 border-l-2 border-amber-300 pl-3 text-sm text-slate-800">
          {prompt}
        </p>
      ) : (
        <p className="mt-1.5 text-sm text-slate-600">
          This gate declares no prompt of its own. The evidence is the preceding
          steps&apos; output, below and in the Steps tab.
        </p>
      )}
      <JsonBlock value={step.input} label="evidence passed into this gate" />
    </div>
  );
}

export function ApprovalPanel({
  step,
  busy,
  onDecide,
}: {
  step: StepExecutionRow;
  busy: boolean;
  onDecide: (
    stepExecutionId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string | null,
  ) => void;
}) {
  const [reason, setReason] = useState("");
  const [stage, setStage] = useState<RejectStage>("deciding");

  const trimmed = reason.trim();
  const submit = (decision: "APPROVED" | "REJECTED") =>
    onDecide(step.id, decision, trimmed.length > 0 ? trimmed : null);

  // Both Reject buttons call this. Which one the reader pressed is irrelevant;
  // the stage decides, and the stage is the rule.
  const reject = () => {
    if (pressReject(stage) === "submit") submit("REJECTED");
    else setStage("confirming");
  };

  return (
    <section
      aria-labelledby="approval-heading"
      className="mt-6 rounded-lg border-2 border-amber-400 bg-amber-50 p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="approval-heading" className="text-lg font-semibold text-amber-900">
          A decision is required before this run continues
        </h2>
        <span className="rounded-full bg-amber-200 px-2.5 py-0.5 font-mono text-xs text-amber-900">
          {step.stepId}
        </span>
      </div>
      <p className="mt-1 max-w-prose text-sm text-amber-900">
        The run is halted at this gate. Nothing after it has executed, and nothing
        will until you decide.
      </p>

      <ProposedAction step={step} />

      <label
        htmlFor="approval-reason"
        className="mt-4 block text-xs font-medium tracking-wide text-slate-600 uppercase"
      >
        Reason (recorded in the audit trail)
      </label>
      <textarea
        id="approval-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="Why are you approving or rejecting this?"
        className="mt-1 w-full rounded-md border border-amber-300 bg-white p-2.5 text-sm text-slate-900 focus:outline-2 focus:outline-offset-2 focus:outline-amber-600"
      />
      <p className="mt-1 text-xs text-amber-800">
        Optional, and stored verbatim against the decision. A rejection without a
        reason leaves no record of why the run was stopped.
      </p>

      {stage === "confirming" ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-rose-400 bg-rose-50 p-3"
        >
          <p className="text-sm font-semibold text-rose-900">
            Rejecting is permanent
          </p>
          <p className="mt-1 max-w-prose text-sm text-rose-900">
            The run stops as cancelled and stays that way. It cannot be resumed,
            and its steps cannot be retried — the engine refuses both, so this
            cannot be undone from the interface or the API.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={reject}
              aria-busy={busy}
              className="inline-flex items-center gap-2 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Spinner className="border-rose-200 border-t-white" /> : null}
              Yes, reject and stop the run
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setStage("deciding")}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Go back
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => submit("APPROVED")}
            aria-busy={busy}
            className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Spinner className="border-emerald-200 border-t-white" /> : null}
            {busy ? "Recording decision…" : "Approve and continue"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={reject}
            className="rounded-md border border-rose-400 bg-white px-4 py-2 text-sm font-medium text-rose-800 hover:bg-rose-50 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      )}
    </section>
  );
}

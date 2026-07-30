"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { Spinner } from "@/components/Loading";
import { StatusBadge } from "@/components/StatusBadge";
import {
  postJson,
  type ApiFailure,
  type CreateRunResponse,
} from "@/lib/client-api";
import type { FieldKind } from "@/lib/engine/registry";
import type { StepDefinition } from "@/lib/types";

/*
 * Starting a run: the one place this UI writes anything.
 *
 * Client-side because it owns a text buffer, a submission in flight, and three
 * outcomes the reader has to be able to tell apart — input that is not valid
 * JSON (fix it and retry), a rejection from the API (a different fix), and a
 * created run (go and watch it).
 */

/** Example values for the field names the seeded corpus is written around. Every declared
 *  field needs one: an empty prefill leaves a reviewer guessing what to type. */
const EXAMPLE_VALUES: Record<string, unknown> = {
  invoiceId: "INV-2026-0099",
  // Above the 5000 threshold on purpose, so the default input reaches the gate.
  amount: 7400,
  vendor: "Globex Industrial",
  currency: "USD",
  description: "Replacement conveyor motors",
  country: "Germany",
  requestedBy: "procurement@example.com",
};

/** Vendors the seeded corpus can retrieve. Any other name returns no documents, so the
 *  AI step has nothing to read and fails — worth saying before a run, not after. */
const KNOWN_VENDORS = ["Globex Industrial", "Acme Supplies"];

function placeholderFor(kind: unknown): unknown {
  switch (kind as FieldKind) {
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "";
  }
}

/**
 * Builds the starting input from the workflow's own `structured_input` step, so
 * the keys are the keys that step will require rather than a guess kept in the
 * UI. No such step means no declared input shape, and an empty object is the
 * honest default.
 */
function defaultInputFor(steps: StepDefinition[]): string {
  const declaring = steps.find((step) => step.type === "structured_input");
  const fields = declaring?.config?.fields;
  const shape: Record<string, unknown> = {};

  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (!field || typeof field !== "object") continue;
      const { name, kind } = field as { name?: unknown; kind?: unknown };
      if (typeof name !== "string" || name.length === 0) continue;
      shape[name] = name in EXAMPLE_VALUES ? EXAMPLE_VALUES[name] : placeholderFor(kind);
    }
  }

  return JSON.stringify(shape, null, 2);
}

type ParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

function parseInput(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      message: `This is not valid JSON. ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      message:
        "Run input must be a JSON object. Steps read it by field name, as $.input.<field>.",
    };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

export function RunLauncher({
  versionId,
  versionNumber,
  steps,
  blockedReason,
}: {
  versionId: string;
  versionNumber: number;
  steps: StepDefinition[];
  /** Non-null when the version must not be executed, e.g. it has issues. */
  blockedReason: string | null;
}) {
  const router = useRouter();
  const [text, setText] = useState(() => defaultInputFor(steps));
  const [busy, setBusy] = useState(false);
  const [invalidInput, setInvalidInput] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [started, setStarted] = useState<CreateRunResponse["run"] | null>(null);

  // Live, so the reader is not told about a typo only after pressing the button.
  const parsed = useMemo(() => parseInput(text), [text]);

  const declaresVendor = useMemo(
    () =>
      steps.some(
        (s) =>
          s.type === "structured_input" &&
          Array.isArray(s.config?.fields) &&
          (s.config.fields as { name?: unknown }[]).some((f) => f?.name === "vendor"),
      ),
    [steps],
  );

  // Swaps the vendor without making the reader hand-edit JSON, which is where a
  // stray quote turns a demo into a debugging session.
  function useVendor(vendor: string) {
    if (!parsed.ok) return;
    setText(JSON.stringify({ ...parsed.value, vendor }, null, 2));
    setInvalidInput(null);
  }

  async function start() {
    if (!parsed.ok) {
      setInvalidInput(parsed.message);
      setFailure(null);
      return;
    }
    setInvalidInput(null);
    setFailure(null);
    setBusy(true);

    const result = await postJson<CreateRunResponse>("/api/runs", {
      workflowVersionId: versionId,
      input: parsed.value,
    });

    setBusy(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }

    // Confirm first, then navigate: if the run page is slow to arrive, the
    // reader still sees that the run exists and what state it started in.
    setStarted(result.data.run);
    router.push(`/runs/${result.data.run.id}`);
  }

  return (
    <section className="mt-10 rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-slate-900">
        Start a run of v{versionNumber}
      </h2>
      <p className="mt-1 max-w-prose text-sm text-slate-600">
        The input below is prefilled from this workflow&apos;s declared input
        fields. Edit it, then start the run — you will be taken to its page, where
        it advances one step at a time.
      </p>

      <label
        htmlFor="run-input"
        className="mt-4 block text-xs font-medium tracking-wide text-slate-500 uppercase"
      >
        Run input (JSON)
      </label>
      <textarea
        id="run-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setInvalidInput(null);
        }}
        rows={9}
        spellCheck={false}
        aria-invalid={!parsed.ok}
        className={`mt-1 w-full rounded-md border p-3 font-mono text-xs text-slate-900 focus:outline-2 focus:outline-offset-2 focus:outline-blue-600 ${
          parsed.ok ? "border-slate-300" : "border-amber-400 bg-amber-50/40"
        }`}
      />
      <p className="mt-1 text-xs text-slate-500">
        {parsed.ok ? "Valid JSON object." : "Not a valid JSON object yet."}
      </p>

      {declaresVendor ? (
        <p className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-600">
          The document corpus knows two vendors:{" "}
          {KNOWN_VENDORS.map((v, i) => (
            <span key={v}>
              {i > 0 ? " and " : ""}
              <button
                type="button"
                onClick={() => useVendor(v)}
                className="font-mono font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900"
              >
                {v}
              </button>
            </span>
          ))}
          . Globex is rated high risk and Acme low, so they take different
          branches. Any other name retrieves nothing and the AI step will fail.
        </p>
      ) : null}

      {invalidInput ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {invalidInput}
        </p>
      ) : null}

      {failure ? (
        <div className="mt-3">
          <ApiErrorNotice failure={failure} context="starting the run" />
        </div>
      ) : null}

      {started ? (
        <div
          role="status"
          className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-emerald-900">Run started</p>
            <StatusBadge status={started.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-emerald-900">{started.id}</p>
          <Link
            href={`/runs/${started.id}`}
            className="mt-2 inline-block text-sm font-medium text-emerald-900 underline underline-offset-2"
          >
            Open run detail
          </Link>
        </div>
      ) : null}

      {blockedReason ? (
        <p className="mt-3 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
          {blockedReason}
        </p>
      ) : null}

      <button
        type="button"
        onClick={start}
        disabled={busy || blockedReason !== null}
        aria-busy={busy}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Spinner className="border-blue-200 border-t-white" /> : null}
        {busy ? "Starting run…" : "Start run"}
      </button>
    </section>
  );
}

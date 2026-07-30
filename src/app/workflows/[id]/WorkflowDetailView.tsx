"use client";

import { useMemo } from "react";
import { RunLauncher } from "@/app/workflows/[id]/RunLauncher";
import { VersionCompare } from "@/app/workflows/[id]/VersionCompare";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { Command, EmptyState } from "@/components/EmptyState";
import { InlineLoading } from "@/components/Loading";
import { Section } from "@/components/Section";
import { StepCard } from "@/components/StepCard";
import {
  getJson,
  postJson,
  toStepList,
  toStringArray,
  type VersionDetail,
  type ValidateResponse,
  type WorkflowDetailResponse,
} from "@/lib/client-api";
import { REGISTRY } from "@/lib/engine/registry";
import type { ValidationIssue } from "@/lib/engine/validator";
import { formatTimestamp, pluralise } from "@/lib/format";
import type { StepDefinition, StepType } from "@/lib/types";
import { useApiResource } from "@/lib/useApiResource";

/*
 * The workflow detail view.
 *
 * Client-side for the same reason as the dashboard panels: the loading, empty
 * and failure states are only real if the fetch happens where the reader can
 * watch it. The route itself stays a Server Component that does nothing but
 * await `params`.
 */

function DetailSkeleton() {
  return (
    <div role="status" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading workflow</span>
      <div className="h-7 w-64 rounded bg-slate-200" />
      <div className="mt-2 h-3 w-80 rounded bg-slate-100" />
      <div className="mt-8 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="h-4 w-1/3 rounded bg-slate-200" />
            <div className="mt-2 h-3 w-2/3 rounded bg-slate-100" />
            <div className="mt-2 h-3 w-1/4 rounded bg-slate-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function WorkflowDetailView({ id }: { id: string }) {
  const { resource, reload } = useApiResource<WorkflowDetailResponse>(
    () => getJson<WorkflowDetailResponse>(`/api/workflows/${id}`),
    [id],
  );

  if (resource.state === "loading") return <DetailSkeleton />;

  if (resource.state === "failed") {
    return (
      <ApiErrorNotice
        failure={resource.failure}
        context="loading this workflow"
        onRetry={reload}
      />
    );
  }

  const workflow = resource.data.workflow;
  const versions = Array.isArray(workflow?.versions) ? workflow.versions : [];
  // The route orders versions by number descending.
  const latest = versions[0];

  return (
    <>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          {workflow?.name ?? "Untitled workflow"}
        </h1>
        <p className="mt-1 font-mono text-xs text-slate-500">
          {workflow?.id} · created {formatTimestamp(workflow?.createdAt)}
        </p>
      </header>

      {latest ? (
        <VersionView workflowId={id} versions={versions} version={latest} />
      ) : (
        <div className="mt-8">
          <EmptyState title="This workflow has no versions">
            Nothing can run until a version exists. Create one by posting a
            definition to <Command>POST /api/workflows/[id]/versions</Command>, or
            reseed with <Command>npm run db:seed</Command>.
          </EmptyState>
        </div>
      )}
    </>
  );
}

function VersionView({
  workflowId,
  versions,
  version,
}: {
  workflowId: string;
  versions: VersionDetail[];
  version: VersionDetail;
}) {
  const steps = useMemo(() => toStepList(version.definition), [version.definition]);
  const grants = useMemo(
    () => toStringArray(version.grantedPermissions),
    [version.grantedPermissions],
  );

  /*
   * The stored definition is re-validated live, with the same validator that
   * gated its save. It is sent exactly as it came out of the database rather
   * than normalised first, so that what is checked is what is stored.
   */
  const { resource: validation, reload: revalidate } = useApiResource<ValidateResponse>(
    () =>
      postJson<ValidateResponse>(`/api/workflows/${workflowId}/validate`, {
        definition: version.definition,
        grantedPermissions: version.grantedPermissions,
      }),
    [workflowId, version.id],
  );

  const issues: ValidationIssue[] =
    validation.state === "ready" ? validation.data.issues : [];

  const issuesByStep = useMemo(() => {
    const map = new Map<string, ValidationIssue[]>();
    for (const issue of issues) {
      if (!issue.stepId) continue;
      const list = map.get(issue.stepId) ?? [];
      list.push(issue);
      map.set(issue.stepId, list);
    }
    return map;
  }, [issues]);

  const stepLabels = useMemo(() => {
    const map = new Map<string, string>();
    steps.forEach((step, i) => {
      if (!map.has(step.id)) map.set(step.id, `step ${i + 1}, "${step.name || step.id}"`);
    });
    return map;
  }, [steps]);

  const approvalCount = steps.filter((s) => s.type === "human_approval").length;
  const effectCount = steps.filter(
    (s) => REGISTRY[s.type as StepType]?.retrySafe === false,
  ).length;

  const blockedReason =
    steps.length === 0
      ? "This version has no steps, so there is nothing to execute."
      : validation.state === "ready" && !validation.data.valid
        ? `This version has ${pluralise(issues.length, "validation issue")} and must not be executed. Save a corrected version instead.`
        : null;

  return (
    <>
      <Section
        title="Versions"
        description="Versions are immutable. A run is pinned to the version it started on, so editing a workflow never changes the meaning of a past run."
      >
        <ul className="flex flex-wrap gap-2">
          {versions.map((v) => {
            const isShown = v.id === version.id;
            return (
              <li
                key={v.id}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  isShown
                    ? "border-blue-300 bg-blue-50 text-blue-900"
                    : "border-slate-200 bg-white text-slate-700"
                }`}
              >
                <span className="font-medium">v{v.version}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {formatTimestamp(v.createdAt)}
                </span>
                {isShown ? (
                  <span className="ml-2 text-xs font-medium">shown below</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Section>

      <VersionCompare versions={versions} />

      <Section
        title="Pre-execution validation"
        description="Every version is validated before it is saved, and re-checked here before it can run. This is the check that keeps an unrunnable workflow from being discovered halfway through a run."
      >
        {validation.state === "loading" ? (
          <InlineLoading label="Validating this version…" />
        ) : validation.state === "failed" ? (
          <ApiErrorNotice
            failure={validation.failure}
            context="validating this version"
            onRetry={revalidate}
          />
        ) : validation.data.valid ? (
          <p
            role="status"
            className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900"
          >
            <span className="font-semibold">Valid.</span> All{" "}
            {pluralise(steps.length, "step")} have a known type, a usable
            configuration, granted permissions, and forward-only references. This
            version can run.
          </p>
        ) : (
          <div
            role="alert"
            className="rounded-lg border border-rose-300 bg-rose-50 p-4"
          >
            <p className="text-sm font-semibold text-rose-900">
              {pluralise(issues.length, "issue")} — this version cannot be executed
            </p>
            <ul className="mt-2 space-y-1.5">
              {issues.map((issue, i) => (
                <li key={`${issue.code}-${i}`} className="text-sm text-rose-900">
                  <span className="mr-2 rounded bg-rose-100 px-1.5 py-0.5 font-mono text-xs">
                    {issue.code}
                  </span>
                  <span className="font-medium">
                    {issue.stepId
                      ? (stepLabels.get(issue.stepId) ??
                        `step id "${issue.stepId}"`)
                      : "whole workflow"}
                  </span>
                  : {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section
        title="Granted permissions"
        description="A step can only use a capability this version explicitly grants. Permissions are part of the version, so widening them means saving a new one."
      >
        {grants.length === 0 ? (
          <EmptyState title="No permissions granted">
            This version grants nothing, so it can only contain steps that need no
            capability — no AI calls, no document search, no external writes.
          </EmptyState>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {grants.map((grant) => (
              <li
                key={grant}
                className="rounded-full bg-slate-100 px-3 py-1 font-mono text-xs text-slate-800 ring-1 ring-slate-300 ring-inset"
              >
                {grant}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={`Steps in v${version.version}`}
        description={
          <>
            Steps run top to bottom unless a condition branches forward. Amber marks
            the human approval gate, where the run stops until a person decides; the
            outlined red step has a real-world effect and is never retried
            automatically.
          </>
        }
        aside={
          <span className="text-xs text-slate-500">
            {pluralise(steps.length, "step")} ·{" "}
            {pluralise(approvalCount, "approval gate")} ·{" "}
            {pluralise(effectCount, "external write")}
          </span>
        }
      >
        {steps.length === 0 ? (
          <EmptyState title="No steps in this version">
            The stored definition contains no readable steps, so there is nothing to
            execute. The validation check above reports this as{" "}
            <Command>EMPTY_WORKFLOW</Command>.
          </EmptyState>
        ) : (
          <ol className="space-y-3">
            {steps.map((step: StepDefinition, index: number) => (
              <StepCard
                key={`${step.id}-${index}`}
                index={index}
                step={step}
                grantedPermissions={grants}
                stepLabels={stepLabels}
                issues={issuesByStep.get(step.id) ?? []}
              />
            ))}
          </ol>
        )}
      </Section>

      <RunLauncher
        versionId={version.id}
        versionNumber={version.version}
        steps={steps}
        blockedReason={blockedReason}
      />
    </>
  );
}

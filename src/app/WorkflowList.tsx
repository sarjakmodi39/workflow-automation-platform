"use client";

import Link from "next/link";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { Command, EmptyState } from "@/components/EmptyState";
import { SkeletonRows } from "@/components/Loading";
import { Section } from "@/components/Section";
import { getJson, type WorkflowListResponse } from "@/lib/client-api";
import { formatTimestamp, pluralise } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";

/** What each seeded workflow is for, so a reviewer opening this page cold knows which one
 *  to run first instead of picking at random. Keyed by the seed's fixed ids. */
const WORKFLOW_HINTS: Record<string, { badge: string; hint: string }> = {
  seed_vendor_review: {
    badge: "Start here",
    hint: "Runs to completion with no human input — the quickest way to see the engine work.",
  },
  seed_invoice_approval: {
    badge: "Approval gate",
    hint: "Stops for a human. Two versions with different thresholds, so the same input can decide differently.",
  },
  seed_permission_demo: {
    badge: "Fails by design",
    hint: "Under-granted on purpose: it stops at the external write with PERMISSION_DENIED.",
  },
};

/** Client-side because the three states below — in flight, empty, failed — are only
 *  distinguishable if the fetch happens where the reader can see it. */
export function WorkflowList() {
  const { resource, reload } = useApiResource<WorkflowListResponse>(
    () => getJson<WorkflowListResponse>("/api/workflows"),
    [],
  );

  return (
    <Section
      title="Workflows"
      description="Each workflow is an ordered list of steps. Saving a definition creates an immutable version, and a version that fails validation is never saved."
    >
      {resource.state === "loading" ? (
        <SkeletonRows rows={2} label="Loading workflows" />
      ) : resource.state === "failed" ? (
        <ApiErrorNotice
          failure={resource.failure}
          context="loading workflows"
          onRetry={reload}
        />
      ) : resource.data.workflows.length === 0 ? (
        <EmptyState title="No workflows yet">
          Load the demo workflow with <Command>npm run db:seed</Command>, then reload
          this page. It defines an invoice review that retrieves policy documents,
          extracts and classifies the invoice, and stops for human approval before
          any external write.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {resource.data.workflows.map((workflow) => {
            const latest = workflow.versions[0];
            const guide = WORKFLOW_HINTS[workflow.id];
            return (
              <li
                key={workflow.id}
                className="flex items-center justify-between gap-4 p-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/workflows/${workflow.id}`}
                      className="font-medium text-blue-700 underline-offset-2 hover:underline"
                    >
                      {workflow.name}
                    </Link>
                    {guide ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          guide.badge === "Start here"
                            ? "bg-emerald-100 text-emerald-900"
                            : guide.badge === "Fails by design"
                              ? "bg-rose-100 text-rose-900"
                              : "bg-amber-100 text-amber-900"
                        }`}
                      >
                        {guide.badge}
                      </span>
                    ) : null}
                  </div>
                  {guide ? (
                    <p className="mt-1 max-w-prose text-sm text-slate-600">{guide.hint}</p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-slate-500">
                    {pluralise(workflow.versions.length, "version")}
                    {latest ? ` · latest v${latest.version}` : " · no versions"} ·
                    created {formatTimestamp(workflow.createdAt)}
                  </p>
                </div>
                <Link
                  href={`/workflows/${workflow.id}`}
                  aria-label={`Open ${workflow.name}`}
                  className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Open
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

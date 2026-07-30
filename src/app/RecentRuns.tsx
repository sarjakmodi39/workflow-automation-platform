"use client";

import Link from "next/link";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";
import { EmptyState } from "@/components/EmptyState";
import { SkeletonRows } from "@/components/Loading";
import { Section } from "@/components/Section";
import { StatusBadge } from "@/components/StatusBadge";
import { getJson, type RunListResponse } from "@/lib/client-api";
import { formatTimestamp } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";

/** `GET /api/runs` returns up to 50; this is a dashboard, so it shows ten. */
const SHOWN = 10;

export function RecentRuns() {
  const { resource, reload } = useApiResource<RunListResponse>(
    () => getJson<RunListResponse>("/api/runs"),
    [],
  );

  return (
    <Section
      title="Recent runs"
      description="A run is reconstructed from its rows, so it survives a restart mid-execution. Open one to see every step, approval, AI call, and audit event."
    >
      {resource.state === "loading" ? (
        <SkeletonRows rows={3} label="Loading recent runs" />
      ) : resource.state === "failed" ? (
        <ApiErrorNotice
          failure={resource.failure}
          context="loading recent runs"
          onRetry={reload}
        />
      ) : resource.data.runs.length === 0 ? (
        <EmptyState title="No runs yet">
          Open a workflow and start one. The run page then drives it forward one step
          at a time.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {resource.data.runs.slice(0, SHOWN).map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <Link
                  href={`/runs/${run.id}`}
                  className="font-medium text-blue-700 underline-offset-2 hover:underline"
                >
                  {run.workflowVersion.workflow.name} · v
                  {run.workflowVersion.version}
                </Link>
                <p className="mt-0.5 truncate font-mono text-xs text-slate-500">
                  {run.id} · started {formatTimestamp(run.createdAt)}
                </p>
              </div>
              <StatusBadge status={run.status} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

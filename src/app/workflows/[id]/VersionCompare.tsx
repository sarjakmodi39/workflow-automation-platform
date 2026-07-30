"use client";

import { useMemo, useState } from "react";
import { JsonBlock } from "@/components/JsonBlock";
import { Section } from "@/components/Section";
import { toStepList, toStringArray, type VersionDetail } from "@/lib/client-api";
import { diffVersions, type StepDiff } from "@/lib/diff";

/* Comparing two versions. Versions are immutable, so the question a reviewer actually has is
 * "what changed, and does it change what a run would do" — answered per field, not per blob. */

function renderValue(value: unknown) {
  if (value === undefined) return <span className="text-slate-400 italic">not set</span>;
  if (typeof value === "string") return <span className="font-mono">{value}</span>;
  return <span className="font-mono">{JSON.stringify(value)}</span>;
}

function ChangedStep({ diff }: { diff: StepDiff }) {
  const tone =
    diff.kind === "added"
      ? "border-emerald-300 bg-emerald-50"
      : diff.kind === "removed"
        ? "border-rose-300 bg-rose-50"
        : "border-amber-300 bg-amber-50";

  const label =
    diff.kind === "added" ? "Added" : diff.kind === "removed" ? "Removed" : "Changed";

  return (
    <li className={`rounded-lg border p-3 ${tone}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-semibold text-slate-900">{diff.name}</span>
        <span className="font-mono text-xs text-slate-500">{diff.stepId}</span>
        <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-medium text-slate-700">
          {label}
        </span>
        {diff.movedFrom !== undefined ? (
          <span className="text-xs text-slate-600">
            moved from position {diff.movedFrom} to {diff.movedTo}
          </span>
        ) : null}
      </div>

      {diff.fields.length > 0 ? (
        <table className="mt-2 w-full text-left text-xs">
          <thead>
            <tr className="text-slate-500">
              <th className="py-1 pr-3 font-medium">Field</th>
              <th className="py-1 pr-3 font-medium">Before</th>
              <th className="py-1 font-medium">After</th>
            </tr>
          </thead>
          <tbody>
            {diff.fields.map((f) => (
              <tr key={f.field} className="border-t border-white/60 align-top">
                <td className="py-1 pr-3 font-mono text-slate-700">{f.field}</td>
                <td className="py-1 pr-3 text-rose-800">{renderValue(f.before)}</td>
                <td className="py-1 text-emerald-800">{renderValue(f.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </li>
  );
}

export function VersionCompare({ versions }: { versions: VersionDetail[] }) {
  // Newest against the one before it: the comparison a reviewer wants by default.
  const [beforeId, setBeforeId] = useState(versions[1]?.id ?? versions[0]?.id ?? "");
  const [afterId, setAfterId] = useState(versions[0]?.id ?? "");
  const [showUnchanged, setShowUnchanged] = useState(false);

  const before = versions.find((v) => v.id === beforeId);
  const after = versions.find((v) => v.id === afterId);

  const diff = useMemo(() => {
    if (!before || !after) return null;
    return diffVersions(
      toStepList(before.definition),
      toStepList(after.definition),
      toStringArray(before.grantedPermissions),
      toStringArray(after.grantedPermissions),
    );
  }, [before, after]);

  if (versions.length < 2) {
    return (
      <Section
        title="Compare versions"
        description="Versions are immutable, so comparing them shows exactly what a later edit changed."
      >
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          This workflow has only one version, so there is nothing to compare yet. Saving a
          new definition creates a second version and this panel becomes usable.
        </p>
      </Section>
    );
  }

  const notable = diff?.steps.filter((s) => s.kind !== "unchanged" || s.movedFrom) ?? [];
  const unchanged = diff?.steps.filter((s) => s.kind === "unchanged" && !s.movedFrom) ?? [];

  return (
    <Section
      title="Compare versions"
      description="Versions are immutable, so comparing them shows exactly what a later edit changed — and whether it changes what a run would decide."
    >
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-600">
            <span className="block tracking-wide uppercase">Before</span>
            <select
              value={beforeId}
              onChange={(e) => setBeforeId(e.target.value)}
              className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </select>
          </label>
          <span className="pb-2 text-slate-400">→</span>
          <label className="text-xs font-medium text-slate-600">
            <span className="block tracking-wide uppercase">After</span>
            <select
              value={afterId}
              onChange={(e) => setAfterId(e.target.value)}
              className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </select>
          </label>
        </div>

        {diff?.identical ? (
          <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            These two versions are identical in every compared field. Key ordering and
            formatting are ignored, so this is a real equivalence, not a text match.
          </p>
        ) : null}

        {diff && (diff.permissionsAdded.length > 0 || diff.permissionsRemoved.length > 0) ? (
          <div className="mt-4 rounded-md border border-indigo-300 bg-indigo-50 p-3">
            <p className="text-sm font-semibold text-indigo-900">Permission grants changed</p>
            <p className="mt-1 text-xs text-indigo-900">
              A grant decides what steps in this version are allowed to do, so this is the
              part of a diff worth reading first.
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {diff.permissionsAdded.map((p) => (
                <li key={`a-${p}`} className="font-mono text-emerald-800">+ {p}</li>
              ))}
              {diff.permissionsRemoved.map((p) => (
                <li key={`r-${p}`} className="font-mono text-rose-800">− {p}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {notable.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {notable.map((s) => (
              <ChangedStep key={s.stepId} diff={s} />
            ))}
          </ul>
        ) : null}

        {unchanged.length > 0 ? (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowUnchanged((v) => !v)}
              className="text-xs font-medium text-blue-700 underline underline-offset-2"
            >
              {showUnchanged ? "Hide" : "Show"} {unchanged.length} unchanged step
              {unchanged.length === 1 ? "" : "s"}
            </button>
            {showUnchanged ? (
              <ul className="mt-2 space-y-1">
                {unchanged.map((s) => (
                  <li key={s.stepId} className="text-xs text-slate-500">
                    <span className="font-mono">{s.stepId}</span> — unchanged
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {before && after ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs font-medium text-slate-600">
              Raw definitions
            </summary>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              <JsonBlock value={before.definition} label={`v${before.version} definition`} />
              <JsonBlock value={after.definition} label={`v${after.version} definition`} />
            </div>
          </details>
        ) : null}
      </div>
    </Section>
  );
}

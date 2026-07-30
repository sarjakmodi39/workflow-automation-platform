import { JsonBlock } from "@/components/JsonBlock";
import { REGISTRY } from "@/lib/engine/registry";
import type { StepTypeSpec } from "@/lib/engine/registry";
import type { ValidationIssue } from "@/lib/engine/validator";
import type {
  Comparator,
  ComparatorOp,
  Condition,
  StepDefinition,
  StepType,
} from "@/lib/types";

/* One step of a definition, for someone who has not read the code. Labels and retry safety
 * come from `REGISTRY`: a second table would render "safe to retry" after the engine changed. */

/* -------------------------------------------------------------------------- */
/* Conditions                                                                 */
/* -------------------------------------------------------------------------- */

const OP_LABELS: Record<ComparatorOp, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  in: "in",
  contains: "contains",
};

function isComparator(condition: Condition): condition is Comparator {
  return !("allOf" in condition) && !("anyOf" in condition);
}

/** Renders `{left, op, right}` and `allOf`/`anyOf` trees as readable lines. */
function ConditionSummary({ condition }: { condition: Condition }) {
  if (!condition || typeof condition !== "object") {
    return <JsonBlock value={condition} label="condition" />;
  }

  if ("allOf" in condition || "anyOf" in condition) {
    const isAll = "allOf" in condition;
    const children = isAll
      ? (condition as { allOf: Condition[] }).allOf
      : (condition as { anyOf: Condition[] }).anyOf;
    if (!Array.isArray(children)) {
      return <JsonBlock value={condition} label="condition" />;
    }
    return (
      <div className="text-sm text-slate-700">
        <span className="font-medium">{isAll ? "All of" : "Any of"}:</span>
        <ul className="mt-1 space-y-1 border-l border-slate-200 pl-3">
          {children.map((child, i) => (
            <li key={i}>
              <ConditionSummary condition={child} />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!isComparator(condition) || typeof condition.left !== "string") {
    return <JsonBlock value={condition} label="condition" />;
  }

  const op = OP_LABELS[condition.op] ?? condition.op;
  return (
    <p className="font-mono text-xs text-slate-700">
      <span className="text-slate-900">{condition.left}</span>{" "}
      <span className="font-sans font-medium text-slate-500">{op}</span>{" "}
      <span className="text-slate-900">{JSON.stringify(condition.right)}</span>
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
      {children}
    </span>
  );
}

/** `[{name, kind}]` — the shape `structured_input` and `ai_extraction` declare. */
function namedFields(value: unknown): { name: string; kind?: unknown }[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const fields: { name: string; kind?: unknown }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { name, kind } = entry as Record<string, unknown>;
    if (typeof name !== "string") return null;
    fields.push({ name, kind });
  }
  return fields;
}

function ConfigValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span className="break-words text-slate-800">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="font-mono text-slate-800">{String(value)}</span>;
  }

  const fields = namedFields(value);
  if (fields) {
    return (
      <span className="flex flex-wrap gap-1">
        {fields.map((field) => (
          <Chip key={field.name}>
            {field.name}
            {typeof field.kind === "string" ? (
              <span className="text-slate-400">: {field.kind}</span>
            ) : null}
          </Chip>
        ))}
      </span>
    );
  }

  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return (
      <span className="flex flex-wrap gap-1">
        {(value as string[]).map((v, i) => (
          <Chip key={`${v}-${i}`}>{v}</Chip>
        ))}
      </span>
    );
  }

  return <JsonBlock value={value} />;
}

/** Renders whatever the config holds, keyed by its own field names. Generic on purpose: a
 *  per-type summariser would live outside the registry and omit any new field. */
function ConfigSummary({
  config,
  omit = [],
}: {
  config: Record<string, unknown>;
  omit?: string[];
}) {
  const entries = Object.entries(config ?? {}).filter(
    ([key, value]) => !omit.includes(key) && value !== undefined && value !== null,
  );
  if (entries.length === 0) return null;

  return (
    <dl className="mt-3 space-y-1.5 text-sm">
      {entries.map(([key, value]) => (
        <div key={key} className="sm:flex sm:gap-3">
          <dt className="shrink-0 font-mono text-xs text-slate-500 sm:w-32 sm:pt-0.5">
            {key}
          </dt>
          <dd className="min-w-0 flex-1">
            <ConfigValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/* Step card                                                                  */
/* -------------------------------------------------------------------------- */

function Marker({
  tone,
  children,
}: {
  tone: "amber" | "rose" | "slate";
  children: React.ReactNode;
}) {
  const classes = {
    amber: "bg-amber-100 text-amber-900 ring-amber-300",
    rose: "bg-rose-100 text-rose-900 ring-rose-300",
    slate: "bg-slate-100 text-slate-700 ring-slate-300",
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${classes}`}
    >
      {children}
    </span>
  );
}

export function StepCard({
  index,
  step,
  grantedPermissions,
  stepLabels,
  issues = [],
}: {
  /** Zero-based position in the definition. */
  index: number;
  step: StepDefinition;
  grantedPermissions: string[];
  /** Step id to display label, for branch targets. */
  stepLabels: Map<string, string>;
  issues?: ValidationIssue[];
}) {
  // `step.type` comes from a JSON column, so it may not be a registered type
  // even though it is typed as one.
  const spec: StepTypeSpec | undefined = REGISTRY[step.type as StepType];

  const isApproval = step.type === "human_approval";
  // Sourced from the registry rather than from the type name: "has a real-world
  // effect" and "must never be auto-retried" are the same fact.
  const hasRealWorldEffect = spec?.retrySafe === false;

  const required = spec ? spec.requiredPermissions(step.config ?? {}) : [];
  const granted = new Set(grantedPermissions);

  const approvalPrompt =
    isApproval && typeof step.config?.prompt === "string"
      ? step.config.prompt
      : null;

  const surface = isApproval
    ? "border-amber-300 border-l-4 border-l-amber-400 bg-amber-50/70"
    : hasRealWorldEffect
      ? "border-rose-200 border-l-4 border-l-rose-400 bg-white"
      : "border-slate-200 border-l-4 border-l-slate-200 bg-white";

  return (
    <li className={`rounded-lg border p-4 ${surface}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-slate-900">
          <span className="mr-2 inline-block min-w-5 text-slate-400">
            {index + 1}.
          </span>
          {step.name || step.id}
        </h3>
        <Marker tone={isApproval ? "amber" : "slate"}>
          {spec?.label ?? `Unregistered type: ${step.type}`}
        </Marker>
      </div>

      <p className="mt-1 text-sm text-slate-600">
        {spec?.description ??
          "This step type is not in the registry, so the engine cannot execute it."}
      </p>
      <p className="mt-0.5 font-mono text-xs text-slate-400">id: {step.id}</p>

      {isApproval ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-white/80 p-3">
          <p className="text-sm font-semibold text-amber-900">
            The run stops here until a person decides
          </p>
          <p className="mt-1 text-sm text-amber-900">
            Nothing after this step executes until the approval is granted, and a
            rejection ends the run. This is the platform&apos;s control point.
          </p>
          {approvalPrompt ? (
            <p className="mt-2 border-l-2 border-amber-300 pl-3 text-sm text-slate-700 italic">
              {approvalPrompt}
            </p>
          ) : null}
        </div>
      ) : null}

      {hasRealWorldEffect ? (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3">
          <Marker tone="rose">Real-world effect</Marker>
          <p className="mt-2 text-sm text-rose-900">
            The only step type that is not retry-safe. It is never retried
            automatically, because a second attempt could write twice — retrying it
            is a human decision, and the idempotency ledger refuses the duplicate.
          </p>
        </div>
      ) : null}

      {required.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-500">Requires</span>
          {required.map((permission) => {
            const isGranted = granted.has(permission);
            return (
              <span
                key={permission}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono ring-1 ring-inset ${
                  isGranted
                    ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                    : "bg-rose-50 text-rose-800 ring-rose-300"
                }`}
              >
                {permission}
                <span className="font-sans font-medium">
                  {isGranted ? "granted" : "not granted"}
                </span>
              </span>
            );
          })}
        </div>
      ) : null}

      <ConfigSummary
        config={step.config ?? {}}
        omit={approvalPrompt ? ["prompt"] : []}
      />

      {step.condition ? (
        <div className="mt-3 rounded-md bg-slate-50 p-3">
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
            Condition
          </p>
          <div className="mt-1">
            <ConditionSummary condition={step.condition} />
          </div>
          {step.onTrue || step.onFalse ? (
            <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
              <li>
                <span className="font-medium text-emerald-700">true</span> →{" "}
                {branchLabel(step.onTrue, stepLabels)}
              </li>
              <li>
                <span className="font-medium text-slate-700">false</span> →{" "}
                {branchLabel(step.onFalse, stepLabels)}
              </li>
            </ul>
          ) : null}
        </div>
      ) : null}

      {issues.length > 0 ? (
        <ul className="mt-3 space-y-1 rounded-md border border-rose-300 bg-rose-50 p-3">
          {issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`} className="text-sm text-rose-900">
              <span className="mr-2 rounded bg-rose-100 px-1.5 py-0.5 font-mono text-xs">
                {issue.code}
              </span>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function branchLabel(target: string | undefined, stepLabels: Map<string, string>) {
  if (!target) return <span className="text-slate-500">the next step</span>;
  if (target === "end") return <span>end of run</span>;
  const label = stepLabels.get(target);
  return label ? (
    <span>{label}</span>
  ) : (
    <span className="text-rose-700">
      <span className="font-mono">{target}</span> (no such step)
    </span>
  );
}

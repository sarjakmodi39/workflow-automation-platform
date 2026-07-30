import { JsonBlock } from "@/components/JsonBlock";
import type { ApiFailure } from "@/lib/client-api";

/* Every failure renders here from the one API error body. Status decides what a bare message
 * cannot — whether anything is wrong, and what to do — so 409 and 500 read differently. */

interface Guidance {
  heading: string;
  advice: string;
  /** `blocked`: the request cannot apply. `broken`: the server failed. */
  tone: "blocked" | "broken";
}

function guidanceFor({ status }: ApiFailure): Guidance {
  if (status === 0) {
    return {
      heading: "Could not reach the server",
      advice:
        "The request never completed. Check that the dev server is still running, then try again.",
      tone: "broken",
    };
  }
  if (status === 400) {
    return {
      heading: "Request rejected as invalid",
      advice:
        "The server refused this request before doing anything. Correct the input and send it again.",
      tone: "blocked",
    };
  }
  if (status === 403) {
    return {
      heading: "Permission not granted",
      advice:
        "This workflow version does not grant a permission the step needs. Permissions are granted per version, so this is fixed by saving a new version — not by retrying.",
      tone: "blocked",
    };
  }
  if (status === 404) {
    return {
      heading: "Not found",
      advice:
        "Nothing exists at this id. It may have been deleted, or the link may be stale.",
      tone: "blocked",
    };
  }
  if (status === 409) {
    return {
      heading: "Not possible in the current state",
      advice:
        "Nothing is broken: the request was valid, but the run has moved past the state this action applies to. Reload to see where it is now, then decide again.",
      tone: "blocked",
    };
  }
  if (status === 429) {
    return {
      heading: "Rate limited",
      advice: "An AI provider is throttling requests. Wait a moment, then retry.",
      tone: "blocked",
    };
  }
  if (status === 502) {
    return {
      heading: "Upstream provider failed",
      advice:
        "An AI provider returned an error. This is usually transient — retrying is reasonable.",
      tone: "broken",
    };
  }
  return {
    heading: "Something broke on the server",
    advice:
      "The server hit an unexpected error and logged the detail server-side; the message above is everything it discloses to the browser.",
    tone: "broken",
  };
}

const TONES = {
  blocked: {
    panel: "border-amber-300 bg-amber-50",
    heading: "text-amber-900",
    body: "text-amber-800",
    chip: "bg-amber-100 text-amber-900 ring-amber-300",
    button: "border-amber-400 text-amber-900 hover:bg-amber-100",
  },
  broken: {
    panel: "border-rose-300 bg-rose-50",
    heading: "text-rose-900",
    body: "text-rose-800",
    chip: "bg-rose-100 text-rose-900 ring-rose-300",
    button: "border-rose-400 text-rose-900 hover:bg-rose-100",
  },
} as const;

interface DetailIssue {
  label: string | null;
  message: string;
}

/** Both `ValidationError` shapes carry an `issues` array — `{ path, message }` from body
 *  parsing, `{ stepId, code, message }` from the validator. Both read better as a list. */
function detailIssues(details: unknown): DetailIssue[] | null {
  if (!details || typeof details !== "object") return null;
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;

  const mapped: DetailIssue[] = [];
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") return null;
    const { message, path, stepId, code } = issue as Record<string, unknown>;
    if (typeof message !== "string") return null;
    const label =
      typeof path === "string" && path.length > 0
        ? path
        : typeof stepId === "string" && stepId.length > 0
          ? stepId
          : typeof code === "string"
            ? code
            : null;
    mapped.push({ label, message });
  }
  return mapped;
}

export function ApiErrorNotice({
  failure,
  context,
  onRetry,
}: {
  failure: ApiFailure;
  /** What was being attempted, e.g. "loading workflows". */
  context?: string;
  onRetry?: () => void;
}) {
  const guidance = guidanceFor(failure);
  const tone = TONES[guidance.tone];
  const issues = detailIssues(failure.error.details);

  return (
    <div role="alert" className={`rounded-lg border p-4 ${tone.panel}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className={`text-sm font-semibold ${tone.heading}`}>
          {guidance.heading}
          {context ? (
            <span className={`font-normal ${tone.body}`}> while {context}</span>
          ) : null}
        </p>
        <span
          className={`rounded-full px-2 py-0.5 font-mono text-xs ring-1 ring-inset ${tone.chip}`}
        >
          {failure.status === 0 ? "no response" : `HTTP ${failure.status}`} ·{" "}
          {failure.error.code}
        </span>
      </div>

      <p className={`mt-2 text-sm ${tone.body}`}>{failure.error.message}</p>
      <p className={`mt-1 text-sm ${tone.body}`}>{guidance.advice}</p>

      {failure.status >= 500 && failure.error.code === "INTERNAL_ERROR" ? (
        <p className={`mt-1 text-xs ${tone.body}`}>
          Running locally, the usual cause is that{" "}
          <code className="font-mono">DATABASE_URL</code> is unset or the schema has
          not been pushed yet.
        </p>
      ) : null}

      {issues ? (
        <ul className={`mt-3 space-y-1 text-sm ${tone.body}`}>
          {issues.map((issue, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden="true">·</span>
              <span>
                {issue.label ? (
                  <span className="font-mono text-xs">{issue.label}: </span>
                ) : null}
                {issue.message}
              </span>
            </li>
          ))}
        </ul>
      ) : failure.error.details ? (
        <JsonBlock value={failure.error.details} label="details" />
      ) : null}

      <div className="mt-3 flex items-center gap-3">
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className={`rounded-md border bg-white px-3 py-1.5 text-sm font-medium ${tone.button}`}
          >
            Try again
          </button>
        ) : null}
        <span className={`text-xs ${tone.body}`}>
          {failure.error.retryable
            ? "The server marked this error retryable."
            : "The server marked this error not retryable — repeating it will fail the same way."}
        </span>
      </div>
    </div>
  );
}

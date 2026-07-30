import type { ErrorBody } from "@/lib/api";
import type { ValidationIssue } from "@/lib/engine/validator";
import type {
  RunStatus,
  StepDefinition,
  StepStatus,
  WorkflowDefinition,
} from "@/lib/types";

/* Types read off each route handler, not the Prisma model, so what a route omits is a compile
 * error rather than runtime `undefined`. `import type` keeps `next/server` out of the bundle. */

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export type ApiError = ErrorBody["error"];

export interface ApiFailure {
  /** HTTP status, or 0 when the request never reached the server. */
  status: number;
  error: ApiError;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: ApiFailure };

/** Recognises the one error body shape `fail()` produces. */
function asApiError(body: unknown): ApiError | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const { code, message, retryable, details } = error as Record<string, unknown>;
  if (typeof code !== "string" || typeof message !== "string") return null;
  return {
    code,
    message,
    retryable: retryable === true,
    details: details ?? null,
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // A thrown fetch is a transport fault, not a server answer: no status and no body,
    // so one is synthesised rather than rendering "TypeError: Failed to fetch".
    return {
      ok: false,
      failure: {
        status: 0,
        error: {
          code: "NETWORK_ERROR",
          message: "The request could not reach the server.",
          retryable: true,
          details: null,
        },
      },
    };
  }

  // Text first: a framework-level 500 returns an HTML page, and `response.json()` would
  // throw on it — turning a failure this UI exists to display into a crash.
  const text = await response.text();
  let body: unknown;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  if (!response.ok) {
    const error = asApiError(body);
    return {
      ok: false,
      failure: {
        status: response.status,
        // Deliberately not the response text: an unparsed body is an HTML
        // error page or a stack trace, and neither belongs on screen.
        error:
          error ??
          {
            code: "UNEXPECTED_RESPONSE",
            message: `The server returned HTTP ${response.status} without an error body.`,
            retryable: response.status >= 500,
            details: null,
          },
      },
    };
  }

  if (body === undefined) {
    return {
      ok: false,
      failure: {
        status: response.status,
        error: {
          code: "UNEXPECTED_RESPONSE",
          message: "The server returned a success status with an unreadable body.",
          retryable: true,
          details: null,
        },
      },
    };
  }

  return { ok: true, data: body as T };
}

export function getJson<T>(url: string): Promise<ApiResult<T>> {
  return request<T>(url, { cache: "no-store" });
}

export function postJson<T>(url: string, payload: unknown): Promise<ApiResult<T>> {
  return request<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

/** `GET /api/workflows` — versions are selected down to these three fields. */
export interface VersionSummary {
  id: string;
  version: number;
  createdAt: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  createdAt: string;
  versions: VersionSummary[];
}

export interface WorkflowListResponse {
  workflows: WorkflowSummary[];
}

/** `GET /api/workflows/[id]`. `definition` and `grantedPermissions` are `Json` columns, so
 *  they arrive `unknown` — nothing checked them. Normalise before rendering. */
export interface VersionDetail {
  id: string;
  workflowId: string;
  version: number;
  definition: unknown;
  grantedPermissions: unknown;
  createdAt: string;
}

export interface WorkflowDetailResponse {
  workflow: {
    id: string;
    name: string;
    createdAt: string;
    versions: VersionDetail[];
  };
}

/** `GET /api/runs` — `workflow` is selected as `{ name }` only. */
export interface RunSummary {
  id: string;
  status: RunStatus;
  createdAt: string;
  workflowVersion: {
    version: number;
    workflow: { name: string };
  };
}

export interface RunListResponse {
  runs: RunSummary[];
}

/** `POST /api/workflows/[id]/validate` — 200 with `valid: false` on issues. */
export interface ValidateResponse {
  valid: boolean;
  issues: ValidationIssue[];
}

/** `POST /api/runs` — 201 with the run after its first tick. */
export interface CreateRunResponse {
  run: { id: string; status: RunStatus };
}

/* -------------------------------------------------------------------------- */
/* Run detail                                                                 */
/* -------------------------------------------------------------------------- */

/** `publicRun()` strips `lockToken` and `lockedUntil`, so they are absent here by design:
 *  the lock is internal, and a browser that could read the token could steal it. */
export interface RunDetail {
  id: string;
  workflowVersionId: string;
  status: RunStatus;
  input: unknown;
  cursor: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The decision recorded against an approval gate, once a person has made one. */
export interface ApprovalRow {
  id: string;
  decision: "APPROVED" | "REJECTED";
  reason: string | null;
  decidedAt: string;
}

export interface StepExecutionRow {
  id: string;
  runId: string;
  stepId: string;
  stepType: string;
  status: StepStatus;
  attempt: number;
  retrySafe: boolean;
  input: unknown;
  output: unknown;
  explanation: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** `include: { approval: true }` on the route; null until a decision exists. */
  approval: ApprovalRow | null;
}

/** `type` is a database enum but typed `string` on purpose: the UI looks it up with a
 *  fallback, so an event added to the schema still renders instead of vanishing. */
export interface AuditRow {
  id: string;
  stepExecutionId: string | null;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface LlmCallRow {
  id: string;
  stepExecutionId: string | null;
  provider: string;
  model: string;
  prompt: string;
  response: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status: "SUCCESS" | "ERROR";
  error: string | null;
  createdAt: string;
}

/** `GET /api/runs/[id]` — the whole run in one response. */
export interface RunDetailResponse {
  run: RunDetail;
  workflow: { id: string; name: string; createdAt: string };
  version: VersionDetail;
  steps: StepExecutionRow[];
  audit: AuditRow[];
  llmCalls: LlmCallRow[];
}

/** What every control route returns: the run after the transition. All five share this
 *  shape, which is why one `post` helper drives them. */
export interface RunControlResponse {
  run: RunDetail;
}

/* -------------------------------------------------------------------------- */
/* Normalising untrusted JSON columns                                         */
/* -------------------------------------------------------------------------- */

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Extracts a renderable step list from a `definition` column. A malformed value would throw
 *  during render and trip the error boundary; an empty list is a state the page handles. */
export function toStepList(definition: unknown): StepDefinition[] {
  const steps = (definition as WorkflowDefinition | null | undefined)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter(
    (step): step is StepDefinition =>
      !!step &&
      typeof step === "object" &&
      typeof (step as StepDefinition).id === "string" &&
      typeof (step as StepDefinition).type === "string",
  );
}

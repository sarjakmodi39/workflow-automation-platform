import type { ErrorBody } from "@/lib/api";
import type { ValidationIssue } from "@/lib/engine/validator";
import type { RunStatus, StepDefinition, WorkflowDefinition } from "@/lib/types";

/*
 * The browser's half of the API contract.
 *
 * Every response type here was read off the route handler that produces it, not
 * off the Prisma model: `GET /api/workflows` selects only `{ id, version,
 * createdAt }` for each version, so the list page cannot show step counts, and
 * `GET /api/runs` selects only `workflow.name`, so a run row cannot link to its
 * workflow. Typing what the route actually returns is what makes those limits
 * visible at compile time instead of at runtime as `undefined`.
 *
 * `import type` is erased, so importing `ErrorBody` from `@/lib/api` does not
 * pull `next/server` into the client bundle — and it keeps one definition of
 * the error shape rather than a copy that can drift from the routes.
 */

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
    // A thrown fetch is a transport fault, not a server answer: there is no
    // status and no error body, so one is synthesised rather than letting the
    // caller render "TypeError: Failed to fetch".
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

  // Read as text first. A framework-level 500 (a module that threw before the
  // handler ran) returns an HTML error page, and `response.json()` would throw
  // on it — turning a failure this UI is meant to display into a crash.
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

/**
 * `GET /api/workflows/[id]` — full version rows. `definition` and
 * `grantedPermissions` are `Json` columns, so they arrive as `unknown`: nothing
 * between the database and here has checked their shape, and typing them as
 * `WorkflowDefinition` would be a claim this code cannot make. Normalise with
 * `toStepList` / `toStringArray` before rendering.
 */
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
/* Normalising untrusted JSON columns                                         */
/* -------------------------------------------------------------------------- */

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Extracts a renderable step list from a `definition` column.
 *
 * A row written by something other than the create routes could hold anything,
 * and `definition.steps.map(...)` on a malformed value throws during render —
 * which replaces the whole page with an error boundary instead of the failure
 * state this UI is built to show. An empty list is a state the page handles.
 */
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

import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError, isAppError } from "@/lib/errors";
import type { WorkflowDefinition } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Error to status                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `AppError.code` to HTTP status. Centralised here so eleven route handlers
 * cannot drift, and keyed on the exact code strings authored in
 * `src/lib/errors.ts` — a key that does not match a real code would silently
 * downgrade that error to the 500 fallback.
 *
 * The fallback is 500 rather than 400 on purpose: a code this table does not
 * know about is a code nobody has decided a status for, and guessing a 4xx
 * would tell the client its request was at fault on no evidence.
 */
const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PERMISSION_DENIED: 403,
  RATE_LIMIT: 429,
  PROVIDER_ERROR: 502,
  STEP_EXECUTION_ERROR: 500,
};

/** The status `fail` will use for `error`. Pure; exported for testing. */
export function statusForError(error: unknown): number {
  if (!isAppError(error)) return 500;
  return STATUS_BY_CODE[error.code] ?? 500;
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/** The single error body shape every route returns. Rendered by the UI. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: unknown;
  };
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

/**
 * The only error path in the API.
 *
 * An `AppError` is something this codebase authored deliberately: its code,
 * message and details are meant to be read by a client, so they are returned
 * as-is. Anything else is an unexpected throw whose message may carry a
 * connection string, an API key, a file path or a SQL fragment, so it is logged
 * server-side and replaced with a generic 500. That asymmetry is the whole
 * reason the taxonomy exists.
 */
export function fail(error: unknown): NextResponse<ErrorBody> {
  if (isAppError(error)) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details ?? null,
        },
      },
      { status: statusForError(error) },
    );
  }

  console.error("[api] Unhandled error:", error);

  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        retryable: false,
        details: null,
      },
    },
    { status: 500 },
  );
}

/* -------------------------------------------------------------------------- */
/* Request bodies                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Parses and validates a JSON request body, or throws `ValidationError`.
 *
 * Both failure modes are the client's fault and must be 400s: unparseable JSON
 * throws a `SyntaxError` out of `request.json()`, which would otherwise reach
 * `fail` as an unrecognised error and become a 500.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Request body is not valid.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * Structural schema for a workflow definition: an array of steps, each with a
 * non-empty id, type and name and an object config.
 *
 * Deliberately structural and not semantic. Whether the step types exist,
 * whether their configs are usable, whether references point backwards and
 * whether the granted permissions cover them is `validateWorkflow`'s job, and
 * duplicating any of it here would create a second definition of "valid" that
 * could disagree with the one the engine enforces. `condition` stays `unknown`
 * because `Condition` is recursive and the validator walks it defensively.
 */
const stepSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  condition: z.unknown().optional(),
  onTrue: z.string().optional(),
  onFalse: z.string().optional(),
});

export const workflowDefinitionSchema = z.object({
  steps: z.array(stepSchema),
});

/** Body shape shared by the two version-creating routes and the validate route. */
export const definitionBodySchema = z.object({
  definition: workflowDefinitionSchema.optional(),
  grantedPermissions: z.array(z.string()).optional(),
});

/**
 * The one cast from validated request shape to the domain type, and the one
 * place an absent `config` becomes `{}`.
 *
 * An empty `steps` array is passed through rather than rejected here: the
 * validator reports it as `EMPTY_WORKFLOW`, and a caller sending an empty
 * definition is better served by that named issue than by a schema complaint.
 */
export function toWorkflowDefinition(
  parsed: z.infer<typeof workflowDefinitionSchema> | undefined,
): WorkflowDefinition {
  const steps = (parsed?.steps ?? []).map((step) => ({
    ...step,
    config: step.config ?? {},
  }));
  return { steps } as WorkflowDefinition;
}

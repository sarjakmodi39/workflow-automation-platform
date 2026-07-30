import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError, isAppError } from "@/lib/errors";
import type { WorkflowDefinition } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Error to status                                                            */
/* -------------------------------------------------------------------------- */

/** Code to HTTP status, centralised so eleven routes cannot drift; a key not matching a real
 *  code silently falls back to 500 — 500 not 400, since guessing 4xx blames the client. */
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

/** The only error path in the API. An `AppError` was authored deliberately and is returned
 *  as-is; anything else may carry a key or connection string, so it is logged and genericised. */
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

/** Parses and validates a JSON body, or throws `ValidationError`. Both failure modes are the
 *  client's fault: an unparseable body throws SyntaxError, which would otherwise be a 500. */
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

/** Structural, never semantic: whether types exist and permissions cover them is
 *  `validateWorkflow`'s job, and a second definition of "valid" could disagree with it. */
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

/** The one cast to the domain type, and where an absent `config` becomes `{}`. Empty `steps`
 *  passes through so the validator can name it EMPTY_WORKFLOW instead of a schema complaint. */
export function toWorkflowDefinition(
  parsed: z.infer<typeof workflowDefinitionSchema> | undefined,
): WorkflowDefinition {
  const steps = (parsed?.steps ?? []).map((step) => ({
    ...step,
    config: step.config ?? {},
  }));
  return { steps } as WorkflowDefinition;
}

/** Strips lock bookkeeping before a run goes over the wire. No endpoint accepts a token
 *  today, but publishing live ones would make any future worker endpoint forgeable. */
export function publicRun<T extends { lockToken?: unknown; lockedUntil?: unknown }>(
  run: T,
): Omit<T, "lockToken" | "lockedUntil"> {
  const { lockToken: _lockToken, lockedUntil: _lockedUntil, ...rest } = run;
  return rest;
}

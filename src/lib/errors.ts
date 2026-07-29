export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, false, details);
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super("NOT_FOUND", `${what} not found`, false);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message, false);
  }
}

export class PermissionDeniedError extends AppError {
  constructor(permission: string) {
    super(
      "PERMISSION_DENIED",
      `Permission not granted: ${permission}`,
      false,
      { permission },
    );
  }
}

export class RateLimitError extends AppError {
  constructor(provider: string) {
    super("RATE_LIMIT", `Provider rate limited: ${provider}`, true, {
      provider,
    });
  }
}

export class ProviderError extends AppError {
  constructor(provider: string, message: string) {
    super("PROVIDER_ERROR", `${provider}: ${message}`, true, { provider });
  }
}

export class StepExecutionError extends AppError {
  constructor(message: string, retryable: boolean, details?: unknown) {
    super("STEP_EXECUTION_ERROR", message, retryable, details);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

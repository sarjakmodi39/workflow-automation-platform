import { describe, expect, it } from "vitest";
import {
  AppError,
  PermissionDeniedError,
  RateLimitError,
  ValidationError,
} from "@/lib/errors";

describe("error taxonomy", () => {
  it("marks validation errors as not retryable", () => {
    const err = new ValidationError("bad definition", { field: "steps" });
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({ field: "steps" });
  });

  it("marks permission denials as not retryable", () => {
    const err = new PermissionDeniedError("tool:llm");
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("tool:llm");
  });

  it("marks rate limits as retryable", () => {
    const err = new RateLimitError("gemini");
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.retryable).toBe(true);
  });

  it("preserves the stack and name for debugging", () => {
    const err = new ValidationError("x");
    expect(err.name).toBe("ValidationError");
    expect(err.stack).toBeDefined();
  });
});

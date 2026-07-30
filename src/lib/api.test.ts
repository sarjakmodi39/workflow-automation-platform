import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fail, parseJsonBody, statusForError } from "@/lib/api";
import {
  AppError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ProviderError,
  RateLimitError,
  StepExecutionError,
  ValidationError,
} from "@/lib/errors";

/**
 * The error-to-status mapping is the one piece of the API layer with branching
 * logic, and every route depends on it. A wrong status is invisible until
 * someone clicks something, so it is pinned here per error class rather than by
 * restating the table's string keys — a renamed `code` in errors.ts breaks these
 * tests instead of quietly falling through to 500.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("statusForError", () => {
  const cases: Array<[string, AppError, number]> = [
    ["ValidationError", new ValidationError("bad"), 400],
    ["NotFoundError", new NotFoundError("Run r1"), 404],
    ["ConflictError", new ConflictError("busy"), 409],
    ["PermissionDeniedError", new PermissionDeniedError("tool:x"), 403],
    ["RateLimitError", new RateLimitError("gemini"), 429],
    ["ProviderError", new ProviderError("gemini", "503"), 502],
    ["StepExecutionError", new StepExecutionError("boom", false), 500],
  ];

  for (const [name, error, status] of cases) {
    it(`maps ${name} to ${status}`, () => {
      expect(statusForError(error)).toBe(status);
    });
  }

  it("falls back to 500 for an AppError code with no entry in the table", () => {
    expect(statusForError(new AppError("SOMETHING_NEW", "?", false))).toBe(500);
  });

  it("returns 500 for a plain Error", () => {
    expect(statusForError(new Error("boom"))).toBe(500);
  });

  it("returns 500 for a thrown non-Error", () => {
    expect(statusForError("boom")).toBe(500);
    expect(statusForError(null)).toBe(500);
  });

  it("does not treat a look-alike object as an AppError", () => {
    // Only `instanceof AppError` counts. A bag of fields off the wire that
    // happens to carry `code: "NOT_FOUND"` must not be able to choose its own
    // status code.
    expect(statusForError({ code: "NOT_FOUND", message: "nope" })).toBe(500);
  });
});

describe("fail", () => {
  it("returns the AppError's code, message, retryable flag and details", async () => {
    const response = fail(new ValidationError("Bad step.", { issues: ["x"] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Bad step.",
        retryable: false,
        details: { issues: ["x"] },
      },
    });
  });

  it("reports a rate limit as retryable so the UI can offer a retry", async () => {
    const response = fail(new RateLimitError("gemini"));

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.retryable).toBe(true);
  });

  it("normalises absent details to null rather than omitting the key", async () => {
    const body = await fail(new ConflictError("Run r1 is CANCELLED.")).json();
    expect(body.error.details).toBeNull();
  });

  it("never leaks a non-AppError message to the client", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "postgresql://user:hunter2@db.example.com:5432/prod";

    const response = fail(new Error(`connect ECONNREFUSED ${secret}`));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        retryable: false,
        details: null,
      },
    });

    // Suppressed for the client, but not lost: it must still be diagnosable.
    expect(logged).toHaveBeenCalledOnce();
  });

  it("does not log an AppError as an unhandled fault", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    fail(new NotFoundError("Run r1"));
    expect(logged).not.toHaveBeenCalled();
  });
});

/**
 * `parseJsonBody` is what makes a malformed body a 400 rather than a 500: a bare
 * `schema.parse(await request.json())` lets a SyntaxError escape as an
 * unclassified throw, which the generic handler reports as a server fault. The
 * routes all depend on that distinction and none of them re-implement it.
 */
describe("parseJsonBody", () => {
  const schema = z.object({ name: z.string().min(1) });

  function body(text: string): Request {
    return new Request("http://test/api", { method: "POST", body: text });
  }

  it("returns the parsed value for a valid body", async () => {
    const parsed = await parseJsonBody(body('{"name":"invoice review"}'), schema);
    expect(parsed).toEqual({ name: "invoice review" });
  });

  it("raises a ValidationError, not a SyntaxError, for unparseable JSON", async () => {
    await expect(parseJsonBody(body("{not json"), schema)).rejects.toBeInstanceOf(
      ValidationError,
    );
    // The distinction that matters: a client fault must not reach the generic
    // 500 path, so the status has to resolve to 400.
    const error = await parseJsonBody(body("{not json"), schema).catch((e) => e);
    expect(statusForError(error)).toBe(400);
  });

  it("reports each schema issue with the path it belongs to", async () => {
    const error = await parseJsonBody(body('{"name":""}'), schema).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    const details = (error as ValidationError).details as {
      issues: { path: string; message: string }[];
    };
    expect(details.issues).toHaveLength(1);
    expect(details.issues[0].path).toBe("name");
    expect(statusForError(error)).toBe(400);
  });

  it("strips keys the schema does not declare", async () => {
    const parsed = await parseJsonBody(
      body('{"name":"ok","injected":"ignored"}'),
      schema,
    );
    expect(parsed).toEqual({ name: "ok" });
    expect("injected" in (parsed as object)).toBe(false);
  });
});

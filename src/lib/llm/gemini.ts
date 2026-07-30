import {
  isAppError,
  ProviderError,
  RateLimitError,
  toErrorMessage,
  type AppError,
} from "@/lib/errors";
import type { FieldKind, JsonShape } from "@/lib/engine/registry";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/lib/llm/types";

/**
 * Gemini provider, plus the small pieces of transport shared with OpenRouter.
 * Those helpers live here because the plan pins `parseJsonStrict` to this module
 * and has OpenRouter import it; the timeout, status mapping and token coercion
 * follow it rather than being duplicated or given a fourth file.
 *
 * Nothing in this module writes to `console`. Every failure leaves as an
 * `AppError` whose message is recorded in an `LlmCall` row and in a
 * `STEP_FAILED` audit payload, so a message here is a message in the database
 * and on a page — see `redactor` for what that rules out.
 */

const KIND_TO_GEMINI: Record<FieldKind, string> = {
  string: "STRING",
  number: "NUMBER",
  boolean: "BOOLEAN",
  object: "OBJECT",
  array: "ARRAY",
  // `any` has no Gemini counterpart. STRING is the lossy-but-safe choice: the
  // model always has a representation available for it.
  any: "STRING",
};

export interface GeminiSchema {
  type: string;
  properties: Record<string, { type: string }>;
  required: string[];
}

/**
 * Derives a Gemini `responseSchema` from a `JsonShape`. Every declared field is
 * required — the shape has no notion of an optional field, and a model that may
 * omit fields defeats the point of server-side enforcement.
 *
 * Limitation: `array` maps to a bare `{ type: "ARRAY" }` with no `items`, and
 * `object` to a bare `{ type: "OBJECT" }` with no `properties`, because
 * `JsonShape` is one level deep and carries no element type. Gemini can reject
 * an ARRAY without `items`; the demo workflow's AI steps declare only string,
 * number and boolean fields, so this is latent rather than live.
 */
export function toGeminiSchema(shape: JsonShape): GeminiSchema {
  const properties: Record<string, { type: string }> = {};
  for (const [name, kind] of Object.entries(shape)) {
    properties[name] = { type: KIND_TO_GEMINI[kind] };
  }
  return { type: "OBJECT", properties, required: Object.keys(shape) };
}

/**
 * Parses model output, tolerating the markdown fence that models wrap JSON in
 * even when told not to. A failure is a `ProviderError` rather than a raw
 * `SyntaxError` so `callLlm` can attribute it to this provider and move to the
 * next one; a `SyntaxError` would escape the chain as an unattributed crash.
 *
 * Retryable: model output is stochastic, so the same prompt can parse on a
 * second attempt.
 */
export function parseJsonStrict(raw: string, provider: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ProviderError(
      provider,
      `Model returned output that is not valid JSON: ${raw.slice(0, 200)}`,
    );
  }
}

/**
 * Coerces a provider's usage number for `LlmCall.inputTokens` / `outputTokens`,
 * which are Prisma `Int?` columns.
 *
 * `Math.trunc` because a float is a Prisma validation error at write time —
 * which would turn a model call that *succeeded* into a failed step. `null`
 * rather than `0` for a missing or non-numeric field because a fabricated zero
 * is indistinguishable from a real zero-token call, and the column is nullable
 * precisely so "not reported" can be recorded honestly.
 */
export function toTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Per-request timeout. The runner's tick budget is 40s and it is checked
 * *between* steps, so a hung provider is not bounded by it — it takes the whole
 * serverless invocation down with it. 15s leaves room for a full two-provider
 * chain (15 + 15 = 30s) to exhaust itself inside the budget with headroom for
 * the failure writes.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 15_000;

/**
 * Maps a non-2xx status to the error taxonomy. `retryable` is what the runner
 * consults to decide on an automatic second attempt, so:
 *
 * - 429 → `RateLimitError`, retryable. The free-tier case; it clears on its own.
 * - 5xx → `ProviderError`, retryable. Provider-side fault.
 * - any other non-ok status (401, 400, 403, 404) → `ProviderError`, **not**
 *   retryable. The request itself is the problem; repeating it verbatim cannot
 *   succeed, and it spends the run's LLM call budget to arrive at the same
 *   answer more slowly.
 */
export function httpError(
  provider: string,
  status: number,
  detail?: string,
): AppError {
  if (status === 429) return new RateLimitError(provider);
  const suffix = detail ? `: ${detail}` : "";
  return new ProviderError(provider, `HTTP ${status}${suffix}`, status >= 500);
}

/** Longest error detail kept from a provider body. */
const MAX_DETAIL = 300;

/**
 * A redacted, truncated slice of an error response body.
 *
 * Without it a 4xx is recorded as bare `HTTP 400`, which is undiagnosable — a
 * bad model name, an unsupported response schema and a malformed request all
 * look identical in the ledger, and 4xx is not retryable so there is no second
 * attempt to learn from. The body is redacted before it is kept because these
 * messages are persisted to `LlmCall.error` and rendered to a reviewer, and it
 * is truncated because a provider may return an HTML error page.
 */
async function errorDetail(
  response: Response,
  redact: (message: string) => string,
): Promise<string | undefined> {
  try {
    const text = (await response.text()).trim();
    if (!text) return undefined;
    const flattened = redact(text).replace(/\s+/g, " ");
    return flattened.length > MAX_DETAIL
      ? `${flattened.slice(0, MAX_DETAIL)}...`
      : flattened;
  } catch {
    // The body is a nicety; never let reading it mask the status we already have.
    return undefined;
  }
}

/**
 * Builds a function that removes a secret from a message. Applied to every
 * message derived from a caught error, because those messages are persisted.
 * An empty secret is a no-op — replacing `""` would corrupt the message.
 */
export function redactor(secret: string): (message: string) => string {
  if (!secret) return (message) => message;
  return (message) => message.split(secret).join("[redacted]");
}

export interface PostJsonRequest {
  provider: string;
  fetchImpl: typeof fetch;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  redact: (message: string) => string;
}

/**
 * POSTs JSON and returns the decoded body, with every failure mode mapped onto
 * the error taxonomy. The abort timer is cleared in `finally`, so it is cleared
 * on the success path too — an uncleared timer keeps the event loop alive and,
 * in a serverless process reused across invocations, would abort nothing while
 * still costing a handle.
 */
export async function postJson(req: PostJsonRequest): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);

  try {
    const response = await req.fetchImpl(req.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...req.headers },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw httpError(
        req.provider,
        response.status,
        await errorDetail(response, req.redact),
      );
    }
    return await response.json();
  } catch (e) {
    // Already classified above — pass it through unchanged.
    if (isAppError(e)) throw e;
    if (timedOut) {
      throw new ProviderError(
        req.provider,
        `Request timed out after ${req.timeoutMs}ms.`,
        true,
      );
    }
    // A transport fault, or a 2xx body that was not JSON. Both are plausibly
    // transient. The message comes from an error we did not construct, so it is
    // redacted before it is allowed to travel.
    throw new ProviderError(req.provider, req.redact(toErrorMessage(e)), true);
  } finally {
    clearTimeout(timer);
  }
}

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface GeminiBody {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
}

/**
 * Google Gemini. The primary provider because it enforces the response schema
 * server-side (`responseMimeType` + `responseSchema`) rather than asking the
 * model politely, which is what makes its output parseable often enough to be
 * the default.
 *
 * The API key travels in the `x-goog-api-key` header, never in the URL, so the
 * request URL is safe to put in an error message. Nothing here does anyway.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly redact: (message: string) => string;

  /**
   * Environment is read here, not at module scope. A module-level read is
   * evaluated once at import time, which under Next's bundling can be build
   * time — baking a build-machine value into the deployed artefact — and which
   * makes the class untestable, since a test can no longer change the value
   * before constructing it.
   */
  constructor(options: GeminiOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.GEMINI_API_KEY ?? "").trim();
    /*
     * Two properties are being bought here, both learned the hard way against
     * the live API rather than from the docs.
     *
     * *Floating alias, not a pinned version.* `gemini-2.5-flash` was the default
     * until Google began answering it with 404 "no longer available to new
     * users" — a non-retryable ProviderError, so every AI step failed outright.
     * An alias keeps resolving as versions are retired.
     *
     * *`flash-lite`, not `flash`.* `gemini-flash-latest` resolves to a thinking
     * model: measured here at 179 thinking tokens for 36 output tokens, with
     * latency swinging between 10s and 25s, which overruns the 15s timeout
     * below often enough to fail runs. It is also capped at 20 requests per day
     * on the free tier, which a single reviewer would exhaust in two runs. The
     * lite alias spends no thinking tokens and answers this workload in about a
     * second — and these steps classify into two labels and extract scalar
     * fields, so there is nothing for extended reasoning to buy.
     *
     * Override with GEMINI_MODEL to pin a specific version.
     */
    this.model = options.model ?? process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest";
    // Resolved per call rather than captured, so a stubbed `globalThis.fetch`
    // is honoured regardless of when the provider was constructed.
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.redact = redactor(this.apiKey);
  }

  async complete<T = unknown>(req: LlmRequest): Promise<LlmResponse<T>> {
    if (!this.apiKey) {
      // Not retryable: a key does not appear between two attempts.
      throw new ProviderError(this.name, "GEMINI_API_KEY is not set.", false);
    }

    const body = (await postJson({
      provider: this.name,
      fetchImpl: this.fetchImpl,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      headers: { "x-goog-api-key": this.apiKey },
      body: {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(req.schema),
          maxOutputTokens: req.maxTokens ?? 2048,
        },
      },
      timeoutMs: this.timeoutMs,
      redact: this.redact,
    })) as GeminiBody;

    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new ProviderError(this.name, "Response contained no content.");

    return {
      data: parseJsonStrict(text, this.name) as T,
      raw: text,
      inputTokens: toTokenCount(body.usageMetadata?.promptTokenCount),
      outputTokens: toTokenCount(body.usageMetadata?.candidatesTokenCount),
    };
  }
}

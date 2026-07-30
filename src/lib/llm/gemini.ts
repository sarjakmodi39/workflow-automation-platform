import {
  isAppError,
  ProviderError,
  RateLimitError,
  toErrorMessage,
  type AppError,
} from "@/lib/errors";
import type { FieldKind, JsonShape } from "@/lib/engine/registry";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/lib/llm/types";

/* Gemini provider plus the transport shared with OpenRouter. Nothing here writes to
 * `console`: every message lands in an LlmCall row and on a page, hence `redactor`. */

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

/** Derives a `responseSchema` from a `JsonShape`; every field is required, since an
 *  optional field defeats server-side enforcement. `array`/`object` lack item types. */
export function toGeminiSchema(shape: JsonShape): GeminiSchema {
  const properties: Record<string, { type: string }> = {};
  for (const [name, kind] of Object.entries(shape)) {
    properties[name] = { type: KIND_TO_GEMINI[kind] };
  }
  return { type: "OBJECT", properties, required: Object.keys(shape) };
}

/** Parses model output, tolerating markdown fences. Failures are ProviderError so `callLlm`
 *  can attribute and fall through; retryable, since model output is stochastic. */
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

/** Coerces usage numbers for the `Int?` columns. `Math.trunc` because a float fails at
 *  write time and would fail a succeeded call; `null` not `0`, so "not reported" stays honest. */
export function toTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/** Per-request timeout. The 40s tick budget is checked *between* steps, so a hung provider
 *  is not bounded by it; 15s lets a two-provider chain finish inside the budget. */
export const DEFAULT_LLM_TIMEOUT_MS = 15_000;

/** Maps a non-2xx status to the taxonomy: 429 -> RateLimitError and 5xx -> ProviderError are
 *  retryable; 4xx is not, since repeating a bad request only spends the call budget. */
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

/** A redacted, truncated slice of an error body: a bare `HTTP 400` is undiagnosable, and
 *  4xx never retries. Redacted because it is persisted; truncated in case it is HTML. */
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

/** Removes a secret from a message; applied to every caught error, since those persist.
 *  An empty secret is a no-op — replacing `""` would corrupt the message. */
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

/** POSTs JSON with every failure mapped onto the taxonomy. The abort timer clears in
 *  `finally`, including on success — an uncleared timer holds the event loop open. */
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
    // A transport fault or a 2xx body that was not JSON — both plausibly transient.
    // The message came from an error we did not construct, so redact before it travels.
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

/** Primary provider: it enforces the response schema server-side rather than asking the
 *  model politely. The key travels in a header, never the URL, so URLs are safe to log. */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly redact: (message: string) => string;

  /** Env is read here, not at module scope: an import-time read can be evaluated at build
   *  time under Next's bundling, and leaves no way for a test to change it first. */
  constructor(options: GeminiOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.GEMINI_API_KEY ?? "").trim();
    // An alias, since pinned versions get retired (2.5-flash now 404s); and `lite`, since
    // full `flash` thinks for 10-25s against a 15s timeout and allows 20 requests/day.
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

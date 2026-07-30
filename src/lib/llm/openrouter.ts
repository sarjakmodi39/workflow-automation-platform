import { ProviderError } from "@/lib/errors";
import {
  DEFAULT_LLM_TIMEOUT_MS,
  parseJsonStrict,
  postJson,
  redactor,
  toTokenCount,
} from "@/lib/llm/gemini";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/lib/llm/types";

export interface OpenRouterOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface OpenRouterBody {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/** The fallback. `response_format` is only advisory here, so the schema is restated in the
 *  prompt and parsed strictly. The key travels in a header, never the URL. */
export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter";
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly redact: (message: string) => string;

  /** Environment is read here, not at module scope — see `GeminiProvider`. */
  constructor(options: OpenRouterOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "").trim();
    this.model =
      options.model ??
      process.env.OPENROUTER_MODEL ??
      "meta-llama/llama-3.3-70b-instruct:free";
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.redact = redactor(this.apiKey);
  }

  async complete<T = unknown>(req: LlmRequest): Promise<LlmResponse<T>> {
    if (!this.apiKey) {
      // Not retryable: a key does not appear between two attempts.
      throw new ProviderError(this.name, "OPENROUTER_API_KEY is not set.", false);
    }

    const fieldList = Object.entries(req.schema)
      .map(([name, kind]) => `"${name}": ${kind}`)
      .join(", ");

    const body = (await postJson({
      provider: this.name,
      fetchImpl: this.fetchImpl,
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        response_format: { type: "json_object" },
        max_tokens: req.maxTokens ?? 2048,
        messages: [
          {
            role: "system",
            content: `${req.system}\n\nRespond with a single JSON object containing exactly these keys: { ${fieldList} }. Output nothing else.`,
          },
          { role: "user", content: req.user },
        ],
      },
      timeoutMs: this.timeoutMs,
      redact: this.redact,
    })) as OpenRouterBody;

    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError(this.name, "Response contained no content.");

    return {
      data: parseJsonStrict(text, this.name) as T,
      raw: text,
      inputTokens: toTokenCount(body.usage?.prompt_tokens),
      outputTokens: toTokenCount(body.usage?.completion_tokens),
    };
  }
}

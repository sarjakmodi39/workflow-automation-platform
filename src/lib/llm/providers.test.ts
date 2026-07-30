import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GeminiProvider,
  toGeminiSchema,
  toTokenCount,
} from "@/lib/llm/gemini";
import { OpenRouterProvider } from "@/lib/llm/openrouter";
import { ProviderError, RateLimitError } from "@/lib/errors";

const REQ = {
  system: "extract",
  user: "text",
  schema: { amount: "number" as const, vendor: "string" as const },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A stub transport that records what it was asked to send. */
function recordingFetch(body: unknown): {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return jsonResponse(body);
  };
  return { calls, fetchImpl };
}

function sentBody<T>(call: RecordedCall): T {
  return JSON.parse(call.init.body as string) as T;
}

interface SentGeminiBody {
  generationConfig: {
    responseMimeType: string;
    responseSchema: unknown;
    maxOutputTokens: number;
  };
}

interface SentOpenRouterBody {
  response_format: unknown;
  messages: { role: string; content: string }[];
}

/**
 * The suite must stay offline and deterministic: it runs in CI and on a machine
 * with no keys. Every test injects `fetchImpl`, so `globalThis.fetch` is
 * replaced with a stub that fails loudly — any real network attempt shows up as
 * a named failure rather than a timeout or, worse, a pass that depended on the
 * network. The one test that exercises the default transport swaps in its own
 * stub, and the original is restored in `afterEach` so a leaked stub cannot
 * change the outcome of another test file.
 */
const originalFetch = globalThis.fetch;
const originalEnv = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("network access is not allowed in this test suite");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("GEMINI_API_KEY");
  restoreEnv("OPENROUTER_API_KEY");
  restoreEnv("OPENROUTER_MODEL");
  vi.restoreAllMocks();
});

describe("toGeminiSchema", () => {
  it("maps the field shape onto a Gemini responseSchema", () => {
    expect(toGeminiSchema({ amount: "number", tags: "array" })).toEqual({
      type: "OBJECT",
      properties: { amount: { type: "NUMBER" }, tags: { type: "ARRAY" } },
      required: ["amount", "tags"],
    });
  });
});

describe("toTokenCount", () => {
  it("truncates a fractional count to an integer", () => {
    expect(toTokenCount(12.7)).toBe(12);
  });

  it("returns null rather than zero for an absent or non-numeric count", () => {
    expect(toTokenCount(undefined)).toBeNull();
    expect(toTokenCount(null)).toBeNull();
    expect(toTokenCount("12")).toBeNull();
    expect(toTokenCount(Number.NaN)).toBeNull();
    expect(toTokenCount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("keeps a real zero as zero", () => {
    expect(toTokenCount(0)).toBe(0);
  });
});

describe("GeminiProvider", () => {
  it("returns parsed data from a successful response", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          candidates: [
            { content: { parts: [{ text: '{"amount":10,"vendor":"Acme"}' }] } },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 },
        }),
    });

    const result = await provider.complete<{ amount: number }>(REQ);
    expect(result.data.amount).toBe(10);
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(8);
  });

  it("enforces JSON server-side via generationConfig", async () => {
    const { calls, fetchImpl } = recordingFetch({
      candidates: [{ content: { parts: [{ text: '{"amount":1,"vendor":"X"}' }] } }],
    });
    const provider = new GeminiProvider({ apiKey: "k", fetchImpl });
    await provider.complete(REQ);

    const sent = sentBody<SentGeminiBody>(calls[0]);
    expect(sent.generationConfig.responseMimeType).toBe("application/json");
    expect(sent.generationConfig.responseSchema).toEqual({
      type: "OBJECT",
      properties: { amount: { type: "NUMBER" }, vendor: { type: "STRING" } },
      required: ["amount", "vendor"],
    });
  });

  it("truncates fractional token counts to integers", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: '{"amount":1,"vendor":"X"}' }] } }],
          usageMetadata: {
            promptTokenCount: 12.9,
            candidatesTokenCount: 8.4,
          },
        }),
    });

    const result = await provider.complete(REQ);
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(8);
    expect(Number.isInteger(result.inputTokens)).toBe(true);
    expect(Number.isInteger(result.outputTokens)).toBe(true);
  });

  it("reports absent usage as null rather than zero", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: '{"amount":1,"vendor":"X"}' }] } }],
        }),
    });

    const result = await provider.complete(REQ);
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
  });

  it("maps HTTP 429 to a retryable RateLimitError", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "quota" }, 429),
    });
    await expect(provider.complete(REQ)).rejects.toBeInstanceOf(RateLimitError);
    const error = await provider.complete(REQ).catch((e) => e);
    expect(error.retryable).toBe(true);
  });

  it("maps HTTP 500 to a retryable ProviderError", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "boom" }, 500),
    });
    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
  });

  it("maps HTTP 401 to a ProviderError that is NOT retryable", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "bad key" }, 401),
    });
    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(false);
  });

  it("maps HTTP 400 to a ProviderError that is NOT retryable", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "malformed" }, 400),
    });
    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(false);
  });

  it("raises a ProviderError when the model returns unparseable output", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "not json at all" }] } }],
        }),
    });
    await expect(provider.complete(REQ)).rejects.toBeInstanceOf(ProviderError);
  });

  it("raises a ProviderError when the response carries no content", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ candidates: [] }),
    });
    await expect(provider.complete(REQ)).rejects.toBeInstanceOf(ProviderError);
  });

  it("aborts a hung request and maps the timeout to a retryable ProviderError", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    });

    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/timed out/i);
  });

  it("passes an abort signal to fetch and clears the timer on success", async () => {
    let seenSignal: unknown;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seenSignal = init?.signal;
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"amount":1,"vendor":"X"}' }] } }],
      });
    });
    const clear = vi.spyOn(globalThis, "clearTimeout");

    const provider = new GeminiProvider({ apiKey: "k", fetchImpl });
    await provider.complete(REQ);

    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect((seenSignal as AbortSignal).aborted).toBe(false);
    // Cleared on the success path too, not only when the request fails.
    expect(clear).toHaveBeenCalled();
  });

  it("maps a transport failure to a retryable ProviderError", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
  });

  it("never lets the API key reach the error message", async () => {
    const secret = "AIza-super-secret-key";
    const provider = new GeminiProvider({
      apiKey: secret,
      fetchImpl: async () => {
        // A transport error whose message happens to embed the key, which is
        // what a client that logged the request URL would produce.
        throw new TypeError(`connect ECONNREFUSED key=${secret}`);
      },
    });

    const error = await provider.complete(REQ).catch((e) => e);
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("[redacted]");
    expect(JSON.stringify(error.details)).not.toContain(secret);
  });

  it("treats a missing key as a non-retryable configuration fault", async () => {
    delete process.env.GEMINI_API_KEY;
    const provider = new GeminiProvider({
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    });

    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/GEMINI_API_KEY/);
  });

  it("reads the key from the environment at construction time, not import time", async () => {
    process.env.GEMINI_API_KEY = "from-env";
    const provider = new GeminiProvider({
      fetchImpl: async (_url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers["x-goog-api-key"]).toBe("from-env");
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: '{"amount":2,"vendor":"Y"}' }] } }],
        });
      },
    });

    const result = await provider.complete<{ amount: number }>(REQ);
    expect(result.data.amount).toBe(2);
  });

  it("defaults to globalThis.fetch, resolved per call", async () => {
    const provider = new GeminiProvider({ apiKey: "k" });
    // Replaced after construction: the default transport must be a late lookup.
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"amount":9,"vendor":"Z"}' }] } }],
      }),
    ) as unknown as typeof fetch;

    const result = await provider.complete<{ amount: number }>(REQ);
    expect(result.data.amount).toBe(9);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("puts the key in a header, never in the request URL", async () => {
    const secret = "AIza-url-check";
    const { calls, fetchImpl } = recordingFetch({
      candidates: [{ content: { parts: [{ text: '{"amount":1,"vendor":"X"}' }] } }],
    });
    const provider = new GeminiProvider({ apiKey: secret, fetchImpl });
    await provider.complete(REQ);

    expect(calls[0].url).not.toContain(secret);
    expect(calls[0].init.body).not.toContain(secret);
  });
});

describe("OpenRouterProvider", () => {
  it("returns parsed data from a successful response", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ message: { content: '{"amount":3,"vendor":"Globex"}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 4 },
        }),
    });

    const result = await provider.complete<{ vendor: string }>(REQ);
    expect(result.data.vendor).toBe("Globex");
  });

  it("strips a markdown code fence before parsing", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          choices: [
            { message: { content: '```json\n{"amount":1,"vendor":"X"}\n```' } },
          ],
        }),
    });
    const result = await provider.complete<{ amount: number }>(REQ);
    expect(result.data.amount).toBe(1);
  });

  it("maps HTTP 429 to a retryable RateLimitError", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "rate" }, 429),
    });
    await expect(provider.complete(REQ)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("maps HTTP 500 to a retryable ProviderError", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "boom" }, 502),
    });
    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
  });

  it("maps HTTP 401 to a ProviderError that is NOT retryable", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse({ error: "no credits" }, 401),
    });
    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(false);
  });

  it("truncates fractional token counts and nulls absent ones", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ message: { content: '{"amount":1,"vendor":"X"}' } }],
          usage: { prompt_tokens: 5.5 },
        }),
    });

    const result = await provider.complete(REQ);
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBeNull();
  });

  it("aborts a hung request and maps the timeout to a retryable ProviderError", async () => {
    const provider = new OpenRouterProvider({
      apiKey: "k",
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    });

    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/timed out/i);
  });

  it("restates the schema in the prompt because json_object is advisory here", async () => {
    const { calls, fetchImpl } = recordingFetch({
      choices: [{ message: { content: '{"amount":1,"vendor":"X"}' } }],
    });
    const provider = new OpenRouterProvider({ apiKey: "k", fetchImpl });
    await provider.complete(REQ);

    const sent = sentBody<SentOpenRouterBody>(calls[0]);
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages[0].content).toContain('"amount": number');
    expect(sent.messages[0].content).toContain('"vendor": string');
  });

  it("never lets the API key reach the error message", async () => {
    const secret = "sk-or-v1-secret";
    const provider = new OpenRouterProvider({
      apiKey: secret,
      fetchImpl: async () => {
        throw new TypeError(`socket hang up authorization=Bearer ${secret}`);
      },
    });

    const error = await provider.complete(REQ).catch((e) => e);
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("[redacted]");
  });

  it("treats a missing key as a non-retryable configuration fault", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const provider = new OpenRouterProvider({
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    });

    const error = await provider.complete(REQ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/OPENROUTER_API_KEY/);
  });

  it("reads the model from the environment at construction time", () => {
    process.env.OPENROUTER_MODEL = "some/other-model:free";
    expect(new OpenRouterProvider({ apiKey: "k" }).model).toBe(
      "some/other-model:free",
    );
  });

  it("puts the key in a header, never in the request URL", async () => {
    const secret = "sk-or-url-check";
    const { calls, fetchImpl } = recordingFetch({
      choices: [{ message: { content: '{"amount":1,"vendor":"X"}' } }],
    });
    const provider = new OpenRouterProvider({ apiKey: secret, fetchImpl });
    await provider.complete(REQ);

    // The negative assertions alone would also pass if the key were never sent
    // at all, so the header is asserted positively too.
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${secret}`);
    expect(calls[0].url).not.toContain(secret);
    expect(calls[0].init.body).not.toContain(secret);
  });
});

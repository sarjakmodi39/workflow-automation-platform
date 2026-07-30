import type { LlmProvider, LlmRequest, LlmResponse } from "@/lib/llm/types";

/** Deterministic provider for tests and offline demos. Fixtures are keyed by
 *  `system::user`; anything unmatched falls back to the default value. */
export class MockLlmProvider implements LlmProvider {
  readonly name: string;
  readonly model = "mock-1";

  private fixtures = new Map<string, unknown>();
  private defaultValue: unknown = {};
  private error: Error | null = null;
  private calls: LlmRequest[] = [];

  constructor(name = "mock") {
    this.name = name;
  }

  setFixture(key: string, value: unknown): this {
    this.fixtures.set(key, value);
    return this;
  }

  setDefault(value: unknown): this {
    this.defaultValue = value;
    return this;
  }

  failWith(error: Error): this {
    this.error = error;
    return this;
  }

  recordedCalls(): LlmRequest[] {
    return [...this.calls];
  }

  async complete<T = unknown>(req: LlmRequest): Promise<LlmResponse<T>> {
    this.calls.push(req);
    if (this.error) throw this.error;

    const key = `${req.system}::${req.user}`;
    const data = (this.fixtures.get(key) ?? this.defaultValue) as T;
    const raw = JSON.stringify(data);

    return {
      data,
      raw,
      inputTokens: req.user.length,
      outputTokens: raw.length,
    };
  }
}

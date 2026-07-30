import type { JsonShape } from "@/lib/engine/registry";

export interface LlmRequest {
  system: string;
  user: string;
  /** Field shape the provider must return. */
  schema: JsonShape;
  maxTokens?: number;
}

export interface LlmResponse<T = unknown> {
  data: T;
  raw: string;
  /** `null` when the provider did not report usage, matching the column's nullability so
   *  an absent count is recorded as absent rather than as a fabricated zero. */
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete<T = unknown>(req: LlmRequest): Promise<LlmResponse<T>>;
}

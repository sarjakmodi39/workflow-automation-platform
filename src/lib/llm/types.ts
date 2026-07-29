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
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete<T = unknown>(req: LlmRequest): Promise<LlmResponse<T>>;
}

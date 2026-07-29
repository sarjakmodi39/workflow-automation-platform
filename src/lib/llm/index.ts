import { StepExecutionError, toErrorMessage } from "@/lib/errors";
import type { RunStore } from "@/lib/engine/store";
import type { LlmProvider, LlmRequest } from "@/lib/llm/types";

export type { LlmProvider, LlmRequest, LlmResponse } from "@/lib/llm/types";
export { MockLlmProvider } from "@/lib/llm/mock";

export interface CallLlmDeps {
  store: RunStore;
  runId: string;
  stepExecutionId: string | null;
  /** Tried in order; the first success wins. */
  providers: LlmProvider[];
  maxCalls: number;
}

/**
 * Calls the first provider that succeeds, logging every attempt — successful
 * or not — as an LlmCall row. Enforces the per-run call budget before trying.
 */
export async function callLlm<T = unknown>(
  deps: CallLlmDeps,
  req: LlmRequest,
): Promise<T> {
  const used = await deps.store.countLlmCalls(deps.runId);
  if (used >= deps.maxCalls) {
    throw new StepExecutionError(
      `AI call budget exhausted for this run (limit ${deps.maxCalls} calls).`,
      false,
      { used, maxCalls: deps.maxCalls },
    );
  }

  if (deps.providers.length === 0) {
    throw new StepExecutionError("No LLM provider configured.", false);
  }

  let lastError: unknown;

  for (const provider of deps.providers) {
    const startedAt = Date.now();
    try {
      const result = await provider.complete<T>(req);
      await deps.store.recordLlmCall({
        runId: deps.runId,
        stepExecutionId: deps.stepExecutionId,
        provider: provider.name,
        model: provider.model,
        prompt: `${req.system}\n---\n${req.user}`,
        response: result.raw,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Date.now() - startedAt,
        status: "SUCCESS",
        error: null,
      });
      return result.data;
    } catch (e) {
      lastError = e;
      await deps.store.recordLlmCall({
        runId: deps.runId,
        stepExecutionId: deps.stepExecutionId,
        provider: provider.name,
        model: provider.model,
        prompt: `${req.system}\n---\n${req.user}`,
        response: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Date.now() - startedAt,
        status: "ERROR",
        error: toErrorMessage(e),
      });
    }
  }

  throw lastError;
}

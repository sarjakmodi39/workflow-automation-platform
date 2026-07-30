import { randomUUID } from "node:crypto";
import type { RunnerDeps } from "@/lib/engine/runner";
import { prismaRunStore } from "@/lib/engine/store.prisma";
import { GeminiProvider } from "@/lib/llm/gemini";
import { MockLlmProvider } from "@/lib/llm/mock";
import { OpenRouterProvider } from "@/lib/llm/openrouter";
import type { LlmProvider } from "@/lib/llm/types";

/**
 * Composition root for the engine.
 *
 * Reading the ambient clock and the ambient random source is *correct here* and
 * nowhere else: the runner and both stores take their clock and their token
 * source from this object precisely so they never reach for a global, and this
 * file is the one place whose job is to hand them the real ones.
 */

/** Used when MAX_LLM_CALLS_PER_RUN is absent, non-numeric, or non-positive. */
const DEFAULT_MAX_LLM_CALLS = 20;

/**
 * Wall-clock budget for one `advanceRun` tick. Vercel's serverless functions
 * are capped at 60s, so a tick stops driving new steps at 40s and persists its
 * cursor: the remaining 20s is headroom for the step already in flight to
 * finish and for the final status write to land. A run that needs longer is
 * resumed by the next tick from the persisted cursor, so the budget bounds a
 * single invocation, not the run.
 */
const BUDGET_MS = 40_000;

/**
 * Lock lease, deliberately longer than BUDGET_MS. A lease shorter than the
 * budget would expire while its holder was still working and let a second
 * worker into the same run.
 */
const LOCK_MS = 60_000;

/** Total attempts for an auto-retryable step, including the first. */
const MAX_AUTO_ATTEMPTS = 2;

function parseMaxLlmCalls(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_LLM_CALLS;
  const parsed = Number.parseInt(raw.trim(), 10);
  // A misconfigured budget must not silently become unlimited (NaN compares
  // false against every `>=`) or zero (which would fail every run).
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_LLM_CALLS;
  return parsed;
}

/**
 * Offline provider. Its recorded `provider` name is "mock", so every call it
 * serves is identifiable as such in the LlmCall ledger and the audit trail —
 * a mock answer is never presentable as a real one.
 *
 * The default value is shaped to satisfy both AI step types in the demo
 * workflow at once: `ai_extraction` picks out only the fields its config
 * declares and ignores the rest, and `ai_classification` reads `label`,
 * `confidence` and `rationale`. That coupling to the seeded workflow is the
 * weakness of a fixed default, and it is why this is a demo aid rather than a
 * general offline mode — see the Task 13 note below.
 */
function offlineProvider(): LlmProvider {
  return new MockLlmProvider("mock").setDefault({
    amount: 0,
    vendor: "Unknown vendor",
    category: "uncategorised",
    label: "low_risk",
    confidence: 0.5,
    rationale: "Offline mock provider response; no model was called.",
  });
}

/**
 * The configured real providers, ordered so `preferred` comes first.
 *
 * `callLlm` tries the chain in order and the first success wins, so this
 * ordering *is* the fallback policy. A provider is only included when its key
 * is present: an unkeyed provider would fail every call with "not set", which
 * would spend a chain position and an `LlmCall` ERROR row to learn nothing.
 *
 * Returns `[]` when neither key is set, which is what makes the offline mock
 * fallback in `buildProviders` reachable.
 */
function realProviders(preferred: string): LlmProvider[] {
  const chain: LlmProvider[] = [];
  if ((process.env.GEMINI_API_KEY ?? "").trim() !== "") {
    chain.push(new GeminiProvider());
  }
  if ((process.env.OPENROUTER_API_KEY ?? "").trim() !== "") {
    chain.push(new OpenRouterProvider());
  }
  // A `preferred` naming neither provider leaves the default order untouched
  // rather than emptying the chain — a typo in LLM_PROVIDER must not silently
  // demote a working setup to the mock.
  return [
    ...chain.filter((p) => p.name === preferred),
    ...chain.filter((p) => p.name !== preferred),
  ];
}

let warnedAboutFallback = false;

/**
 * The provider chain, in the order `callLlm` will try them.
 *
 * `LLM_PROVIDER=mock` asks for the offline provider explicitly. Otherwise the
 * real chain is used, and the mock stands in only when no real provider is
 * configured at all — otherwise a missing API key would make every AI step fail
 * and leave the demo undemonstrable. The substitution is warned about once and
 * is visible afterwards in every LlmCall row it produces.
 */
function buildProviders(): LlmProvider[] {
  const configured = (process.env.LLM_PROVIDER ?? "gemini").trim().toLowerCase();
  if (configured === "mock") return [offlineProvider()];

  const real = realProviders(configured);
  if (real.length > 0) return real;

  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      `[engine] No LLM provider available for LLM_PROVIDER="${configured}"; ` +
        "falling back to the offline mock provider. AI results are not real.",
    );
  }
  return [offlineProvider()];
}

/** Production wiring: the Prisma store, the provider chain, and real budgets. */
export function createRunnerDeps(): RunnerDeps {
  return {
    store: prismaRunStore,
    providers: buildProviders(),
    maxLlmCalls: parseMaxLlmCalls(process.env.MAX_LLM_CALLS_PER_RUN),
    budgetMs: BUDGET_MS,
    lockMs: LOCK_MS,
    maxAutoAttempts: MAX_AUTO_ATTEMPTS,
    now: () => new Date(),
    newToken: () => randomUUID(),
  };
}

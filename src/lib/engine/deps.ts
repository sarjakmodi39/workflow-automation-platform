import { randomUUID } from "node:crypto";
import type { RunnerDeps } from "@/lib/engine/runner";
import { prismaRunStore } from "@/lib/engine/store.prisma";
import { GeminiProvider } from "@/lib/llm/gemini";
import { MockLlmProvider } from "@/lib/llm/mock";
import { OpenRouterProvider } from "@/lib/llm/openrouter";
import type { LlmProvider } from "@/lib/llm/types";

/* Composition root. Reading the ambient clock and random source is correct here and nowhere
 * else — the runner and stores take both from this object so they never reach for a global. */

/** Used when MAX_LLM_CALLS_PER_RUN is absent, non-numeric, or non-positive. */
const DEFAULT_MAX_LLM_CALLS = 20;

/** Budget for one tick. Vercel caps a function at 60s, so driving stops at 40s and the
 *  cursor persists; the rest is headroom. Bounds one invocation, not the run. */
const BUDGET_MS = 40_000;

/** Lock lease, deliberately longer than BUDGET_MS: a shorter lease would expire while
 *  its holder was still working and admit a second worker to the same run. */
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

/** Offline provider, recorded as "mock" so its answers are never presentable as real ones.
 *  The default shape satisfies both AI step types at once — a demo aid, not an offline mode. */
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

/** Real providers with `preferred` first — the chain order *is* the fallback policy. Keyless
 *  providers are omitted rather than spending a chain position on a certain failure. */
function realProviders(preferred: string): LlmProvider[] {
  const chain: LlmProvider[] = [];
  if ((process.env.GEMINI_API_KEY ?? "").trim() !== "") {
    chain.push(new GeminiProvider());
  }
  if ((process.env.OPENROUTER_API_KEY ?? "").trim() !== "") {
    chain.push(new OpenRouterProvider());
  }
  // A `preferred` naming neither provider leaves the order untouched rather than emptying
  // the chain: a typo in LLM_PROVIDER must not silently demote a working setup to the mock.
  return [
    ...chain.filter((p) => p.name === preferred),
    ...chain.filter((p) => p.name !== preferred),
  ];
}

let warnedAboutFallback = false;

/** The provider chain in try order. `LLM_PROVIDER=mock` asks for offline explicitly; otherwise
 *  the mock stands in only when no key is set at all, warned once and visible in every row. */
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

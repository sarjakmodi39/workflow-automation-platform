import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@/lib/engine/store.memory";
import { MockLlmProvider } from "@/lib/llm/mock";
import { callLlm } from "@/lib/llm";
import { ProviderError, RateLimitError } from "@/lib/errors";
import type { WorkflowVersionRecord } from "@/lib/types";

const version: WorkflowVersionRecord = {
  id: "wv1",
  workflowId: "w1",
  version: 1,
  definition: { steps: [] },
  grantedPermissions: [],
  createdAt: new Date(),
};

async function setup() {
  const store = createMemoryStore({ versions: [version] });
  const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
  return { store, runId: run.id };
}

const REQ = {
  system: "extract",
  user: "invoice text",
  schema: { amount: "number" as const },
};

describe("callLlm", () => {
  it("returns the primary provider's data and logs the call", async () => {
    const { store, runId } = await setup();
    const primary = new MockLlmProvider("gemini");
    primary.setDefault({ amount: 5200 });

    const data = await callLlm<{ amount: number }>(
      { store, runId, stepExecutionId: null, providers: [primary], maxCalls: 10 },
      REQ,
    );

    expect(data.amount).toBe(5200);
    const calls = await store.listLlmCalls(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe("gemini");
    expect(calls[0].status).toBe("SUCCESS");
  });

  it("falls back to the secondary provider when the primary is rate limited", async () => {
    const { store, runId } = await setup();
    const primary = new MockLlmProvider("gemini");
    primary.failWith(new RateLimitError("gemini"));
    const fallback = new MockLlmProvider("openrouter");
    fallback.setDefault({ amount: 42 });

    const data = await callLlm<{ amount: number }>(
      {
        store,
        runId,
        stepExecutionId: null,
        providers: [primary, fallback],
        maxCalls: 10,
      },
      REQ,
    );

    expect(data.amount).toBe(42);
    const calls = await store.listLlmCalls(runId);
    expect(calls).toHaveLength(2);
    expect(calls[0].provider).toBe("gemini");
    expect(calls[0].status).toBe("ERROR");
    expect(calls[1].provider).toBe("openrouter");
    expect(calls[1].status).toBe("SUCCESS");
  });

  it("falls back on a provider error as well as a rate limit", async () => {
    const { store, runId } = await setup();
    const primary = new MockLlmProvider("gemini");
    primary.failWith(new ProviderError("gemini", "502 bad gateway"));
    const fallback = new MockLlmProvider("openrouter");
    fallback.setDefault({ amount: 7 });

    const data = await callLlm<{ amount: number }>(
      {
        store,
        runId,
        stepExecutionId: null,
        providers: [primary, fallback],
        maxCalls: 10,
      },
      REQ,
    );
    expect(data.amount).toBe(7);
  });

  it("throws the last error when every provider fails", async () => {
    const { store, runId } = await setup();
    const primary = new MockLlmProvider("gemini");
    primary.failWith(new RateLimitError("gemini"));
    const fallback = new MockLlmProvider("openrouter");
    fallback.failWith(new RateLimitError("openrouter"));

    await expect(
      callLlm(
        {
          store,
          runId,
          stepExecutionId: null,
          providers: [primary, fallback],
          maxCalls: 10,
        },
        REQ,
      ),
    ).rejects.toBeInstanceOf(RateLimitError);

    const calls = await store.listLlmCalls(runId);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.status === "ERROR")).toBe(true);
  });

  it("refuses to exceed the per-run call budget", async () => {
    const { store, runId } = await setup();
    const provider = new MockLlmProvider("gemini");
    provider.setDefault({ amount: 1 });

    await callLlm(
      { store, runId, stepExecutionId: null, providers: [provider], maxCalls: 1 },
      REQ,
    );

    await expect(
      callLlm(
        { store, runId, stepExecutionId: null, providers: [provider], maxCalls: 1 },
        REQ,
      ),
    ).rejects.toThrow(/budget/i);
  });
});

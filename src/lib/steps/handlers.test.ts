import { describe, expect, it } from "vitest";
import { HANDLERS, buildIdempotencyKey } from "@/lib/steps";
import { createMemoryStore } from "@/lib/engine/store.memory";
import { MockLlmProvider } from "@/lib/llm/mock";
import type { StepDefinition, WorkflowVersionRecord } from "@/lib/types";
import type { StepHandlerDeps } from "@/lib/steps";

const version: WorkflowVersionRecord = {
  id: "wv1",
  workflowId: "w1",
  version: 1,
  definition: { steps: [] },
  grantedPermissions: [],
  createdAt: new Date(),
};

async function makeDeps(
  ctxOverrides: Partial<StepHandlerDeps["ctx"]> = {},
  provider = new MockLlmProvider("gemini"),
): Promise<StepHandlerDeps> {
  const store = createMemoryStore({ versions: [version] });
  const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
  return {
    store,
    runId: run.id,
    stepExecutionId: null,
    providers: [provider],
    maxLlmCalls: 20,
    ctx: { input: {}, steps: {}, ...ctxOverrides },
    now: () => new Date("2026-07-29T00:00:00Z"),
  };
}

describe("structured_input handler", () => {
  it("returns the declared fields from the run input", async () => {
    const deps = await makeDeps({ input: { invoiceId: "INV-1", amount: 100 } });
    const step: StepDefinition = {
      id: "intake",
      type: "structured_input",
      name: "Intake",
      config: {
        fields: [
          { name: "invoiceId", kind: "string" },
          { name: "amount", kind: "number" },
        ],
      },
    };
    const result = await HANDLERS.structured_input(step, deps);
    expect(result.output).toEqual({ invoiceId: "INV-1", amount: 100 });
  });

  it("rejects input missing a declared field", async () => {
    const deps = await makeDeps({ input: { invoiceId: "INV-1" } });
    const step: StepDefinition = {
      id: "intake",
      type: "structured_input",
      name: "Intake",
      config: { fields: [{ name: "amount", kind: "number" }] },
    };
    await expect(HANDLERS.structured_input(step, deps)).rejects.toThrow(/amount/);
  });

  it("rejects input where a declared field has the wrong type", async () => {
    const deps = await makeDeps({ input: { amount: "not-a-number" } });
    const step: StepDefinition = {
      id: "intake",
      type: "structured_input",
      name: "Intake",
      config: { fields: [{ name: "amount", kind: "number" }] },
    };
    await expect(HANDLERS.structured_input(step, deps)).rejects.toThrow(/number/);
  });

  it("marks a bad run input as NOT retryable, because the input never changes", async () => {
    const deps = await makeDeps({ input: { invoiceId: "INV-1" } });
    const step: StepDefinition = {
      id: "intake",
      type: "structured_input",
      name: "Intake",
      config: { fields: [{ name: "vendor", kind: "string" }] },
    };

    // `retryable` decides whether the runner spends another attempt. Run input is fixed at
    // creation, so a retryable error here produces a column of identical failures.
    await expect(HANDLERS.structured_input(step, deps)).rejects.toMatchObject({
      code: "STEP_EXECUTION_ERROR",
      retryable: false,
    });
  });
});

describe("document_retrieval handler", () => {
  it("returns matching documents and a count", async () => {
    const deps = await makeDeps();
    const step: StepDefinition = {
      id: "retrieve",
      type: "document_retrieval",
      name: "Retrieve",
      config: { query: "invoice approval threshold", topK: 2 },
    };
    const result = await HANDLERS.document_retrieval(step, deps);
    const output = result.output as { documents: unknown[]; matchCount: number };
    expect(output.matchCount).toBeGreaterThan(0);
    expect(output.documents.length).toBeLessThanOrEqual(2);
  });

  it("resolves a query containing a context path", async () => {
    const deps = await makeDeps({ steps: { intake: { vendor: "Globex" } } });
    const step: StepDefinition = {
      id: "retrieve",
      type: "document_retrieval",
      name: "Retrieve",
      config: { query: "$.steps.intake.vendor", topK: 3 },
    };
    const result = await HANDLERS.document_retrieval(step, deps);
    const output = result.output as { documents: { id: string }[] };
    expect(output.documents.some((d) => d.id === "vendor-globex-profile")).toBe(true);
  });
});

describe("ai_extraction handler", () => {
  it("returns the fields the model produced", async () => {
    const provider = new MockLlmProvider("gemini").setDefault({
      amount: 5200,
      vendor: "Acme",
    });
    const deps = await makeDeps({ steps: { intake: { raw: "invoice body" } } }, provider);
    const step: StepDefinition = {
      id: "extract",
      type: "ai_extraction",
      name: "Extract",
      config: {
        source: "$.steps.intake.raw",
        fields: [
          { name: "amount", kind: "number" },
          { name: "vendor", kind: "string" },
        ],
      },
    };
    const result = await HANDLERS.ai_extraction(step, deps);
    expect(result.output).toEqual({ amount: 5200, vendor: "Acme" });
  });

  it("fails when the model omits a declared field", async () => {
    const provider = new MockLlmProvider("gemini").setDefault({ vendor: "Acme" });
    const deps = await makeDeps({ steps: { intake: { raw: "x" } } }, provider);
    const step: StepDefinition = {
      id: "extract",
      type: "ai_extraction",
      name: "Extract",
      config: {
        source: "$.steps.intake.raw",
        fields: [{ name: "amount", kind: "number" }],
      },
    };
    await expect(HANDLERS.ai_extraction(step, deps)).rejects.toThrow(/amount/);
  });
});

describe("ai_classification handler", () => {
  it("returns the label, confidence, and rationale", async () => {
    const provider = new MockLlmProvider("gemini").setDefault({
      label: "high_risk",
      confidence: 0.91,
      rationale: "Vendor is under enhanced monitoring.",
    });
    const deps = await makeDeps({ steps: { extract: { vendor: "Globex" } } }, provider);
    const step: StepDefinition = {
      id: "classify",
      type: "ai_classification",
      name: "Classify",
      config: { source: "$.steps.extract", labels: ["low_risk", "high_risk"] },
    };
    const result = await HANDLERS.ai_classification(step, deps);
    const output = result.output as { label: string; confidence: number };
    expect(output.label).toBe("high_risk");
    expect(output.confidence).toBeCloseTo(0.91);
  });

  it("fails when the model returns a label outside the declared set", async () => {
    const provider = new MockLlmProvider("gemini").setDefault({
      label: "catastrophic",
      confidence: 1,
      rationale: "made up",
    });
    const deps = await makeDeps({ steps: { extract: {} } }, provider);
    const step: StepDefinition = {
      id: "classify",
      type: "ai_classification",
      name: "Classify",
      config: { source: "$.steps.extract", labels: ["low_risk", "high_risk"] },
    };
    await expect(HANDLERS.ai_classification(step, deps)).rejects.toThrow(/catastrophic/);
  });
});

describe("deterministic_condition handler", () => {
  it("records the branch taken and why", async () => {
    const deps = await makeDeps({ steps: { extract: { amount: 5200 } } });
    const step: StepDefinition = {
      id: "check",
      type: "deterministic_condition",
      name: "Over threshold?",
      config: {},
      condition: { left: "$.steps.extract.amount", op: "gt", right: 5000 },
      onTrue: "approve",
      onFalse: "report",
    };
    const result = await HANDLERS.deterministic_condition(step, deps);
    const output = result.output as { result: boolean; branchTaken: string };
    expect(output.result).toBe(true);
    expect(output.branchTaken).toBe("approve");
    expect(result.nextStepId).toBe("approve");

    const explanation = result.explanation as {
      description: string;
      resolvedInputs: Record<string, unknown>;
    };
    expect(explanation.description).toBe("amount (5200) > 5000");
    expect(explanation.resolvedInputs["$.steps.extract.amount"]).toBe(5200);
  });

  it("takes the false branch when the comparator does not hold", async () => {
    const deps = await makeDeps({ steps: { extract: { amount: 10 } } });
    const step: StepDefinition = {
      id: "check",
      type: "deterministic_condition",
      name: "Over threshold?",
      config: {},
      condition: { left: "$.steps.extract.amount", op: "gt", right: 5000 },
      onTrue: "approve",
      onFalse: "report",
    };
    const result = await HANDLERS.deterministic_condition(step, deps);
    expect(result.nextStepId).toBe("report");
  });
});

describe("mock_external_action handler", () => {
  it("performs the write once and reports it as not duplicated", async () => {
    const deps = await makeDeps({ steps: { extract: { amount: 100 } } });
    const step: StepDefinition = {
      id: "post",
      type: "mock_external_action",
      name: "Post",
      config: { action: "post_invoice", payload: { amount: "$.steps.extract.amount" } },
    };
    const result = await HANDLERS.mock_external_action(step, deps);
    const output = result.output as { duplicatePrevented: boolean; status: string };
    expect(output.duplicatePrevented).toBe(false);
    expect(output.status).toBe("SUBMITTED");
  });

  it("returns the original response and flags a duplicate on a second call", async () => {
    const deps = await makeDeps({ steps: { extract: { amount: 100 } } });
    const step: StepDefinition = {
      id: "post",
      type: "mock_external_action",
      name: "Post",
      config: { action: "post_invoice", payload: { amount: "$.steps.extract.amount" } },
    };
    const first = await HANDLERS.mock_external_action(step, deps);
    const second = await HANDLERS.mock_external_action(step, deps);

    const a = first.output as { actionId: string; duplicatePrevented: boolean };
    const b = second.output as { actionId: string; duplicatePrevented: boolean };

    expect(b.duplicatePrevented).toBe(true);
    expect(b.actionId).toBe(a.actionId);
  });

  it("returns the stored response, not a recomputed one, on a duplicate", async () => {
    // actionId derives from the key alone, so it cannot tell a re-read from a recompute.
    // An advancing clock can: the duplicate must report the ORIGINAL write's moment.
    const deps = await makeDeps({ steps: { extract: { amount: 100 } } });
    let tick = 0;
    const clock = ["2026-07-29T00:00:00.000Z", "2026-07-29T09:30:00.000Z"];
    deps.now = () => new Date(clock[Math.min(tick++, clock.length - 1)]);

    const step: StepDefinition = {
      id: "post",
      type: "mock_external_action",
      name: "Post",
      config: { action: "post_invoice", payload: { amount: "$.steps.extract.amount" } },
    };
    const first = await HANDLERS.mock_external_action(step, deps);
    const second = await HANDLERS.mock_external_action(step, deps);

    const a = first.output as { submittedAt: string };
    const b = second.output as { submittedAt: string; duplicatePrevented: boolean };

    expect(a.submittedAt).toBe(clock[0]);
    expect(b.duplicatePrevented).toBe(true);
    expect(b.submittedAt).toBe(clock[0]);
    expect(b.submittedAt).not.toBe(clock[1]);
  });
});

describe("human_approval handler", () => {
  it("refuses to run, because the runner intercepts approval gates", async () => {
    const deps = await makeDeps();
    const step: StepDefinition = {
      id: "gate",
      type: "human_approval",
      name: "Approve",
      config: {},
    };
    await expect(HANDLERS.human_approval(step, deps)).rejects.toThrow(
      /handled by the runner/i,
    );
  });
});

describe("final_report handler", () => {
  it("assembles sections from prior step outputs", async () => {
    const deps = await makeDeps({
      steps: { extract: { amount: 5200 }, classify: { label: "high_risk" } },
    });
    const step: StepDefinition = {
      id: "report",
      type: "final_report",
      name: "Report",
      config: { title: "Invoice Review", summarize: false },
    };
    const result = await HANDLERS.final_report(step, deps);
    const output = result.output as { title: string; sections: { stepId: string }[] };
    expect(output.title).toBe("Invoice Review");
    expect(output.sections.map((s) => s.stepId)).toEqual(["extract", "classify"]);
  });
});

describe("buildIdempotencyKey", () => {
  it("is stable for the same inputs and differs for different payloads", () => {
    const a = buildIdempotencyKey("run1", "post", "post_invoice", { amount: 1 });
    const b = buildIdempotencyKey("run1", "post", "post_invoice", { amount: 1 });
    const c = buildIdempotencyKey("run1", "post", "post_invoice", { amount: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("ignores key order within the payload", () => {
    const a = buildIdempotencyKey("run1", "post", "act", { x: 1, y: 2 });
    const b = buildIdempotencyKey("run1", "post", "act", { y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("sorts keys at every depth, not just the top level", () => {
    const a = buildIdempotencyKey("run1", "post", "act", { o: { x: 1, y: 2 } });
    const b = buildIdempotencyKey("run1", "post", "act", { o: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it("respects array order, which is semantic", () => {
    const a = buildIdempotencyKey("run1", "post", "act", { lines: [1, 2] });
    const b = buildIdempotencyKey("run1", "post", "act", { lines: [2, 1] });
    expect(a).not.toBe(b);
  });

  it("separates undefined from null so an unset path is not a duplicate write", () => {
    // JSON.stringify renders both as `null`; if the hash did too, an unset upstream path
    // would collide with an explicit null and the ledger would swallow a real write.
    const undef = buildIdempotencyKey("run1", "post", "act", { note: undefined });
    const nul = buildIdempotencyKey("run1", "post", "act", { note: null });
    expect(undef).not.toBe(nul);
  });

  it("separates non-finite numbers from null and from each other", () => {
    const key = (v: unknown) => buildIdempotencyKey("r", "s", "a", { v });
    const distinct = new Set([
      key(null),
      key(NaN),
      key(Infinity),
      key(-Infinity),
      key(0),
    ]);
    expect(distinct.size).toBe(5);
  });

  it("does not emit control characters, which Postgres text columns reject", () => {
    const key = buildIdempotencyKey("run1", "post", "act", {
      a: undefined,
      b: NaN,
      c: null,
    });
    expect(key).toMatch(/^[0-9a-f]{48}$/);
  });
});

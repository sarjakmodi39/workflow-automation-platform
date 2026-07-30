import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceRun,
  cancelRun,
  decideApproval,
  resumeRun,
  retryStep,
  startRun,
  type RunnerDeps,
} from "@/lib/engine/runner";
import { createMemoryStore, MemoryRunStore } from "@/lib/engine/store.memory";
import { MockLlmProvider } from "@/lib/llm/mock";
import { RateLimitError } from "@/lib/errors";
import type { WorkflowDefinition, WorkflowVersionRecord } from "@/lib/types";

const GRANTS = ["tool:llm", "tool:document_search", "action:post_invoice"];

function definition(): WorkflowDefinition {
  return {
    steps: [
      {
        id: "intake",
        type: "structured_input",
        name: "Intake",
        config: {
          fields: [
            { name: "invoiceId", kind: "string" },
            { name: "amount", kind: "number" },
          ],
        },
      },
      {
        id: "classify",
        type: "ai_classification",
        name: "Classify risk",
        config: { source: "$.steps.intake", labels: ["low_risk", "high_risk"] },
      },
      {
        id: "check",
        type: "deterministic_condition",
        name: "Over threshold?",
        config: {},
        condition: { left: "$.steps.intake.amount", op: "gt", right: 5000 },
        onTrue: "approve",
        onFalse: "report",
      },
      {
        id: "approve",
        type: "human_approval",
        name: "Manager approval",
        config: { prompt: "Approve this high-value invoice?" },
      },
      {
        id: "post",
        type: "mock_external_action",
        name: "Post to accounting",
        config: {
          action: "post_invoice",
          payload: { amount: "$.steps.intake.amount" },
        },
      },
      {
        id: "report",
        type: "final_report",
        name: "Report",
        config: { title: "Invoice Review", summarize: false },
      },
    ],
  };
}

function version(def = definition()): WorkflowVersionRecord {
  return {
    id: "wv1",
    workflowId: "w1",
    version: 1,
    definition: def,
    grantedPermissions: GRANTS,
    createdAt: new Date(),
  };
}

let store: MemoryRunStore;
let provider: MockLlmProvider;
let deps: RunnerDeps;

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    store,
    providers: [provider],
    maxLlmCalls: 20,
    budgetMs: 30_000,
    lockMs: 60_000,
    maxAutoAttempts: 2,
    now: () => new Date("2026-07-29T00:00:00Z"),
    newToken: () => `tok_${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

beforeEach(() => {
  store = createMemoryStore({ versions: [version()] });
  provider = new MockLlmProvider("gemini").setDefault({
    label: "high_risk",
    confidence: 0.9,
    rationale: "Large amount.",
  });
  deps = makeDeps();
});

describe("output passing between steps", () => {
  it("makes step N's output available to step N+1", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-1", amount: 100 });
    const finished = await advanceRun(deps, run.id);

    expect(finished.status).toBe("COMPLETED");

    const steps = await store.listStepExecutions(run.id);
    const intake = steps.find((s) => s.stepId === "intake");
    const report = steps.find((s) => s.stepId === "report");

    expect(intake?.output).toEqual({ invoiceId: "INV-1", amount: 100 });

    const sections = (report?.output as { sections: { stepId: string }[] }).sections;
    expect(sections.map((s) => s.stepId)).toContain("intake");
    expect(sections.map((s) => s.stepId)).toContain("classify");
  });
});

describe("human approval", () => {
  it("halts at the approval step and advances no further", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-2", amount: 9000 });
    const paused = await advanceRun(deps, run.id);

    expect(paused.status).toBe("AWAITING_APPROVAL");

    const steps = await store.listStepExecutions(run.id);
    expect(steps.find((s) => s.stepId === "approve")?.status).toBe("AWAITING_APPROVAL");
    expect(steps.find((s) => s.stepId === "post")).toBeUndefined();

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "APPROVAL_REQUESTED")).toBe(true);
  });

  it("does not advance when advanceRun is called again while awaiting approval", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-2", amount: 9000 });
    await advanceRun(deps, run.id);
    const again = await advanceRun(deps, run.id);

    expect(again.status).toBe("AWAITING_APPROVAL");
    const steps = await store.listStepExecutions(run.id);
    expect(steps.filter((s) => s.stepId === "approve")).toHaveLength(1);
  });

  it("resumes to completion once approved", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-2", amount: 9000 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    const approval = steps.find((s) => s.stepId === "approve");

    const finished = await decideApproval(
      deps,
      run.id,
      approval!.id,
      "APPROVED",
      "Checked against policy.",
    );

    expect(finished.status).toBe("COMPLETED");

    const after = await store.listStepExecutions(run.id);
    expect(after.find((s) => s.stepId === "post")?.status).toBe("SUCCEEDED");

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "APPROVAL_DECIDED")).toBe(true);
  });

  it("terminates the run as CANCELLED when rejected, without running later steps", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-2", amount: 9000 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    const approval = steps.find((s) => s.stepId === "approve");

    const finished = await decideApproval(
      deps,
      run.id,
      approval!.id,
      "REJECTED",
      "Vendor not verified.",
    );

    expect(finished.status).toBe("CANCELLED");

    const after = await store.listStepExecutions(run.id);
    expect(after.find((s) => s.stepId === "post")).toBeUndefined();
    expect(after.find((s) => s.stepId === "approve")?.status).toBe("SUCCEEDED");
  });
});

describe("cancel and resume", () => {
  it("cancels a run awaiting approval", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-3", amount: 9000 });
    await advanceRun(deps, run.id);
    const cancelled = await cancelRun(deps, run.id);

    expect(cancelled.status).toBe("CANCELLED");
    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "RUN_CANCELLED")).toBe(true);
  });

  it("resumes a cancelled run without re-executing completed steps", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-3", amount: 100 });
    await advanceRun(deps, run.id);

    const before = await store.listStepExecutions(run.id);
    const intakeId = before.find((s) => s.stepId === "intake")!.id;

    await cancelRun(deps, run.id);
    await resumeRun(deps, run.id);

    const after = await store.listStepExecutions(run.id);
    expect(after.filter((s) => s.stepId === "intake")).toHaveLength(1);
    expect(after.find((s) => s.stepId === "intake")!.id).toBe(intakeId);

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "RUN_RESUMED")).toBe(true);
  });
});

describe("failure and retry", () => {
  it("fails the run and leaves it resumable when a step errors", async () => {
    provider.failWith(new RateLimitError("gemini"));
    const secondary = new MockLlmProvider("openrouter").failWith(
      new RateLimitError("openrouter"),
    );
    deps = makeDeps({ providers: [provider, secondary], maxAutoAttempts: 1 });

    const run = await startRun(deps, "wv1", { invoiceId: "INV-4", amount: 100 });
    const failed = await advanceRun(deps, run.id);

    expect(failed.status).toBe("FAILED");

    const steps = await store.listStepExecutions(run.id);
    expect(steps.find((s) => s.stepId === "classify")?.status).toBe("FAILED");

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "STEP_FAILED")).toBe(true);
  });

  it("auto-retries a safe step whose error is retryable", async () => {
    let attempts = 0;
    const flaky = new MockLlmProvider("gemini");
    const original = flaky.complete.bind(flaky);
    flaky.complete = (async (req) => {
      attempts += 1;
      if (attempts === 1) throw new RateLimitError("gemini");
      return original(req);
    }) as typeof flaky.complete;
    flaky.setDefault({ label: "low_risk", confidence: 0.8, rationale: "Small." });

    deps = makeDeps({ providers: [flaky], maxAutoAttempts: 2 });

    const run = await startRun(deps, "wv1", { invoiceId: "INV-5", amount: 100 });
    const finished = await advanceRun(deps, run.id);

    expect(finished.status).toBe("COMPLETED");
    const steps = await store.listStepExecutions(run.id);
    const classifyAttempts = steps.filter((s) => s.stepId === "classify");
    expect(classifyAttempts.length).toBe(2);
    expect(classifyAttempts.at(-1)?.status).toBe("SUCCEEDED");
  });

  it("never auto-retries the unsafe external action step", async () => {
    const def = definition();
    def.steps = [
      def.steps[0],
      { ...def.steps[4], config: { action: "post_invoice", payload: { bad: true } } },
    ];
    store = createMemoryStore({ versions: [version(def)] });
    deps = makeDeps();

    const run = await startRun(deps, "wv1", { invoiceId: "INV-6", amount: 100 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    expect(steps.filter((s) => s.stepId === "post").length).toBe(1);
    expect(steps.find((s) => s.stepId === "post")?.retrySafe).toBe(false);
  });

  it("retries a failed safe step on request and completes the run", async () => {
    const failing = new MockLlmProvider("gemini").failWith(new RateLimitError("gemini"));
    deps = makeDeps({ providers: [failing], maxAutoAttempts: 1 });

    const run = await startRun(deps, "wv1", { invoiceId: "INV-7", amount: 100 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    const failedStep = steps.find((s) => s.stepId === "classify" && s.status === "FAILED");
    expect(failedStep).toBeDefined();

    const healthy = new MockLlmProvider("gemini").setDefault({
      label: "low_risk",
      confidence: 0.7,
      rationale: "Recovered.",
    });
    deps = makeDeps({ providers: [healthy] });

    const finished = await retryStep(deps, run.id, failedStep!.id);
    expect(finished.status).toBe("COMPLETED");

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "RETRY_ATTEMPTED")).toBe(true);
  });
});

describe("idempotency across retries", () => {
  it("does not write the external action twice when the step is retried", async () => {
    const def = definition();
    def.steps = [def.steps[0], def.steps[4], def.steps[5]];
    store = createMemoryStore({ versions: [version(def)] });
    deps = makeDeps();

    const run = await startRun(deps, "wv1", { invoiceId: "INV-8", amount: 100 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    const post = steps.find((s) => s.stepId === "post");
    const firstRef = (post?.output as { actionId: string }).actionId;

    await retryStep(deps, run.id, post!.id);

    const after = await store.listStepExecutions(run.id);
    const retried = after.filter((s) => s.stepId === "post").at(-1);
    const output = retried?.output as { actionId: string; duplicatePrevented: boolean };

    expect(output.actionId).toBe(firstRef);
    expect(output.duplicatePrevented).toBe(true);

    const audit = await store.listAudit(run.id);
    expect(audit.some((e) => e.type === "DUPLICATE_WRITE_PREVENTED")).toBe(true);
  });
});

describe("execution path explanation", () => {
  it("records the resolved inputs and branch for a condition step", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-9", amount: 9000 });
    await advanceRun(deps, run.id);

    const steps = await store.listStepExecutions(run.id);
    const check = steps.find((s) => s.stepId === "check");
    const explanation = check?.explanation as {
      description: string;
      branchTaken: string;
      resolvedInputs: Record<string, unknown>;
    };

    expect(explanation.description).toBe("amount (9000) > 5000");
    expect(explanation.branchTaken).toBe("approve");
    expect(explanation.resolvedInputs["$.steps.intake.amount"]).toBe(9000);
  });

  it("takes the false branch and skips approval for a small invoice", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-10", amount: 10 });
    const finished = await advanceRun(deps, run.id);

    expect(finished.status).toBe("COMPLETED");
    const steps = await store.listStepExecutions(run.id);
    expect(steps.find((s) => s.stepId === "approve")).toBeUndefined();
    expect(steps.find((s) => s.stepId === "report")?.status).toBe("SUCCEEDED");
  });
});

describe("locking", () => {
  it("returns the current run without advancing when the lock is held", async () => {
    const run = await startRun(deps, "wv1", { invoiceId: "INV-11", amount: 100 });
    await store.acquireLock(run.id, "someone-else", new Date(Date.now() + 60_000));

    const result = await advanceRun(deps, run.id);
    expect(result.status).toBe("PENDING");
    expect(await store.listStepExecutions(run.id)).toHaveLength(0);
  });
});

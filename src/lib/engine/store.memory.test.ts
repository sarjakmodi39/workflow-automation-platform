import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@/lib/engine/store.memory";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { WorkflowVersionRecord } from "@/lib/types";

const version: WorkflowVersionRecord = {
  id: "wv1",
  workflowId: "w1",
  version: 1,
  definition: { steps: [] },
  grantedPermissions: ["tool:llm"],
  createdAt: new Date("2026-01-01"),
};

describe("MemoryRunStore", () => {
  it("returns a seeded workflow version and null for a missing one", async () => {
    const store = createMemoryStore({ versions: [version] });
    expect((await store.getWorkflowVersion("wv1"))?.version).toBe(1);
    expect(await store.getWorkflowVersion("missing")).toBeNull();
  });

  it("creates a run in PENDING with no cursor", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: { a: 1 } });
    expect(run.status).toBe("PENDING");
    expect(run.cursor).toBeNull();
    expect(await store.getRun(run.id)).not.toBeNull();
  });

  it("grants the lock once and refuses a second holder", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    const until = new Date(Date.now() + 60_000);
    expect(await store.acquireLock(run.id, "token-a", until)).toBe(true);
    expect(await store.acquireLock(run.id, "token-b", until)).toBe(false);
  });

  it("allows re-acquisition after the lock expires", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    await store.acquireLock(run.id, "token-a", new Date(Date.now() - 1000));
    expect(
      await store.acquireLock(run.id, "token-b", new Date(Date.now() + 60_000)),
    ).toBe(true);
  });

  it("only releases the lock for the token that holds it", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    await store.acquireLock(run.id, "token-a", new Date(Date.now() + 60_000));
    await store.releaseLock(run.id, "token-b");
    expect(
      await store.acquireLock(run.id, "token-c", new Date(Date.now() + 60_000)),
    ).toBe(false);
    await store.releaseLock(run.id, "token-a");
    expect(
      await store.acquireLock(run.id, "token-c", new Date(Date.now() + 60_000)),
    ).toBe(true);
  });

  it("records step executions and returns them in creation order", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    await store.createStepExecution({
      runId: run.id,
      stepId: "a",
      stepType: "structured_input",
      status: "RUNNING",
      attempt: 1,
      retrySafe: true,
      input: {},
    });
    const second = await store.createStepExecution({
      runId: run.id,
      stepId: "b",
      stepType: "final_report",
      status: "RUNNING",
      attempt: 1,
      retrySafe: true,
      input: {},
    });
    await store.updateStepExecution(second.id, {
      status: "SUCCEEDED",
      output: { ok: 1 },
    });

    const all = await store.listStepExecutions(run.id);
    expect(all.map((s) => s.stepId)).toEqual(["a", "b"]);
    expect(all[1].status).toBe("SUCCEEDED");
    expect(all[1].output).toEqual({ ok: 1 });
  });

  it("appends audit events in order", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    await store.appendAudit({ runId: run.id, type: "RUN_CREATED", payload: {} });
    await store.appendAudit({
      runId: run.id,
      type: "STEP_STARTED",
      payload: { stepId: "a" },
    });
    const events = await store.listAudit(run.id);
    expect(events.map((e) => e.type)).toEqual(["RUN_CREATED", "STEP_STARTED"]);
  });

  it("counts LLM calls per run", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    expect(await store.countLlmCalls(run.id)).toBe(0);
    await store.recordLlmCall({
      runId: run.id,
      provider: "mock",
      model: "mock-1",
      prompt: "p",
      response: "r",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 5,
      status: "SUCCESS",
      error: null,
    });
    expect(await store.countLlmCalls(run.id)).toBe(1);
  });

  it("inserts an external action once and reports duplicates without overwriting", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });

    const first = await store.insertExternalAction({
      idempotencyKey: "key-1",
      runId: run.id,
      stepId: "post",
      request: { amount: 10 },
      response: { ref: "EXT-1" },
    });
    expect(first.created).toBe(true);

    const second = await store.insertExternalAction({
      idempotencyKey: "key-1",
      runId: run.id,
      stepId: "post",
      request: { amount: 999 },
      response: { ref: "EXT-2" },
    });
    expect(second.created).toBe(false);
    expect(second.record.response).toEqual({ ref: "EXT-1" });
  });

  it("updates only the patched fields on a run and advances updatedAt", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    const before = run.updatedAt.getTime();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await store.updateRun(run.id, { status: "RUNNING" });

    expect(updated.status).toBe("RUNNING");
    expect(updated.cursor).toBeNull();
    expect(updated.error).toBeNull();
    expect(updated.updatedAt.getTime()).toBeGreaterThan(before);

    const cursored = await store.updateRun(run.id, { cursor: "step-2" });
    expect(cursored.status).toBe("RUNNING");
    expect(cursored.cursor).toBe("step-2");

    await expect(
      store.updateRun("missing", { status: "FAILED" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("round-trips an approval decision and rejects a second decision for the same step", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });
    const step = await store.createStepExecution({
      runId: run.id,
      stepId: "approve-me",
      stepType: "human_approval",
      status: "AWAITING_APPROVAL",
      attempt: 1,
      retrySafe: false,
      input: {},
    });

    expect(await store.getApproval(step.id)).toBeNull();

    const approval = await store.createApproval(step.id, "APPROVED", null);
    expect(approval.decision).toBe("APPROVED");
    expect(approval.reason).toBeNull();
    expect(approval.stepExecutionId).toBe(step.id);

    const fetched = await store.getApproval(step.id);
    expect(fetched).toEqual(approval);

    await expect(
      store.createApproval(step.id, "REJECTED", "changed my mind"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("lists LLM calls for a run in order, empty when none recorded", async () => {
    const store = createMemoryStore({ versions: [version] });
    const run = await store.createRun({ workflowVersionId: "wv1", input: {} });

    expect(await store.listLlmCalls(run.id)).toEqual([]);

    const first = await store.recordLlmCall({
      runId: run.id,
      provider: "mock",
      model: "mock-1",
      prompt: "p1",
      response: "r1",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 5,
      status: "SUCCESS",
      error: null,
    });
    const second = await store.recordLlmCall({
      runId: run.id,
      provider: "mock",
      model: "mock-1",
      prompt: "p2",
      response: "r2",
      inputTokens: 2,
      outputTokens: 2,
      latencyMs: 6,
      status: "SUCCESS",
      error: null,
    });

    const calls = await store.listLlmCalls(run.id);
    expect(calls.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(calls.map((c) => c.prompt)).toEqual(["p1", "p2"]);
  });
});

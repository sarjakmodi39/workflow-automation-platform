import { describe, expect, it } from "vitest";
import { evaluateCondition, resolvePath } from "@/lib/engine/expression";
import type { ExecutionContext } from "@/lib/engine/context";

const ctx: ExecutionContext = {
  input: { invoiceId: "INV-1" },
  steps: {
    extract: { amount: 5200, vendor: "Acme", tags: ["urgent", "eu"] },
    classify: { label: "high_risk" },
  },
};

describe("resolvePath", () => {
  it("resolves a run input path", () => {
    expect(resolvePath("$.input.invoiceId", ctx)).toBe("INV-1");
  });

  it("resolves a step output path", () => {
    expect(resolvePath("$.steps.extract.amount", ctx)).toBe(5200);
  });

  it("returns undefined for a missing path rather than throwing", () => {
    expect(resolvePath("$.steps.nope.field", ctx)).toBeUndefined();
  });

  it("treats a non-$ string as a literal", () => {
    expect(resolvePath("plain", ctx)).toBe("plain");
  });
});

describe("evaluateCondition", () => {
  it("evaluates a greater-than comparator", () => {
    const r = evaluateCondition(
      { left: "$.steps.extract.amount", op: "gt", right: 5000 },
      ctx,
    );
    expect(r.result).toBe(true);
    expect(r.resolvedInputs["$.steps.extract.amount"]).toBe(5200);
  });

  it("produces a human-readable description of the decision", () => {
    const r = evaluateCondition(
      { left: "$.steps.extract.amount", op: "gt", right: 5000 },
      ctx,
    );
    expect(r.description).toBe("amount (5200) > 5000");
  });

  it("evaluates equality against a step output", () => {
    const r = evaluateCondition(
      { left: "$.steps.classify.label", op: "eq", right: "high_risk" },
      ctx,
    );
    expect(r.result).toBe(true);
  });

  it("evaluates `in` against an array literal", () => {
    const r = evaluateCondition(
      { left: "$.steps.classify.label", op: "in", right: ["high_risk", "critical"] },
      ctx,
    );
    expect(r.result).toBe(true);
  });

  it("evaluates `contains` against a resolved array", () => {
    const r = evaluateCondition(
      { left: "$.steps.extract.tags", op: "contains", right: "urgent" },
      ctx,
    );
    expect(r.result).toBe(true);
  });

  it("evaluates allOf as logical AND", () => {
    const r = evaluateCondition(
      {
        allOf: [
          { left: "$.steps.extract.amount", op: "gt", right: 5000 },
          { left: "$.steps.classify.label", op: "eq", right: "high_risk" },
        ],
      },
      ctx,
    );
    expect(r.result).toBe(true);
    expect(r.description).toContain(" AND ");
  });

  it("evaluates anyOf as logical OR", () => {
    const r = evaluateCondition(
      {
        anyOf: [
          { left: "$.steps.extract.amount", op: "gt", right: 99999 },
          { left: "$.steps.classify.label", op: "eq", right: "high_risk" },
        ],
      },
      ctx,
    );
    expect(r.result).toBe(true);
  });

  it("returns false when a comparator references a missing path", () => {
    const r = evaluateCondition(
      { left: "$.steps.missing.amount", op: "gt", right: 1 },
      ctx,
    );
    expect(r.result).toBe(false);
  });
});

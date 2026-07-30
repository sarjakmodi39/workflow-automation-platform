import { describe, expect, it } from "vitest";
import { diffVersions } from "@/lib/diff";
import type { StepDefinition } from "@/lib/types";

/* Comparing versions is a graded requirement, and the failure mode is a diff that looks
 * plausible while being wrong — so these assert the cases that mislead, not the easy ones. */

function step(id: string, over: Partial<StepDefinition> = {}): StepDefinition {
  return {
    id,
    type: "structured_input",
    name: id,
    config: {},
    ...over,
  } as StepDefinition;
}

describe("diffVersions", () => {
  it("reports identical definitions as identical", () => {
    const a = [step("one"), step("two")];
    const result = diffVersions(a, [step("one"), step("two")]);
    expect(result.identical).toBe(true);
    expect(result.steps.every((s) => s.kind === "unchanged")).toBe(true);
  });

  it("names the exact field that changed, not just the step", () => {
    const before = [step("gate", { type: "document_retrieval", config: { query: "a", topK: 3 } })];
    const after = [step("gate", { type: "document_retrieval", config: { query: "a", topK: 5 } })];

    const [diff] = diffVersions(before, after).steps;
    expect(diff.kind).toBe("changed");
    expect(diff.fields).toEqual([{ field: "config.topK", before: 3, after: 5 }]);
  });

  it("matches steps by id, so an insertion does not rewrite everything after it", () => {
    const before = [step("a"), step("b")];
    const after = [step("a"), step("inserted"), step("b")];

    const result = diffVersions(before, after);
    const byId = new Map(result.steps.map((s) => [s.stepId, s]));

    expect(byId.get("inserted")?.kind).toBe("added");
    // The whole point: `b` moved but did not change. Positional matching would have
    // compared `b` against `inserted` and called it a rewrite.
    expect(byId.get("b")?.kind).toBe("unchanged");
    expect(byId.get("b")?.movedFrom).toBe(2);
    expect(byId.get("b")?.movedTo).toBe(3);
  });

  it("reports removals even though they are absent from the newer version", () => {
    const result = diffVersions([step("a"), step("gone")], [step("a")]);
    expect(result.steps.find((s) => s.stepId === "gone")?.kind).toBe("removed");
    expect(result.identical).toBe(false);
  });

  it("does not report key reordering as a change", () => {
    const before = [step("a", { config: { x: 1, y: 2 } })];
    const after = [step("a", { config: { y: 2, x: 1 } })];
    // A definition round-tripped through JSON can come back with keys in another order;
    // reporting that as an edit would make every diff untrustworthy.
    expect(diffVersions(before, after).identical).toBe(true);
  });

  it("detects a changed condition threshold, which is what the two seeded versions differ by", () => {
    const before = [
      step("check", {
        type: "deterministic_condition",
        condition: { left: "$.steps.x.amount", op: "gt", right: 5000 },
      }),
    ];
    const after = [
      step("check", {
        type: "deterministic_condition",
        condition: { left: "$.steps.x.amount", op: "gt", right: 1000 },
      }),
    ];
    const [diff] = diffVersions(before, after).steps;
    expect(diff.fields).toEqual([
      { field: "condition.right", before: 5000, after: 1000 },
    ]);
  });

  it("tracks permission grants in both directions", () => {
    const result = diffVersions(
      [step("a")],
      [step("a")],
      ["tool:llm", "action:pay"],
      ["tool:llm", "tool:document_search"],
    );
    expect(result.permissionsAdded).toEqual(["tool:document_search"]);
    expect(result.permissionsRemoved).toEqual(["action:pay"]);
    // A grant change alone must break identity: widening what a version may do is
    // exactly the kind of edit a reviewer is comparing versions to catch.
    expect(result.identical).toBe(false);
  });

  it("notices a removed optional field rather than treating absence as no change", () => {
    const before = [step("c", { type: "deterministic_condition", onFalse: "end" })];
    const after = [step("c", { type: "deterministic_condition" })];
    const [diff] = diffVersions(before, after).steps;
    expect(diff.kind).toBe("changed");
    expect(diff.fields.map((f) => f.field)).toContain("onFalse");
  });
});

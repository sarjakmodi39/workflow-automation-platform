import { describe, expect, it } from "vitest";
import { validateWorkflow } from "@/lib/engine/validator";
import type { WorkflowDefinition } from "@/lib/types";

const GRANTS = ["tool:llm", "tool:document_search", "action:post_invoice"];

function validDefinition(): WorkflowDefinition {
  return {
    steps: [
      {
        id: "intake",
        type: "structured_input",
        name: "Intake",
        config: { fields: [{ name: "invoiceId", kind: "string" }] },
      },
      {
        id: "extract",
        type: "ai_extraction",
        name: "Extract",
        config: {
          source: "$.steps.intake.invoiceId",
          fields: [{ name: "amount", kind: "number" }],
        },
      },
      {
        id: "report",
        type: "final_report",
        name: "Report",
        config: { title: "Result", summarize: false },
      },
    ],
  };
}

describe("validateWorkflow", () => {
  it("accepts a well-formed definition", () => {
    expect(validateWorkflow(validDefinition(), GRANTS)).toEqual([]);
  });

  it("rejects an empty workflow", () => {
    const issues = validateWorkflow({ steps: [] }, GRANTS);
    expect(issues.some((i) => i.code === "EMPTY_WORKFLOW")).toBe(true);
  });

  it("rejects duplicate step ids", () => {
    const def = validDefinition();
    def.steps[1].id = "intake";
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "DUPLICATE_STEP_ID")).toBe(true);
  });

  it("rejects an unknown step type", () => {
    const def = validDefinition();
    (def.steps[1] as { type: string }).type = "telepathy";
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "UNKNOWN_STEP_TYPE")).toBe(true);
  });

  it("rejects a step whose config is invalid for its type", () => {
    const def = validDefinition();
    def.steps[1].config = { source: "$.input", fields: [] };
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "INVALID_STEP_CONFIG")).toBe(true);
  });

  it("rejects a step requesting an ungranted permission", () => {
    const issues = validateWorkflow(validDefinition(), ["tool:document_search"]);
    const denied = issues.find((i) => i.code === "PERMISSION_NOT_GRANTED");
    expect(denied).toBeDefined();
    expect(denied?.message).toContain("tool:llm");
  });

  it("rejects a source path referencing a step that does not exist", () => {
    const def = validDefinition();
    def.steps[1].config = {
      source: "$.steps.ghost.value",
      fields: [{ name: "amount", kind: "number" }],
    };
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "UNKNOWN_SOURCE_STEP")).toBe(true);
  });

  it("rejects a source path referencing a later step", () => {
    const def = validDefinition();
    def.steps[1].config = {
      source: "$.steps.report.title",
      fields: [{ name: "amount", kind: "number" }],
    };
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "FORWARD_SOURCE_REFERENCE")).toBe(true);
  });

  it("rejects a branch target that does not exist", () => {
    const def = validDefinition();
    def.steps.splice(2, 0, {
      id: "check",
      type: "deterministic_condition",
      name: "Check",
      config: {},
      condition: { left: "$.steps.extract.amount", op: "gt", right: 100 },
      onTrue: "nowhere",
      onFalse: "report",
    });
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "UNKNOWN_BRANCH_TARGET")).toBe(true);
  });

  it("rejects a backward branch jump so termination is guaranteed", () => {
    const def = validDefinition();
    def.steps.splice(2, 0, {
      id: "check",
      type: "deterministic_condition",
      name: "Check",
      config: {},
      condition: { left: "$.steps.extract.amount", op: "gt", right: 100 },
      onTrue: "intake",
      onFalse: "report",
    });
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "BACKWARD_BRANCH")).toBe(true);
  });

  it("accepts a forward branch jump and the literal target `end`", () => {
    const def = validDefinition();
    def.steps.splice(2, 0, {
      id: "check",
      type: "deterministic_condition",
      name: "Check",
      config: {},
      condition: { left: "$.steps.extract.amount", op: "gt", right: 100 },
      onTrue: "report",
      onFalse: "end",
    });
    expect(validateWorkflow(def, GRANTS)).toEqual([]);
  });

  it("rejects a condition step with no condition defined", () => {
    const def = validDefinition();
    def.steps.splice(2, 0, {
      id: "check",
      type: "deterministic_condition",
      name: "Check",
      config: {},
      onTrue: "report",
      onFalse: "end",
    });
    const issues = validateWorkflow(def, GRANTS);
    expect(issues.some((i) => i.code === "MISSING_CONDITION")).toBe(true);
  });
});

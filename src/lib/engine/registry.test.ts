import { describe, expect, it } from "vitest";
import { REGISTRY, getStepSpec } from "@/lib/engine/registry";
import { ValidationError } from "@/lib/errors";

describe("step registry", () => {
  it("defines exactly the eight supported step types", () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(
      [
        "ai_classification",
        "ai_extraction",
        "deterministic_condition",
        "document_retrieval",
        "final_report",
        "human_approval",
        "mock_external_action",
        "structured_input",
      ].sort(),
    );
  });

  it("marks the external action as unsafe to retry", () => {
    expect(REGISTRY.mock_external_action.retrySafe).toBe(false);
  });

  it("marks read-only steps as safe to retry", () => {
    expect(REGISTRY.document_retrieval.retrySafe).toBe(true);
    expect(REGISTRY.ai_extraction.retrySafe).toBe(true);
    expect(REGISTRY.ai_classification.retrySafe).toBe(true);
    expect(REGISTRY.deterministic_condition.retrySafe).toBe(true);
  });

  it("requires the llm tool permission for AI steps", () => {
    expect(REGISTRY.ai_extraction.requiredPermissions({})).toContain("tool:llm");
    expect(REGISTRY.ai_classification.requiredPermissions({})).toContain("tool:llm");
  });

  it("requires the document search permission for retrieval", () => {
    expect(REGISTRY.document_retrieval.requiredPermissions({})).toContain(
      "tool:document_search",
    );
  });

  it("derives the external action permission from its configured action name", () => {
    expect(
      REGISTRY.mock_external_action.requiredPermissions({ action: "post_invoice" }),
    ).toEqual(["action:post_invoice"]);
  });

  it("requires the llm permission for the report only when summarising", () => {
    expect(REGISTRY.final_report.requiredPermissions({ summarize: false })).toEqual([]);
    expect(REGISTRY.final_report.requiredPermissions({ summarize: true })).toEqual([
      "tool:llm",
    ]);
  });

  it("derives the extraction output shape from its configured fields", () => {
    const shape = REGISTRY.ai_extraction.outputSchema({
      fields: [
        { name: "amount", kind: "number" },
        { name: "vendor", kind: "string" },
      ],
    });
    expect(shape).toEqual({ amount: "number", vendor: "string" });
  });

  it("reports a config error when extraction declares no fields", () => {
    const errors = REGISTRY.ai_extraction.validateConfig({ fields: [] });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("at least one field");
  });

  it("reports a config error when classification declares fewer than two labels", () => {
    const errors = REGISTRY.ai_classification.validateConfig({ labels: ["only"] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a valid classification config", () => {
    expect(
      REGISTRY.ai_classification.validateConfig({
        source: "$.steps.retrieve.documents",
        labels: ["low", "high"],
      }),
    ).toEqual([]);
  });

  it("reports a config error when classification has no source path", () => {
    const errors = REGISTRY.ai_classification.validateConfig({
      labels: ["low", "high"],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("throws a ValidationError for an unknown step type", () => {
    expect(() => getStepSpec("nonexistent")).toThrow(ValidationError);
  });

  it("includes a summary field in the report output shape only when summarising", () => {
    expect(
      REGISTRY.final_report.outputSchema({ title: "X", summarize: true }),
    ).toEqual({ title: "string", sections: "array", summary: "string" });

    const withoutSummary = REGISTRY.final_report.outputSchema({
      title: "X",
      summarize: false,
    });
    expect(withoutSummary).toEqual({ title: "string", sections: "array" });
    expect(withoutSummary).not.toHaveProperty("summary");

    const summarizeOmitted = REGISTRY.final_report.outputSchema({ title: "X" });
    expect(summarizeOmitted).toEqual({ title: "string", sections: "array" });
    expect(summarizeOmitted).not.toHaveProperty("summary");
  });

  it("derives the structured input output shape from its configured fields", () => {
    const shape = REGISTRY.structured_input.outputSchema({
      fields: [
        { name: "amount", kind: "number" },
        { name: "vendor", kind: "string" },
      ],
    });
    expect(shape).toEqual({ amount: "number", vendor: "string" });
  });

  it("returns an empty structured input output shape when fields are absent or not an array", () => {
    expect(REGISTRY.structured_input.outputSchema({})).toEqual({});
    expect(
      REGISTRY.structured_input.outputSchema({ fields: "not-an-array" }),
    ).toEqual({});
  });

  it("reports a config error when structured input declares no fields", () => {
    expect(REGISTRY.structured_input.validateConfig({ fields: [] })).toEqual([
      "Structured input must declare at least one field.",
    ]);
  });

  it("reports a config error when a structured input field has no name", () => {
    expect(
      REGISTRY.structured_input.validateConfig({
        fields: [{ name: "", kind: "string" }],
      }),
    ).toEqual(["Every input field needs a name."]);
  });

  it("reports a config error when document retrieval has no query", () => {
    expect(REGISTRY.document_retrieval.validateConfig({})).toEqual([
      "Document retrieval needs a query.",
    ]);
    expect(REGISTRY.document_retrieval.validateConfig({ query: "" })).toEqual([
      "Document retrieval needs a query.",
    ]);
  });

  it("reports a config error when document retrieval topK is not positive", () => {
    expect(
      REGISTRY.document_retrieval.validateConfig({ query: "invoices", topK: 0 }),
    ).toEqual(["topK must be a positive number."]);
  });

  it("accepts a valid document retrieval config", () => {
    expect(
      REGISTRY.document_retrieval.validateConfig({ query: "invoices", topK: 5 }),
    ).toEqual([]);
  });

  it("reports a config error when human approval has no prompt", () => {
    expect(REGISTRY.human_approval.validateConfig({})).toEqual([
      "Human approval needs a prompt explaining what is being approved.",
    ]);
  });

  it("accepts a valid human approval config", () => {
    expect(
      REGISTRY.human_approval.validateConfig({ prompt: "Approve this refund?" }),
    ).toEqual([]);
  });

  it("reports a config error when the external action has no action name", () => {
    expect(REGISTRY.mock_external_action.validateConfig({})).toEqual([
      "External action needs an action name.",
    ]);
  });

  it("accepts a valid external action config", () => {
    expect(
      REGISTRY.mock_external_action.validateConfig({ action: "post_invoice" }),
    ).toEqual([]);
  });
});

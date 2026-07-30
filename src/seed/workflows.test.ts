import { describe, expect, it } from "vitest";
import { SEED_WORKFLOWS } from "@/seed/workflows";
import { validateWorkflow } from "@/lib/engine/validator";
import type { StepDefinition } from "@/lib/types";

/* A broken fixture would surface only against a live database. `validateWorkflow` is what the
 * create route runs, so this asserts the seed cannot write what the API would refuse. */

interface FieldSpec {
  name: string;
  kind: string;
}

function structuredInputFields(steps: StepDefinition[]): FieldSpec[] {
  const step = steps.find((s) => s.type === "structured_input");
  if (!step) return [];
  return Array.isArray(step.config.fields) ? (step.config.fields as FieldSpec[]) : [];
}

/** Mirrors the handler's `kindMatches` for the kinds the fixtures actually use. */
function kindMatches(value: unknown, kind: string): boolean {
  if (kind === "string") return typeof value === "string";
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (kind === "boolean") return typeof value === "boolean";
  return true;
}

describe("seed workflows", () => {
  it("seeds at least one workflow that needs no human to reach a terminal state", () => {
    // A reviewer should be able to press Run once and watch it complete; if every
    // fixture halted at a gate, nothing would prove the engine finishes.
    const unattended = SEED_WORKFLOWS.filter((w) =>
      w.versions.every((v) =>
        v.definition.steps.every((s) => s.type !== "human_approval"),
      ),
    );
    expect(unattended.length).toBeGreaterThan(0);
  });

  it("uses ids that are unique across workflows and versions", () => {
    const ids = SEED_WORKFLOWS.flatMap((w) => [w.id, ...w.versions.map((v) => v.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("numbers versions from 1 with no gaps, because @@unique([workflowId, version]) is the key", () => {
    for (const workflow of SEED_WORKFLOWS) {
      const numbers = workflow.versions.map((v) => v.version);
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
  });

  describe.each(SEED_WORKFLOWS)("$name", (workflow) => {
    it.each(workflow.versions)("version $version validates as declared", (version) => {
      const issues = validateWorkflow(version.definition, version.grantedPermissions);

      if (!version.expectInvalid) {
        // Report the messages, not just the count: a bare `toHaveLength(0)`
        // failure tells you nothing about which fixture drifted.
        expect(issues.map((i) => `${i.stepId}: ${i.message}`)).toEqual([]);
        return;
      }

      // Invalid *for the stated reason*: one that broke some other way would keep
      // passing while no longer demonstrating anything.
      expect(issues.length).toBeGreaterThan(0);
      expect(new Set(issues.map((i) => i.code))).toEqual(
        new Set([version.expectInvalid]),
      );
    });

    it("has a sample input satisfying its structured_input step", () => {
      const fields = structuredInputFields(workflow.versions[0].definition.steps);
      expect(fields.length).toBeGreaterThan(0);

      for (const field of fields) {
        const value = workflow.sampleInput[field.name];
        // The handler rejects undefined and null before it checks the kind, so
        // a sample missing a field would fail the run on its very first step.
        expect(value, `sampleInput.${field.name} is missing`).not.toBeUndefined();
        expect(value, `sampleInput.${field.name} is null`).not.toBeNull();
        expect(
          kindMatches(value, field.kind),
          `sampleInput.${field.name} should be a ${field.kind}`,
        ).toBe(true);
      }
    });
  });

  it("gives the invoice workflow two versions that actually differ", () => {
    const invoice = SEED_WORKFLOWS.find((w) => w.id === "seed_invoice_approval");
    expect(invoice?.versions).toHaveLength(2);
    // Version pinning is only demonstrable if the versions decide differently.
    // Serialising is the bluntest way to catch a v2 that was copied verbatim.
    expect(JSON.stringify(invoice?.versions[0].definition)).not.toBe(
      JSON.stringify(invoice?.versions[1].definition),
    );
  });

  it("keeps the permission demo under-granted, since that omission is the fixture", () => {
    const demo = SEED_WORKFLOWS.find((w) => w.id === "seed_permission_demo");
    const version = demo?.versions[0];
    expect(version?.grantedPermissions).not.toContain("action:issue_payment");
    expect(
      version?.definition.steps.some((s) => s.type === "mock_external_action"),
    ).toBe(true);
  });
});

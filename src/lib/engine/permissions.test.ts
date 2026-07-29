import { describe, expect, it } from "vitest";
import { assertPermitted, missingPermissions } from "@/lib/engine/permissions";
import { PermissionDeniedError } from "@/lib/errors";
import type { StepDefinition } from "@/lib/types";

const aiStep: StepDefinition = {
  id: "extract",
  type: "ai_extraction",
  name: "Extract fields",
  config: { source: "$.input", fields: [{ name: "amount", kind: "number" }] },
};

const actionStep: StepDefinition = {
  id: "post",
  type: "mock_external_action",
  name: "Post to accounting",
  config: { action: "post_invoice" },
};

describe("permissions", () => {
  it("reports nothing missing when the grant covers the step", () => {
    expect(missingPermissions(aiStep, ["tool:llm"])).toEqual([]);
  });

  it("reports the missing permission when the grant is absent", () => {
    expect(missingPermissions(aiStep, [])).toEqual(["tool:llm"]);
  });

  it("matches action permissions by their configured action name", () => {
    expect(missingPermissions(actionStep, ["action:post_invoice"])).toEqual([]);
    expect(missingPermissions(actionStep, ["action:something_else"])).toEqual([
      "action:post_invoice",
    ]);
  });

  it("throws PermissionDeniedError naming the missing permission", () => {
    expect(() => assertPermitted(aiStep, [])).toThrow(PermissionDeniedError);
    try {
      assertPermitted(aiStep, []);
    } catch (e) {
      expect((e as PermissionDeniedError).message).toContain("tool:llm");
    }
  });

  it("does not throw when every required permission is granted", () => {
    expect(() => assertPermitted(actionStep, ["action:post_invoice"])).not.toThrow();
  });
});

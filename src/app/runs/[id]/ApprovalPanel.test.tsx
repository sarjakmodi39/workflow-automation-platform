import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalPanel, pressReject } from "@/app/runs/[id]/ApprovalPanel";
import type { StepExecutionRow } from "@/lib/client-api";

/* What the gate shows before a person decides is a correctness property, not styling: the
 * reviewer sees what they approve, records why, and cannot reject in one click. */

function visibleText(element: React.ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, " ")
    .replace(/&apos;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function gate(overrides: Partial<StepExecutionRow> = {}): StepExecutionRow {
  return {
    id: "se_1",
    runId: "r1",
    stepId: "approve_payment",
    stepType: "human_approval",
    status: "AWAITING_APPROVAL",
    attempt: 1,
    retrySafe: true,
    input: { amount: 7400, vendor: "Globex Industrial" },
    output: null,
    explanation: { prompt: "Approve a 7,400 USD payment to Globex Industrial?" },
    error: null,
    startedAt: "2026-07-30T10:00:00.000Z",
    finishedAt: null,
    approval: null,
    ...overrides,
  };
}

/* The rule itself, apart from the markup: asserting on rendered text passed a mutation that
 * wired Reject straight to submit. Still uncovered is the button-to-rule wiring. */
describe("pressReject", () => {
  it("asks for confirmation on the first press", () => {
    expect(pressReject("deciding")).toBe("confirm");
  });

  it("submits only once rejection has already been confirmed", () => {
    expect(pressReject("confirming")).toBe("submit");
  });

  it("never submits from the initial stage", () => {
    expect(pressReject("deciding")).not.toBe("submit");
  });
});

describe("ApprovalPanel", () => {
  it("shows what is being approved before showing the controls", () => {
    const text = visibleText(
      <ApprovalPanel step={gate()} busy={false} onDecide={() => {}} />,
    );
    expect(text).toContain("Approve a 7,400 USD payment to Globex Industrial?");
    // The evidence the gate received, so a decision is not made blind.
    expect(text).toContain("Globex Industrial");
    expect(text).toContain("7400");
  });

  it("states that the run is halted and that nothing after it has run", () => {
    const text = visibleText(
      <ApprovalPanel step={gate()} busy={false} onDecide={() => {}} />,
    );
    expect(text).toContain("Nothing after it has executed");
  });

  it("offers a reason field, because the decision is written to the audit trail", () => {
    const text = visibleText(
      <ApprovalPanel step={gate()} busy={false} onDecide={() => {}} />,
    );
    expect(text).toContain("Reason (recorded in the audit trail)");
  });

  it("does not put the rejection controls on screen until they are asked for", () => {
    const text = visibleText(
      <ApprovalPanel step={gate()} busy={false} onDecide={() => {}} />,
    );
    expect(text).toContain("Approve and continue");
    expect(text).toContain("Reject");
    // The button that submits a rejection is not in the markup at all, so there
    // is nothing to mis-click.
    expect(text).not.toContain("Yes, reject and stop the run");
    expect(text).not.toContain("Rejecting is permanent");
  });

  it("still renders when the gate declares no prompt", () => {
    const text = visibleText(
      <ApprovalPanel step={gate({ explanation: null })} busy={false} onDecide={() => {}} />,
    );
    // No prompt is not an error state, and it must not produce a blank panel.
    expect(text).toContain("This gate declares no prompt of its own");
    expect(text).toContain("Approve and continue");
  });

  it("escapes markup in a prompt, which is model-influenced text", () => {
    const markup = renderToStaticMarkup(
      <ApprovalPanel
        step={gate({ explanation: { prompt: "<script>alert(1)</script>" } })}
        busy={false}
        onDecide={() => {}}
      />,
    );
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("disables both decisions while one is being recorded", () => {
    const markup = renderToStaticMarkup(
      <ApprovalPanel step={gate()} busy onDecide={() => {}} />,
    );
    // Two buttons, both disabled: a double-click must not submit twice.
    expect(markup.match(/disabled=""/g)?.length).toBe(2);
    expect(visibleText(<ApprovalPanel step={gate()} busy onDecide={() => {}} />)).toContain(
      "Recording decision…",
    );
  });
});

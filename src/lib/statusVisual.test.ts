import { describe, expect, it } from "vitest";
import { statusVisual } from "@/lib/statusVisual";

describe("statusVisual", () => {
  it("labels multi-word statuses in sentence case", () => {
    expect(statusVisual("AWAITING_APPROVAL").label).toBe("Awaiting approval");
  });

  it("gives a run and a step success the same appearance", () => {
    expect(statusVisual("COMPLETED").className).toBe(
      statusVisual("SUCCEEDED").className,
    );
  });

  it("distinguishes failure from success", () => {
    expect(statusVisual("FAILED").className).not.toBe(
      statusVisual("COMPLETED").className,
    );
  });

  it("falls back to a neutral badge for an unknown status", () => {
    const visual = statusVisual("SOMETHING_NEW");
    expect(visual.label).toBe("Something new");
    expect(visual.className).toBe(statusVisual("PENDING").className);
  });

  it("does not render an empty badge for an empty status", () => {
    expect(statusVisual("").label).toBe("Unknown");
  });
});

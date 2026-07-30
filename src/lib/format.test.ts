import { describe, expect, it } from "vitest";
import { formatDuration, formatTimeOfDay, formatTimestamp } from "@/lib/format";

/*
 * These render values that come out of the database, where the interesting cases
 * are the absent and the malformed ones: a step that has started but not
 * finished has no `finishedAt`, and a run reconstructed from rows written by two
 * application instances can carry timestamps that disagree.
 */

describe("formatDuration", () => {
  it("reports sub-second durations in milliseconds", () => {
    expect(
      formatDuration("2026-07-30T10:00:00.000Z", "2026-07-30T10:00:00.250Z"),
    ).toBe("250 ms");
  });

  it("reports durations of a second or more in seconds", () => {
    expect(
      formatDuration("2026-07-30T10:00:00.000Z", "2026-07-30T10:00:02.500Z"),
    ).toBe("2.5 s");
  });

  it("has no duration for a step that has not finished", () => {
    expect(formatDuration("2026-07-30T10:00:00.000Z", null)).toBeNull();
  });

  it("has no duration for a step that has not started", () => {
    expect(formatDuration(null, "2026-07-30T10:00:00.000Z")).toBeNull();
  });

  it("refuses to render a negative duration from skewed clocks", () => {
    // Two instances stamping `startedAt` and `finishedAt` can disagree. A step
    // shown as taking -40 ms reads as a bug in the engine rather than in the
    // clocks, so nothing is shown instead.
    expect(
      formatDuration("2026-07-30T10:00:00.100Z", "2026-07-30T10:00:00.060Z"),
    ).toBeNull();
  });

  it("has no duration for an unparseable timestamp", () => {
    expect(formatDuration("not a date", "2026-07-30T10:00:00.000Z")).toBeNull();
  });
});

describe("formatTimeOfDay", () => {
  it("includes seconds, so events in the same minute stay distinguishable", () => {
    const a = formatTimeOfDay("2026-07-30T10:00:01.000Z");
    const b = formatTimeOfDay("2026-07-30T10:00:02.000Z");
    expect(a).not.toBe(b);
  });

  it("renders a dash rather than Invalid Date", () => {
    expect(formatTimeOfDay("not a date")).toBe("—");
    expect(formatTimeOfDay(null)).toBe("—");
    expect(formatTimeOfDay(undefined)).toBe("—");
  });
});

describe("formatTimestamp", () => {
  it("renders a dash rather than Invalid Date", () => {
    expect(formatTimestamp("not a date")).toBe("—");
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp("")).toBe("—");
  });

  it("renders a real timestamp as something other than a dash", () => {
    expect(formatTimestamp("2026-07-30T10:00:00.000Z")).not.toBe("—");
  });
});

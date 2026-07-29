import { describe, expect, it } from "vitest";
import { toolchainReady } from "@/lib/smoke";

describe("toolchain", () => {
  it("resolves the @/ path alias and runs tests", () => {
    expect(toolchainReady()).toBe(true);
  });
});

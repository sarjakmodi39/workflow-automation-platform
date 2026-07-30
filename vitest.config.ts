import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  /* tsconfig sets `jsx: "preserve"` for Next, which Vitest cannot parse, so the runtime is
   * named here — configuration only, letting components render to a string with no DOM. */
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});

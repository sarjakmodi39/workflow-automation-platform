import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  /*
   * `tsconfig.json` sets `jsx: "preserve"`, which is right for Next — Next's own
   * compiler does the transform. Vitest does not use that setting and cannot
   * parse JSX without being told the runtime, so it is set here.
   *
   * This is configuration, not a new dependency. React and `react-dom/server`
   * are already installed, so a component can be rendered to a string and
   * asserted on with no DOM, no test renderer and no browser — which is what
   * lets the UI's failure states be verified rather than just described.
   */
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});

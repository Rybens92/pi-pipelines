import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      include: ["extensions/**/*.ts"],
      reporter: ["text", "lcov", "html"],
      thresholds: {
        statements: 85,
        branches: 79,  // pipeline-runner has deep fallback branches (parseReviewOutputs, expand) intentionally lower
        functions: 85,
        lines: 85,
        perFile: true,
        // index.ts, subagent-bridge.ts, types.ts are excluded (Pi runtime dep).
        "extensions/config-loader.ts": {
          branches: 95,
        },
      },
      // Modules that depend on Pi runtime (event bus, TUI, extension registry)
      // cannot be fully tested without a running Pi instance.
      // These thresholds reflect the testable core logic coverage.
      exclude: [
        "extensions/index.ts",
        "extensions/types.ts",
        "extensions/subagent-bridge.ts",
      ],
    },
  },
});

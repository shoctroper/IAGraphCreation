import { defineConfig } from "vitest/config";

// The pinned acceptance suite runs under its OWN config. The default
// vitest.config.mjs restricts `include` to tests/unit so the project gate stays
// green while the acceptance progresses - which silently made
// `vitest run tests/acceptance` match nothing at all, and the evaluator report
// a blameless 0/62. Separate config, no shared include, no silence.
export default defineConfig({
  test: {
    include: ["tests/acceptance/**/*.test.mjs"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});

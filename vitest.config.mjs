import { defineConfig } from "vitest/config";

// The pinned acceptance suite lives in tests/acceptance and is deliberately
// EXCLUDED from the default run. It is the Goal's outcome, measured by
// tests/acceptance/evaluate.mjs, not a gate that must be green to make
// progress. `npm test` runs the project's own suite; `npm run test:acceptance`
// runs the pinned cases.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.mjs"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

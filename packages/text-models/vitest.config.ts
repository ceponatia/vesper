import { defineConfig } from "vitest/config";

/**
 * The package's own Vitest project (`pnpm test` here; the root's recursive run
 * reaches it without naming this package).
 *
 * No alias and no setup file, both deliberately: a test in here proves
 * something about how a model is asked, not about how Vesper's test harness is
 * wired. The package has no workspace dependency to resolve, so a test that
 * needed one would be a boundary change, not a config change.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

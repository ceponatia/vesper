import { defineConfig } from "vitest/config";

/**
 * The package's own Vitest project (`pnpm test` here; the root's recursive run
 * reaches it without naming this package).
 *
 * No alias and no setup file, both deliberately: a test in here proves
 * something about how a model family behaves, not about how Vesper's test
 * harness is wired. `@vesper/image-core` resolves through the installed
 * workspace link, never through a source alias — which is also what makes a
 * broken `exports` map fail here instead of being papered over by tooling.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

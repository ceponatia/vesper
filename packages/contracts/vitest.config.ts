import { defineConfig } from "vitest/config";

/**
 * The package's own Vitest project (`pnpm test` here; the root's recursive run
 * reaches it without naming this package).
 *
 * No alias and no setup file, both deliberately: a test here must prove
 * something about the diagnostic contract and `parseOr`, not about Vesper's
 * configuration, and workspace dependencies resolve through the installed
 * workspace link exactly as a consumer's would.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

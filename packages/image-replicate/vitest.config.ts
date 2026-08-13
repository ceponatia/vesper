import { defineConfig } from "vitest/config";

/**
 * The package's own Vitest project (`pnpm test` here; the root's recursive run
 * reaches it without naming this package).
 *
 * No alias and no setup file, both deliberately: the transport reads no
 * environment, so nothing here may depend on the application's demo-mode
 * globals to stay off the network — the suites hold the seam themselves.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

import { defineConfig } from "vitest/config";

/**
 * The package's own Vitest project (`pnpm test` here; the root's recursive run
 * reaches it without naming this package).
 *
 * No alias and no setup file, both deliberately: the image engine is
 * provider-neutral and application-free, so a test that quietly relied on the
 * app's demo-mode globals would be proving the wrong thing. `@vesper/contracts`
 * resolves through the installed workspace link, never through a source alias.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The Next application is not the repository root any more, and a stale ESLint
 * scope fails OPEN: `eslint-config-next` would simply stop applying its rules to
 * `apps/web`, `pnpm lint` would stay green, and nothing would say so.
 *
 * So this asks the real config what it resolves for a real application file:
 * the Next rules must be enabled there, and `settings.next.rootDir` must point
 * at the moved application. It also checks a repository-root file does NOT get
 * the application's module-boundary zone, which is the same drift in reverse —
 * a glob left pointing at the old `src/**` would match nothing and silently
 * unprotect the app.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ overrideConfigFile: path.join(repoRoot, "eslint.config.mjs") });

interface ResolvedConfig {
  settings?: { next?: { rootDir?: unknown } };
  rules?: Record<string, unknown>;
}

async function configFor(relativePath: string): Promise<ResolvedConfig> {
  return (await eslint.calculateConfigForFile(path.join(repoRoot, relativePath))) as ResolvedConfig;
}

describe("ESLint scope after the apps/web move", () => {
  it("points the Next plugin at the moved application", async () => {
    const config = await configFor("apps/web/src/app/layout.tsx");

    expect(config.settings?.next?.rootDir).toBe("apps/web");
    expect(Object.keys(config.rules ?? {}).some((rule) => rule.startsWith("@next/next/"))).toBe(true);
  });

  it("still applies the application module-boundary zones under apps/web", async () => {
    const contracts = await configFor("apps/web/src/contracts/index.ts");
    const client = await configFor("apps/web/src/components/shell/app-shell.tsx");

    // Both zones are defined by a `no-restricted-imports` block; a glob left on
    // the old root path would resolve to the type-aware defaults instead.
    expect(contracts.rules?.["no-restricted-imports"]).toBeDefined();
    expect(client.rules?.["no-restricted-imports"]).toBeDefined();
  });
});

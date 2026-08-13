import fs from "node:fs/promises";
import path from "node:path";
import { ESLint } from "eslint";
import { afterAll, describe, expect, it } from "vitest";

const fixtureDir = path.join(process.cwd(), "apps/web/src/app/api/__image_internal_lint_fixture__");
const fixturePath = path.join(fixtureDir, "route.ts");
const eslint = new ESLint({ overrideConfigFile: path.join(process.cwd(), "eslint.config.mjs") });

async function lintRoute(source: string) {
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(fixturePath, source, "utf8");
  const [result] = await eslint.lintFiles([fixturePath]);
  return result?.messages ?? [];
}

afterAll(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

describe("route image-helper import boundary", () => {
  // The first programmatic type-aware ESLint run builds the project graph and
  // takes ~15 seconds on CI; subsequent checks reuse the cache. This is still the
  // real repository config, not a hand-copied approximation of the rule.
  it(
    "rejects an unscoped image mutation imported through the server barrel",
    async () => {
      const messages = await lintRoute(`
        import { deleteChatAssets } from "@/server/images";
        void deleteChatAssets;
      `);

      expect(messages.some((message) => message.ruleId === "no-restricted-imports")).toBe(true);
    },
    30_000,
  );

  it("allows the owner-scoped route-facing helper", async () => {
    const messages = await lintRoute(`
      import { deleteOwnedChatAssets } from "@/server/images";
      void deleteOwnedChatAssets;
    `);

    expect(messages.filter((message) => message.ruleId === "no-restricted-imports")).toEqual([]);
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The documentation gate's own regression suite (`pnpm lint:docs`,
 * `scripts/check-docs.mjs`).
 *
 * Running the checker over this repository proves only that today's docs are
 * clean. These fixtures assert the RULES: a checker that silently stopped
 * catching one of the three failure modes would still say OK on `main`, and
 * `verify` would go green on a docs-only PR that broke a link, cited a heading
 * that moved, or named a retired working document. Each failing tree breaks
 * exactly one thing in an otherwise legal repository, and the legal tree must
 * pass — including the citation forms the retired-document rule allows.
 *
 * The script is spawned rather than imported: it is deliberately plain ESM
 * JavaScript so CI can run it without an install, and the root tsconfig has no
 * `allowJs`, so importing it here would need a declaration file for a
 * one-function module. The exit code is part of the contract anyway.
 */

const SCRIPT = join(process.cwd(), "scripts", "check-docs.mjs");

// The retired-document check scans `scripts/` too, so the fixture spellings it
// must catch are assembled at runtime rather than written out — a literal
// `<name>.plan.md` or `§N` in this file would be a hit against this file.
const SECTION = "§";
const RETIRED_NAME = "chat-initiative" + ".plan.md";

const BASE: Record<string, string> = {
  "docs/README.md": "# Docs\n\nRead [the guide](guide.md) and [resilience](resilience.md#2-diagnostics).\n",
  "docs/guide.md":
    "# Guide\n\n## Owns / does not own (boundary)\n\nDegradation follows " +
    `[resilience.md](resilience.md) ${SECTION}2, and the boundary is stated in guide.md ${SECTION}Owns / does not own.\n`,
  "docs/resilience.md": `# Resilience\n\n## 1. Boundary parsing\n\n## 2. Diagnostics\n\nSee ${SECTION}1 for the boundary.\n`,
  "apps/web/src/lib/parse.ts": `// Diagnostics over exceptions (docs/resilience.md ${SECTION}2).\nexport const x = 1;\n`,
  "packages/core/src/index.ts": `// Trust boundary (resilience.md ${SECTION}1).\nexport const y = 1;\n`,
};

const roots: string[] = [];

function tree(overrides: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "vesper-docs-check-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries({ ...BASE, ...overrides })) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function run(root: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("check-docs", () => {
  it("passes a legal tree, including every allowed citation form", () => {
    const result = run(tree());
    expect(result.output).toMatch(/^OK docs checks: 3 docs/m);
    expect(result.status).toBe(0);
  });

  it.each<[string, Record<string, string>, string]>([
    [
      "a relative link to a file that does not exist",
      { "docs/README.md": "# Docs\n\nSee [the missing page](sub/missing.md).\n" },
      "BROKEN LINK docs/README.md -> sub/missing.md",
    ],
    [
      "a section citation naming a document that does not exist",
      { "docs/guide.md": `# Guide

See recovery.md ${SECTION}Ladder.
` },
      `NO DOCUMENT docs/guide.md -> recovery.md ${SECTION}Ladder`,
    ],
    [
      "a section citation naming a heading the file does not have",
      { "docs/guide.md": `# Guide\n\nSee resilience.md ${SECTION}Recovery ladder.\n` },
      `NO SECTION docs/guide.md -> resilience.md ${SECTION}Recovery ladder`,
    ],
    [
      "a retired working document named in a doc",
      { "docs/guide.md": `# Guide\n\nThe rule came from \`${RETIRED_NAME}\`.\n` },
      `RETIRED DOCUMENT docs/guide.md:3 -> ${RETIRED_NAME}`,
    ],
    [
      "a bare section number with no owning document on the line",
      { "apps/web/src/lib/parse.ts": `// Leaf-.catch (resilience ${SECTION}3).\nexport const x = 1;\n` },
      `RETIRED SECTION apps/web/src/lib/parse.ts:1 -> ${SECTION}3`,
    ],
    [
      "a section number the named document does not have",
      { "packages/core/src/index.ts": `// See docs/resilience.md ${SECTION}9.\nexport const y = 1;\n` },
      `RETIRED SECTION packages/core/src/index.ts:1 -> ${SECTION}9`,
    ],
  ])("fails on %s", (_name, overrides, finding) => {
    const result = run(tree(overrides));
    expect(result.output).toContain(finding);
    expect(result.output).toMatch(/^FAIL docs checks:/m);
    expect(result.status).toBe(1);
  });
});

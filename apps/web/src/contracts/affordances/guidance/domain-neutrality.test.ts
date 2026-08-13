import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The shared-compiler neutrality guardrail (narrator-physical-guidance.plan.md
 * slice 1: "no domain names in the shared compiler"; acceptance criteria: "Hair
 * and foot-contact fixtures use the same compiler without domain logic entering
 * the shared layer").
 *
 * `core/domain-neutrality.test.ts` polices `core/` only, and this layer is
 * deliberately OUTSIDE `core/` — so the same claim needs its own mechanical
 * check here, or the folder that was created to be lane-neutral would be the one
 * folder nobody checks.
 *
 * Three offences are scanned for:
 *
 * 1. domain vocabulary in executable code (prose may cite a domain: comments are
 *    documentation, not a dependency);
 * 2. an import from a `domains/` folder — vocabulary must arrive as DATA
 *    (`ConstraintClaimMapping`, opaque claim codes), never as a module;
 * 3. an import from a lane (`@/server`, `@/app`) — enforced by ESLint for all of
 *    `src/contracts` too, restated here because a guidance compiler that reached
 *    into a lane would defeat the point of building it lane-neutral first.
 */

const GUIDANCE_DIR = path.join(process.cwd(), "apps/web/src/contracts/affordances/guidance");

/** Prose may name a domain; code may not. Strip comments before scanning. */
function executableCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/.*$/gmu, " ");
}

/**
 * The same word list `core/` uses, and for the same reason: it names BOTH proven
 * domains, so a neutral layer cannot pass by having merely swapped one favourite
 * for two. Slice 2's lexicon lives in the hair domain; slice 3's in the contact
 * resolver.
 */
const DOMAIN_WORDS: readonly string[] = [
  "hair",
  "strand",
  "braid",
  "clump",
  "garment",
  "wardrobe",
  "fabric",
  "opacity",
  "saturation",
  "cling",
  "skin",
  "breast",
  "wing",
  "tail",
];

interface GuidanceSource {
  readonly name: string;
  readonly source: string;
}

/** Source files only — a test beside them may legitimately name what it exercises. */
function guidanceSources(): readonly GuidanceSource[] {
  return fs
    .readdirSync(GUIDANCE_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, source: fs.readFileSync(path.join(GUIDANCE_DIR, name), "utf8") }));
}

describe("the guidance compiler names no domain and reaches no lane", () => {
  it("has the whole module set to check", () => {
    const names = guidanceSources().map((entry) => entry.name);
    expect(names).toContain("compile.ts");
    expect(names).toContain("selection.ts");
    expect(names).toContain("disclosure.ts");
    expect(names.length).toBeGreaterThan(4);
  });

  it("contains no domain vocabulary in executable code", () => {
    const offences = guidanceSources().flatMap((entry) => {
      const code = executableCode(entry.source);
      return DOMAIN_WORDS.filter((word) => new RegExp(`\\b${word}`, "iu").test(code)).map(
        (word) => `${entry.name}: "${word}"`,
      );
    });
    expect(offences).toEqual([]);
  });

  it("imports no domain module and no lane module", () => {
    const banned: readonly { readonly label: string; readonly pattern: RegExp }[] = [
      { label: "domain", pattern: /from\s+["'][^"']*domains?\//u },
      { label: "lane", pattern: /from\s+["']@\/(?:server|app|components)/u },
    ];
    const offences = guidanceSources().flatMap((entry) =>
      banned.filter((rule) => rule.pattern.test(entry.source)).map((rule) => `${entry.name}: ${rule.label}`),
    );
    expect(offences).toEqual([]);
  });
});

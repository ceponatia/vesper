import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The SECOND-DOMAIN PROOF, as a guardrail rather than a promise
 * (body-attribute-affordances.plan.md slice 6: "It must reuse the same
 * foundation without adding hair knowledge to the shared core").
 *
 * The plan's claim is that `affordances/core` stages a calculation it knows
 * nothing about. That claim is easy to state, easy to believe, and easy to break
 * with one convenient field — so it is checked mechanically: no file under
 * `core/` may name a concrete domain, its vocabulary, or its anatomy.
 *
 * If a genuine generalization is needed, it must be expressible in
 * domain-neutral words. `compileProfile` taking the whole read request rather
 * than the attribute snapshot is what that looks like: it let a wardrobe-sourced
 * domain compile a profile without the core learning the word "garment".
 */

const CORE_DIR = path.join(process.cwd(), "src/contracts/affordances/core");

/**
 * Words that would mean a domain had leaked in. Deliberately includes the
 * SECOND domain's vocabulary too — the point is a neutral core, not a core that
 * has merely swapped one favourite for two.
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

/** Source files only — the tests beside them legitimately name the domains they exercise. */
function coreSourceFiles(): string[] {
  return fs
    .readdirSync(CORE_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(CORE_DIR, name));
}

/**
 * Strip comments before scanning. Prose is where the core is ALLOWED to name a
 * domain — the doc comments cite the hair spec, explain the garment-cue
 * precedent the ranker was modelled on, and say which examples a term came
 * from. That is documentation, not a dependency; what must stay clean is the
 * code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/.*$/gmu, " ");
}

describe("the affordance core names no domain", () => {
  it("has source files to check", () => {
    expect(coreSourceFiles().length).toBeGreaterThan(4);
  });

  it("contains no domain vocabulary in executable code", () => {
    const offences = coreSourceFiles().flatMap((file) => {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      return DOMAIN_WORDS.filter((word) => new RegExp(`\\b${word}`, "iu").test(code)).map(
        (word) => `${path.basename(file)}: "${word}"`,
      );
    });
    expect(offences).toEqual([]);
  });

  it("imports nothing from a domain folder", () => {
    const offences = coreSourceFiles().flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      return /from\s+["'][^"']*domains?\//u.test(source) ? [path.basename(file)] : [];
    });
    expect(offences).toEqual([]);
  });
});

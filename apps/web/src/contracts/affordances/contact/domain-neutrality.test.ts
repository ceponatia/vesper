import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The shared-core proof for the contact layer, as a guardrail rather than a
 * promise (romantic-contact-affordances.spec.md: *"The shared core is
 * deliberately minimal. A helper moves into it only after both the foot and
 * intimate domains require the same semantics."*).
 *
 * `core/domain-neutrality.test.ts` polices only `core/`, and `guidance/` carries
 * its own for the same reason: a folder that claims to know nothing about a
 * domain has to be checked, because the claim is one convenient field away from
 * being false. This file is the contact layer's.
 *
 * Three properties, all mechanical:
 *
 * 1. **No domain vocabulary in executable code.** The foot and intimate domains
 *    are the two clients; a core that had learned either one's anatomy would
 *    have stopped being shared.
 * 2. **No import that inverts the layering.** Contact may read the affordance
 *    core, the body-location registry, diagnostics, and `@/lib`. It may not read
 *    a domain, the narrator guidance layer, or anything under `src/server`.
 * 3. **No clock, no randomness.** Determinism is the retake story: story time is
 *    an input, and an id derived from a counter or a timestamp would make a
 *    regenerated reply resolve a different physical moment.
 */

const CONTACT_DIR = path.join(process.cwd(), "apps/web/src/contracts/affordances/contact");

/**
 * Vocabulary that would mean a domain had leaked in. Deliberately includes BOTH
 * planned domains — the point is a neutral core, not one that has swapped a
 * favourite for two.
 */
const DOMAIN_WORDS: readonly string[] = [
  "hair",
  "garment",
  "wardrobe",
  "clothing",
  "fabric",
  "sock",
  "shoe",
  "footwear",
  "foot",
  "feet",
  "toe",
  "heel",
  "arch",
  "sole",
  "nail",
  "breast",
  "nipple",
  "vulva",
  "penis",
  "genital",
  "anus",
  "lotion",
  "sweat",
  "arousal",
];

/** Modules this layer may never reach for. */
const FORBIDDEN_IMPORT_PATTERNS: readonly RegExp[] = [
  /from\s+["'][^"']*\/domains?\//u,
  /from\s+["'][^"']*\/guidance["']/u,
  /from\s+["']@\/server/u,
  /from\s+["']@\/app/u,
  /from\s+["']@\/components/u,
];

/** Anything that would make the same inputs resolve differently twice. */
const NONDETERMINISM = [/\bDate\b/u, /Math\.random/u, /performance\.now/u, /\bprocess\.env\b/u];

/**
 * Source files only. `test-support.ts` counts as source for the import and
 * determinism rules but is excluded from the vocabulary scan for the same reason
 * the core excludes its tests: a fixture legitimately names the domain it stands
 * in for.
 */
function contactSourceFiles(): string[] {
  return fs
    .readdirSync(CONTACT_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(CONTACT_DIR, name));
}

function productionFiles(): string[] {
  return contactSourceFiles().filter((file) => path.basename(file) !== "test-support.ts");
}

/**
 * Strip comments before scanning. Prose is where this layer is ALLOWED to name a
 * domain — the doc comments cite the foot spec, explain which garment precedent a
 * rule came from, and say what a layer is in ordinary words. That is
 * documentation, not a dependency; what must stay clean is the code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/.*$/gmu, " ");
}

describe("the contact core names no domain", () => {
  it("has source files to check", () => {
    expect(productionFiles().length).toBeGreaterThan(5);
  });

  it("contains no domain vocabulary in executable code", () => {
    const offences = productionFiles().flatMap((file) => {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      return DOMAIN_WORDS.filter((word) => new RegExp(`\\b${word}`, "iu").test(code)).map(
        (word) => `${path.basename(file)}: "${word}"`,
      );
    });
    expect(offences).toEqual([]);
  });

  it("imports nothing from a domain, the narrator layer, or the server", () => {
    const offences = contactSourceFiles().flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      return FORBIDDEN_IMPORT_PATTERNS.some((pattern) => pattern.test(source)) ? [path.basename(file)] : [];
    });
    expect(offences).toEqual([]);
  });

  it("reads no clock and rolls no dice", () => {
    const offences = contactSourceFiles().flatMap((file) => {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      return NONDETERMINISM.filter((pattern) => pattern.test(code)).map(
        (pattern) => `${path.basename(file)}: ${pattern.source}`,
      );
    });
    expect(offences).toEqual([]);
  });
});

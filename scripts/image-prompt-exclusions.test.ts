import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder } from "@/server/test-support";

/**
 * The census of negative constraints written into POSITIVE prompt prose: this
 * is the architecture test preventing new embedded "no X" boilerplate in
 * production prompt builders.
 *
 * A phrase like "no text, no watermark" or "nobody else appears" is a negative
 * constraint. Written into a positive paragraph it is invisible to every guard
 * the negative system has: the collision linter cannot subtract it when a sign
 * legitimately needs lettering, no pack version owns it, no evidence justifies
 * it, and no provenance records that it was sent. That is precisely the failure
 * `prompts-entity.ts` demonstrated — its hand-appended "no people, no text, no
 * watermark" tail survived every review because nothing could see it.
 *
 * The rule this enforces is narrow and mechanical: the set below may SHRINK as
 * lanes cut over, and it may never GROW. A new exclusion belongs in a versioned
 * negative pack with a guard, not in a sentence.
 *
 * It is a census rather than a ban because the scene prose builder is still in
 * the tree. Every entry here is a lane awaiting cutover, and deleting the entry
 * is part of cutting it over.
 */

const PROMPT_DIR = path.join(process.cwd(), "apps/web/src/server/images");

/**
 * The shapes an exclusion takes in this codebase's prose.
 *
 * Deliberately over-broad on the "never/only/nobody" side: a false positive costs
 * one reviewed line in the approved list, and a false negative is a negative
 * constraint reaching a provider with nothing watching it.
 */
const EXCLUSION_PATTERNS: readonly RegExp[] = [
  /\bno (?:text|watermark|people|garment|other|extra)\b/i,
  /\bnobody else\b/i,
  /\bnever (?:visible|merge|rotate|appears?)\b/i,
  /\badd no\b/i,
  /\bdo not (?:include|show|add|rotate|render)\b/i,
  /\bdepict only\b/i,
  /\bis not visible\b/i,
];

/**
 * Every embedded exclusion this repository still has, reviewed 2026-09-01.
 *
 * Each is a lane that has not cut over. `entity-prompt-program.ts` and the
 * character lanes are deliberately absent: they ARE cut over, and their
 * exclusions live in versioned negative packs behind the collision linter,
 * which is what every line below is waiting to become.
 */
const APPROVED: Readonly<Record<string, number>> = {
  // The chat-place shot's "no people anywhere in frame" — the same claim the
  // item and location lanes make as an operation contract with
  // `subjectCount: 0`. (The avatar, variant, chat-look and scene lanes carry
  // none: their prompts are compiled programs, and their exclusions live in
  // versioned negative packs behind the collision linter.)
  "apps/web/src/server/images/chat-look.ts": 1,
  // The composer's instructions to the scene-spec LLM, not prompt text sent to
  // an image provider — but counted, because the day the composer's output
  // feeds a prompt program these become claims like any other.
  "apps/web/src/server/images/prompts-scene-composer.ts": 2,
};

function exclusionCount(source: string): number {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .reduce((total, line) => total + (EXCLUSION_PATTERNS.some((pattern) => pattern.test(line)) ? 1 : 0), 0);
}

describe("embedded prompt exclusion census", () => {
  it("holds only the reviewed lanes still awaiting cutover", () => {
    const actual: Record<string, number> = {};
    for (const absolute of sourceFilesUnder(PROMPT_DIR, { recursive: false })) {
      const count = exclusionCount(fs.readFileSync(absolute, "utf8"));
      if (count > 0) actual[repoRelative(absolute)] = count;
    }
    expect(actual).toEqual(APPROVED);
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder } from "@/server/test-support";

/**
 * The census of negative constraints written into POSITIVE prompt prose
 * (model-aware-image-prompts.plan.md §"Stage 0 — research and current-behavior
 * freeze": "add architecture tests preventing new embedded 'no X' boilerplate in
 * production prompt builders").
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
 * It is a census rather than a ban because these lanes are frozen mid-migration
 * (`apps/web/src/server/images/prompt-freeze.test.ts` pins their payloads). Every
 * entry here is a lane awaiting cutover, and deleting the entry is part of
 * cutting it over.
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
 * Every embedded exclusion this repository still has, reviewed 2026-08-19.
 *
 * Each is a lane that has not cut over. `entity-prompt-program.ts` is
 * deliberately absent: the item and location lanes ARE cut over, and their
 * exclusions now live in `qwenImage2512NegativePack` behind the collision
 * linter, which is what every line below is waiting to become.
 */
const APPROVED: Readonly<Record<string, number>> = {
  // The two style suffixes, each ending "no text, no watermark".
  "apps/web/src/server/images/prompts-avatar.ts": 2,
  // The SAME two suffix sentences, carried verbatim through the Stage 3 avatar
  // cutover as the route-owned `quality` segment (avatar wording is preserved
  // behavior). Not a new exclusion: this copy and the legacy one above retire
  // together when Stage 6 deletes `buildAvatarPrompt` and the tail moves into a
  // versioned negative pack under the model-aware plan.
  "apps/web/src/server/images/avatar-segments.ts": 2,
  // The variant instruction's tail, on every portrait edit.
  "apps/web/src/server/images/prompts-variant.ts": 1,
  // The POV rule's "never visible", the two cast-integrity lines, the
  // turned-away adaptation's "not visible"/"do not rotate" pair, the
  // clothing-authority sentence, the empty-scene "no people in frame", the
  // shared "no text, no watermark" tail, and the multi-reference "never merge,
  // swap, or duplicate".
  "apps/web/src/server/images/prompts-scene-render.ts": 9,
  // The chat look edit's clothing authority, and the chat-place shot's "no
  // people anywhere in frame" — the same claim the item and location lanes now
  // make as an operation contract with `subjectCount: 0`.
  "apps/web/src/server/images/chat-look.ts": 2,
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

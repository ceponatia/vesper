import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder, stripComments } from "@/server/test-support";

/**
 * Character appearance prose has ONE owner — the architecture test behind
 * "remove superseded image prompt code" (#251).
 *
 * Every character lane describes a person from their committed visual cut,
 * folded into a world digest and worded by the endpoint's dialect
 * (`buildCharacterPromptProgram`). The words come from
 * `apps/web/src/contracts/images/character-adapter.ts` — attribute values to
 * semantic claims, the owner-ruled age floor, the exposure reads — and from
 * `character-digest.ts` beside it. The modules under `apps/web/src/server/images`
 * assemble cuts, plan references and send programs; none of them phrases a
 * body. Before #251 that folder held five lane-local builders that each
 * formatted attributes into prose, and the same person was described
 * differently depending on which route rendered them. A sixth would come back
 * one helper at a time, which is why this is a census and not a review note.
 *
 * Two mechanical pins over the folder's production modules:
 *
 * 1. No module turns an attribute into words: no call to `formatAttribute(`,
 *    `formatAttributeValue(` or `attributeRegistry.byId(`. Reading
 *    `profile.attributes` is deliberately NOT counted — handing the sheet to
 *    the snapshot assembly (`assembleVisualStateSnapshot`, `resolveAttributes`)
 *    IS the approved path, and a text census cannot tell a read that feeds the
 *    digest from one that feeds a sentence. The formatting call is what makes
 *    prose of a value, so the formatting call is what is counted.
 * 2. No module exports a prose builder by name — `build…Prompt`,
 *    `…AppearanceSummary`, `…AnatomySummary` — outside the reviewed residue.
 *
 * APPROVED is that residue and may only shrink. Both entries match the builder
 * shape and neither describes a character from attributes: the chat-place shot
 * draws a location with nobody in it, and the composer's builder instructs the
 * scene-composing LLM rather than an image model, phrasing wardrobe rows
 * (`wardrobeOutfitSummary`) and never the sheet. The day either output feeds a
 * prompt program from a character's facts, the words come through the adapter
 * and the entry goes.
 */

const IMAGES_DIR = path.join(process.cwd(), "apps/web/src/server/images");

/** The calls that make prompt words of an attribute value. */
const ATTRIBUTE_PHRASING = /\b(?:formatAttribute|formatAttributeValue)\(|\battributeRegistry\.byId\(/g;

/** An exported function named like a prose builder. */
const PROSE_BUILDER_EXPORT = /\bexport\s+(?:async\s+)?function\s+(build\w*Prompt|\w*AppearanceSummary|\w*AnatomySummary)\b/g;

/** The reviewed residue, per module, in declaration order. */
const APPROVED: Readonly<Record<string, readonly string[]>> = {
  // The identity-free `chat_place` shot: a location with `subjectCount: 0`, no
  // character and no attribute in it (the same entry the exclusions census holds).
  "apps/web/src/server/images/chat-look.ts": ["buildChatPlacePrompt"],
  // The composer's instructions to the scene-spec LLM — wardrobe rows and
  // coverage, never the sheet — not prompt text sent to an image provider.
  "apps/web/src/server/images/prompts-scene-composer.ts": ["buildSceneComposerPrompt"],
};

describe("character appearance prose has one owner", () => {
  const modules = sourceFilesUnder(IMAGES_DIR, { recursive: false })
    .map((absolute) => ({ file: repoRelative(absolute), code: stripComments(fs.readFileSync(absolute, "utf8")) }))
    .sort((left, right) => left.file.localeCompare(right.file));

  it("has no module formatting an attribute into prompt words", () => {
    const phrasing: Record<string, number> = {};
    for (const { file, code } of modules) {
      const count = code.match(ATTRIBUTE_PHRASING)?.length ?? 0;
      if (count > 0) phrasing[file] = count;
    }
    expect(phrasing).toEqual({});
  });

  it("exports no prose builder outside the reviewed residue", () => {
    const builders: Record<string, string[]> = {};
    for (const { file, code } of modules) {
      const names = [...code.matchAll(PROSE_BUILDER_EXPORT)].map((match) => match[1] ?? "");
      if (names.length > 0) builders[file] = names;
    }
    expect(builders).toEqual(APPROVED);
  });
});

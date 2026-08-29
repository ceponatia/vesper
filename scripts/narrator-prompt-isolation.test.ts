import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder, stripComments } from "@/server/test-support";

/**
 * The Prompt Lab is narrator-only — product law from the plan's §Agent
 * isolation, restated in the spec's Ownership rules: the resolved
 * `NarratorInstructionSource` reaches the four prose-narrator paths (legacy
 * 1:1/ensemble, successor co-present/solo) and NOTHING else. Not the reaction
 * pulse, memory extraction, the archivist, visual extraction, the
 * physical/contact or permission classifiers, the scene composer, meanwhile
 * agents, or the successor deliberator — helpers produce structured state, and
 * an owner's handwritten craft prose leaking into a classifier prompt would
 * corrupt extraction for a conversation precisely while it is being measured.
 *
 * No other gate sees this: tsc happily accepts a new `instructionSource`
 * parameter on a helper builder, and no behavioral suite runs every helper under
 * an override. So this census does what `image-internal-callers.test.ts` does
 * for image writes: any server/API module that touches the instruction-source
 * contract or imports the narrator-prompts service must be one of the reviewed
 * consumers below. Wiring the override into a new module is allowed — by
 * editing this list in a diff a reviewer can see, with the reason beside it.
 *
 * Comment-stripped before matching, so prose mentioning the contract stays free.
 */

const ROOTS = [path.join(process.cwd(), "apps/web/src/server"), path.join(process.cwd(), "apps/web/src/app/api")];

/**
 * The resolved-source surface: the source type and its schema/constructors, the
 * one resolver, the field name that threads it through build inputs, and the
 * service barrel (CRUD + resolver — no helper agent has business with any of it).
 */
const SOURCE_TOKENS =
  /\b(?:NarratorInstructionSource|narratorInstructionSourceSchema|resolveNarratorInstructionSource|productionInstructionSource|isTestInstructionSource|instructionSource)\b|@\/server\/narrator-prompts/;

/** Reviewed 2026-08-29 (slice 7 hardening): every entry is a sanctioned consumer. */
const APPROVED: readonly string[] = [
  // The Prompt Lab's own admin routes — template CRUD, duplicate, failure
  // mapping, and the per-chat selection (all behind `withOwnerAdmin*`).
  "apps/web/src/app/api/admin/self/narrator-prompt/[chatId]/route.ts",
  "apps/web/src/app/api/admin/self/narrator-prompts/[promptId]/duplicate/route.ts",
  "apps/web/src/app/api/admin/self/narrator-prompts/[promptId]/route.ts",
  "apps/web/src/app/api/admin/self/narrator-prompts/failure.ts",
  "apps/web/src/app/api/admin/self/narrator-prompts/route.ts",
  // The two exchange pipelines: each resolves ONE source under its exchange
  // lock, threads the frozen value into the prose-narrator build, and stamps
  // take provenance from it. The legacy pipeline also renders the admin
  // inspector's read-only preview (sanctioned by the spec: the inspector shows
  // the prose narrator's own prompt, which is not a helper agent).
  "apps/web/src/server/engine/chat-pipeline.ts",
  "apps/web/src/server/engine/sim-exchange.ts",
  // The successor render loop — rebuilds every hidden retry from the SAME
  // frozen source carried on its context, and records the revision it used.
  "apps/web/src/server/engine/sim-narrator.ts",
  // The four prose-narrator prompt builders and their shared classified charter.
  "apps/web/src/server/engine/prompts/character-chat.ts",
  "apps/web/src/server/engine/prompts/charter.ts",
  "apps/web/src/server/engine/prompts/sim-render.ts",
  "apps/web/src/server/engine/prompts/sim-solo-render.ts",
  // The owner: selection storage and the never-throws resolution.
  "apps/web/src/server/narrator-prompts/selection.ts",
];

describe("narrator instruction-source consumer census", () => {
  it("contains only the reviewed prose-narrator consumers — helper agents stay on their own prompts", () => {
    const actual: string[] = [];
    for (const absolute of ROOTS.flatMap((root) => sourceFilesUnder(root))) {
      if (SOURCE_TOKENS.test(stripComments(fs.readFileSync(absolute, "utf8")))) actual.push(repoRelative(absolute));
    }
    expect(actual.sort()).toEqual([...APPROVED].sort());
  });
});

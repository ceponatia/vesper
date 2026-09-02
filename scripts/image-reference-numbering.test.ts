import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder, stripComments } from "@/server/test-support";

/**
 * The census of reference-slot labels authored by application code — the
 * architecture test behind "one scene prompt and reference path".
 *
 * A prompt that says "Image 2" or "2) the location" is making a claim about
 * slot 2 of the payload, and the only code that knows what slot 2 carries is
 * the reference planner the prompt program compiles against. A label written
 * anywhere else describes a list the provider may never receive: the scene
 * lane's prose builder numbered its multi-reference list from the lane's own
 * order, BEFORE planning reordered, role-capped and capacity-trimmed the send
 * list, so "Image 2" in the text could name a different image than slot 2 of
 * the payload. The prompt program numbers from its plan and the scene rung
 * sends that plan (`scene.ts`, `sentReferencesFor`) — an invariant only while
 * nothing in the application authors a slot label of its own.
 *
 * The rule is mechanical: the set below may SHRINK and may never GROW. Its one
 * entry is the prose builder, which still serves the Image Lab's staged bench
 * and the scene eval script until #251 deletes it; no chat scene runs it, which
 * the second case pins structurally rather than by inspecting prompts.
 */

const IMAGES_DIR = path.join(process.cwd(), "apps/web/src/server/images");

/**
 * The shapes a slot label takes in this codebase's prompt code: a numbered
 * image from a variable or a literal, a spelled ordinal, and an index-plus-one
 * enumeration label.
 */
const SLOT_LABEL_PATTERNS: readonly RegExp[] = [
  /\bImage \$\{/,
  /\bImage [0-9]+\b/,
  /\bimage (?:one|two|three|four)\b/i,
  /\$\{\s*\w+\s*\+\s*1\s*\}\s*[):]/,
];

/**
 * Every slot label application code still authors: `describeMultiReferences`'s
 * "1) Mira … 2) the location" enumeration, in the builder the lab bench runs.
 */
const APPROVED_LABELS: Readonly<Record<string, number>> = {
  "apps/web/src/server/images/prompts-scene-render.ts": 1,
};

/** The modules that may import the prose builder: the bench that still runs it, and the barrel. */
const APPROVED_IMPORTERS: readonly string[] = [
  "apps/web/src/server/images/image-lab-staged.ts",
  "apps/web/src/server/images/index.ts",
];

const PROSE_BUILDER_IMPORT = /from\s+["']\.\/prompts-scene-render["']/;

describe("reference-slot labels are the prompt program's to write", () => {
  const modules = sourceFilesUnder(IMAGES_DIR, { recursive: false })
    .map((absolute) => ({ file: repoRelative(absolute), code: stripComments(fs.readFileSync(absolute, "utf8")) }))
    .sort((left, right) => left.file.localeCompare(right.file));

  it("holds the census of application-authored slot labels", () => {
    const actual: Record<string, number> = {};
    for (const { file, code } of modules) {
      const count = code
        .split("\n")
        .filter((line) => SLOT_LABEL_PATTERNS.some((pattern) => pattern.test(line))).length;
      if (count > 0) actual[file] = count;
    }
    expect(actual).toEqual(APPROVED_LABELS);
  });

  it("keeps the scene prose builder out of every production scene module", () => {
    const importers = modules.filter(({ code }) => PROSE_BUILDER_IMPORT.test(code)).map(({ file }) => file);
    expect(importers).toEqual([...APPROVED_IMPORTERS].sort((left, right) => left.localeCompare(right)));
  });
});

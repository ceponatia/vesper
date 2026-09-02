import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder, stripComments } from "@/server/test-support";

/**
 * Reference-slot labels are the prompt program's to write — the architecture
 * test behind "one scene prompt and reference path".
 *
 * A prompt that says "Image 2" or "2) the location" is making a claim about
 * slot 2 of the payload, and the only code that knows what slot 2 carries is
 * the reference planner the prompt program compiles against. A label written
 * anywhere else describes a list the provider may never receive: the scene
 * lane's retired prose builder numbered its multi-reference list from the
 * lane's own order, BEFORE planning reordered, role-capped and capacity-trimmed
 * the send list, so "Image 2" in the text could name a different image than
 * slot 2 of the payload. The prompt program numbers from its plan and every
 * scene rung sends that plan (`scene.ts`, `sentReferencesFor`); the Image Lab's
 * staged bench sends its program's own planned list the same way.
 *
 * Two pins, both mechanical:
 *
 * 1. The census of application-authored slot labels is EMPTY. It reached empty
 *    when #251 deleted the prose builder, and it may never grow again — a new
 *    label belongs in a dialect, where it is numbered from the plan.
 * 2. No module under `server/images` imports a scene prose builder. The scene
 *    lane's prompt modules are the composer's contract and the plan resolver,
 *    and those two are named; any OTHER `prompts-scene-*` module in the folder,
 *    or an import of one, is a prose builder coming back under a familiar name
 *    and fails here rather than compiling quietly beside the program.
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
 * The scene lane's two legitimate prompt modules: the composer's contract and
 * the plan resolver. Every other `prompts-scene-*` name is a prose builder.
 */
const SCENE_PROMPT_MODULES: ReadonlySet<string> = new Set(["prompts-scene-composer", "prompts-scene-plan"]);
const SCENE_PROMPT_MODULE_NAME = /^prompts-scene-[\w-]+$/;
const SCENE_PROMPT_IMPORT = /from\s+["']\.\/(prompts-scene-[\w-]+)["']/g;

function isProseBuilderName(name: string): boolean {
  return SCENE_PROMPT_MODULE_NAME.test(name) && !SCENE_PROMPT_MODULES.has(name);
}

describe("reference-slot labels are the prompt program's to write", () => {
  const modules = sourceFilesUnder(IMAGES_DIR, { recursive: false })
    .map((absolute) => ({ file: repoRelative(absolute), code: stripComments(fs.readFileSync(absolute, "utf8")) }))
    .sort((left, right) => left.file.localeCompare(right.file));

  it("has no application module authoring a slot label", () => {
    const authors: Record<string, number> = {};
    for (const { file, code } of modules) {
      const count = code
        .split("\n")
        .filter((line) => SLOT_LABEL_PATTERNS.some((pattern) => pattern.test(line))).length;
      if (count > 0) authors[file] = count;
    }
    expect(authors).toEqual({});
  });

  it("keeps every scene prose builder out of the images folder", () => {
    const builders = modules
      .map(({ file }) => path.basename(file, ".ts"))
      .filter((name) => !name.endsWith(".test") && isProseBuilderName(name));
    expect(builders).toEqual([]);

    const importers = modules
      .filter(({ code }) => [...code.matchAll(SCENE_PROMPT_IMPORT)].some((match) => isProseBuilderName(match[1] ?? "")))
      .map(({ file }) => file);
    expect(importers).toEqual([]);
  });
});

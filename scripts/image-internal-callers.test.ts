import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder } from "@/server/test-support";

const ROOTS = [path.join(process.cwd(), "src"), path.join(process.cwd(), "scripts")];
const INTERNAL_NAMES = new Set(["saveImageBuffer", "deleteChatUploads", "deleteChatAssets"]);

/**
 * Reviewed 2026-07-26; re-reviewed 2026-08-02 (image-pipeline-consolidation
 * C1): the five generation lanes no longer import `saveImageBuffer` — they run
 * on `runImagePipeline`, and the shell's save call lives inside `assets.ts`
 * itself (the defining module, so it never appears as an import). Every
 * remaining entry is either the upload worker that minted the row it writes,
 * the route-safe owner-checking adapter, or the chat pipeline's authenticated
 * rerun / ownership-reverified delete cascade.
 *
 * Re-reviewed 2026-08-05 (image-identity-packs): the identity-pack service joins
 * the "minted the row it writes" class. It does not ride `runImagePipeline` —
 * that shell is a provider-generation sequence, and a face crop is derived
 * locally from bytes this app already stored — so it mints the hidden crop row
 * with `createImageAsset` and writes that exact id, having already re-authorized
 * the character and re-verified the source hash.
 *
 * Re-reviewed 2026-08-06 (identity-pack trial correctness pass): the trial
 * service also joins the "minted the row it writes" class — it has imported
 * `saveImageBuffer` since the slice-6 harness landed, and this census should
 * have been extended then. It cannot ride `runImagePipeline` because a trial
 * output's fate is decided AFTER storage by the durable-claim settlement CAS:
 * a settle that loses the claim race must discard the just-stored hidden
 * image rather than attach it, and the pipeline shell has no
 * store-then-maybe-discard arm. The service mints the hidden
 * `identity_trial_output` row with `createImageAsset`, writes that exact id,
 * and every read/write is owner-scoped through the run row.
 */
const APPROVED: Readonly<Record<string, readonly string[]>> = {
  saveImageBuffer: [
    "src/server/images/identity-pack-trial.ts",
    "src/server/images/identity-packs.ts",
    "src/server/images/internal.ts",
    "src/server/images/route-safe.ts",
    "src/server/images/upload.ts",
  ],
  deleteChatUploads: ["src/server/engine/chat-pipeline.ts", "src/server/images/internal.ts"],
  deleteChatAssets: ["src/server/engine/chat-pipeline.ts", "src/server/images/internal.ts"],
};

function importedInternalNames(source: string): string[] {
  const found = new Set<string>();
  const declaration = /(?:import|export)\s*{([^}]+)}\s*from\s*["'][^"']+["']/g;
  let match = declaration.exec(source);
  while (match !== null) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const imported = specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
      if (INTERNAL_NAMES.has(imported)) found.add(imported);
    }
    match = declaration.exec(source);
  }
  return [...found];
}

describe("internal image helper caller census", () => {
  it("contains only reviewed worker, adapter, and cascade imports", () => {
    const actual: Record<string, string[]> = Object.fromEntries([...INTERNAL_NAMES].map((name) => [name, []]));

    // `sourceFilesUnder` defaults to .ts/.tsx, excludes `*.test.ts` /
    // `*.int.test.ts`, and skips `__name__` directories — the last of which is
    // load-bearing here: image-internal-imports.test.ts plants a transient
    // fixture route under src/app/api mid-run, and racing its lifetime from a
    // parallel worker made this census flaky.
    for (const absolute of ROOTS.flatMap((root) => sourceFilesUnder(root))) {
      const file = repoRelative(absolute);
      for (const name of importedInternalNames(fs.readFileSync(absolute, "utf8"))) actual[name]?.push(file);
    }
    for (const files of Object.values(actual)) files.sort();

    expect(actual).toEqual(
      Object.fromEntries(Object.entries(APPROVED).map(([name, files]) => [name, [...files].sort()])),
    );
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = [path.join(process.cwd(), "src"), path.join(process.cwd(), "scripts")];
const INTERNAL_NAMES = new Set(["saveImageBuffer", "deleteChatUploads", "deleteChatAssets"]);

/**
 * Reviewed 2026-07-26. Every entry is either an image worker that minted the row
 * it writes, the route-safe owner-checking adapter, or the chat pipeline's
 * authenticated rerun / ownership-reverified delete cascade.
 */
const APPROVED: Readonly<Record<string, readonly string[]>> = {
  saveImageBuffer: [
    "src/server/images/avatar.ts",
    "src/server/images/chat-look.ts",
    "src/server/images/entity.ts",
    "src/server/images/internal.ts",
    "src/server/images/route-safe.ts",
    "src/server/images/scene.ts",
    "src/server/images/upload.ts",
    "src/server/images/variants.ts",
  ],
  deleteChatUploads: ["src/server/engine/chat-pipeline.ts", "src/server/images/internal.ts"],
  deleteChatAssets: ["src/server/engine/chat-pipeline.ts", "src/server/images/internal.ts"],
};

function filesUnder(root: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    // `__name__` directories are transient lint fixtures another suite plants in
    // the live tree mid-run (image-internal-imports.test.ts); racing their
    // lifetime from a parallel worker made this census flaky.
    if (entry.isDirectory() && /^__.*__$/.test(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) filesUnder(absolute, out);
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:int\.)?test\.(?:ts|tsx)$/.test(entry.name)) out.push(absolute);
  }
  return out;
}

function repoPath(absolute: string): string {
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

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

    for (const absolute of ROOTS.flatMap((root) => filesUnder(root))) {
      const file = repoPath(absolute);
      for (const name of importedInternalNames(fs.readFileSync(absolute, "utf8"))) actual[name]?.push(file);
    }
    for (const files of Object.values(actual)) files.sort();

    expect(actual).toEqual(
      Object.fromEntries(Object.entries(APPROVED).map(([name, files]) => [name, [...files].sort()])),
    );
  });
});

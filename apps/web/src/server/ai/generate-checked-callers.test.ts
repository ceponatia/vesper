import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder } from "@/server/test-support";

/**
 * The tripwire behind #192's rule: no production leg may call the raw
 * `generateChecked` without a deadline (docs/resilience.md §3).
 *
 * Detecting "without a deadline" by parsing CALL syntax is a trap: a generic
 * type argument alone defeats a plain `generateChecked\(` regex —
 * `generateChecked<Record<string, unknown>>(` has no `(` immediately after
 * the identifier, and a naive `<[^>]*>` clause stops at the FIRST `>` inside
 * the nested `Record<...>`. That is exactly the shape that let
 * `character-forge/profile.ts` slip past this issue's own suggested one-line
 * grep census — found only by scanning imports instead, which is what this
 * test does. Every call site necessarily imports the symbol by name, so a
 * file that also imports `generateCheckedBounded` or `withGenerateTimeout`
 * already satisfies the rule regardless of how its call is spelled.
 *
 * Scope: `apps/web/src` only. `scripts/eval/**` and `scripts/trial/**` also
 * call `generateChecked` directly, but they are offline grading/trial
 * tooling an operator runs and can interrupt themselves — not a request or
 * job a player or a queue can stall on — so they are out of this issue's
 * "reachable leg" scope and out of this census.
 *
 * Blind spot (known, accepted): a file is exempt the moment it imports
 * `generateCheckedBounded` or `withGenerateTimeout` ANYWHERE in it — a SECOND,
 * genuinely unbounded `generateChecked(` call added later to an
 * already-bounded file is invisible to this test. It catches a new unbounded
 * FILE, not a new unbounded CALL SITE inside a file that already has one.
 */

const ROOT = path.join(process.cwd(), "apps/web/src");

/** `generateChecked` is what `generateCheckedBounded`/`withGenerateTimeout` are built on. */
const EXEMPT_FILES = new Set(["apps/web/src/server/ai/generate-checked.ts", "apps/web/src/server/ai/generate-timeout.ts"]);

/**
 * Named imports from any module in `source`, `import type` and per-specifier
 * `type` prefixes stripped, aliases resolved to the ORIGINAL exported name
 * (the part before ` as `) — mirrors `image-internal-callers.test.ts`'s
 * `importedInternalNames`, generalized to whole-statement `import type {}`.
 */
function importedNames(source: string): Set<string> {
  const found = new Set<string>();
  const declaration = /(?:import|export)\s+(?:type\s+)?{([^}]+)}\s*from\s*["'][^"']+["']/g;
  let match = declaration.exec(source);
  while (match !== null) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const imported = specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
      if (imported) found.add(imported);
    }
    match = declaration.exec(source);
  }
  return found;
}

describe("generateChecked callers stay bounded (#192)", () => {
  it("every production file importing generateChecked also imports its bounding helper", () => {
    const scanned: string[] = [];
    const unbounded: string[] = [];
    for (const absolute of sourceFilesUnder(ROOT)) {
      const file = repoRelative(absolute);
      if (EXEMPT_FILES.has(file) || file.includes("/test-support/")) continue;
      const names = importedNames(fs.readFileSync(absolute, "utf8"));
      if (!names.has("generateChecked")) continue;
      scanned.push(file);
      if (!names.has("generateCheckedBounded") && !names.has("withGenerateTimeout")) unbounded.push(file);
    }
    scanned.sort();
    unbounded.sort();
    // A census that scans zero files proves nothing — this floor fails loudly
    // if the root moves, an import style changes (e.g. `import * as ai`), or
    // `sourceFilesUnder`'s filters widen enough to skip every real caller.
    // 7 is today's exact count of already-bounded legacy pairings
    // (chat-vision/chat-memory/chat-meanwhile/chat-scene-sketch/
    // chat-npc-scene-decision/chat-permission-decision/chat-state/pulse-agent);
    // a caller migrating to `generateCheckedBounded` drops out of `scanned`
    // (it no longer imports the bare `generateChecked`), so this floor only
    // ever needs lowering, never raising, as the legacy pairing is retired.
    expect(scanned.length).toBeGreaterThanOrEqual(7);
    expect(unbounded).toEqual([]);
  });
});

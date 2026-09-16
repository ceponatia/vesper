import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RESOURCE_ROUTE } from "./check-route-authz";

/**
 * The release-gated full route-authorization inventory
 * (`scripts/check-route-authz-all.ts`), run only on `workflow_dispatch` and
 * `prod`-bound PRs via `pnpm exec tsx scripts/check-route-authz-all.ts`
 * (ci.yml's "Full route-authorization inventory" step).
 *
 * Kills a defeated-gate regression: the scan used to fail only on
 * `unsafe.length > 0`, so an API-tree move or a `RESOURCE_ROUTE` edit that
 * left it matching zero files reported "examined 0 resource-ID route(s)" and
 * still exited 0 — a release check that had quietly stopped checking
 * anything. The fixed script treats a zero-candidate scan as the broken gate
 * it is: it fails and names the pattern and the file to fix.
 *
 * The script runs unconditionally at module scope (no `isMain` guard, unlike
 * every other entry point beside it — `check-docs.mjs`, `ci-classify.mjs`,
 * `ci-safe-followup.mjs`, and this file's own sibling `check-route-authz.ts`),
 * so there is no exported predicate to call in-process without restructuring
 * production code. It is spawned exactly as CI spawns it — same script, same
 * `tsx` runtime — against a fixture API tree, so these assertions exercise
 * the real file rather than a mocked stand-in.
 */

const REPO_ROOT = process.cwd();
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SCRIPT = join(REPO_ROOT, "scripts", "check-route-authz-all.ts");

// Verbatim safe fixture from check-route-authz.test.ts's "an inline id plus
// owner predicate is authorization evidence" case: known-safe text under the
// scanner this script calls, so the non-empty run below exercises the happy
// path with a shape that is not itself in question here.
const SAFE_ROUTE = `
export const DELETE = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const [deleted] = await db()
    .delete(items)
    .where(and(eq(items.id, id), eq(items.ownerId, user.id)))
    .returning({ id: items.id });
  if (!deleted) return jsonError("not_found", "item not found", 404);
  return jsonOk({ deleted: true });
});
`;

// Each case pays a `tsx` cold start, which is well under a second locally but
// shares a CI runner with two other Vitest workers. Give the spawn real room
// so a busy runner cannot turn this gate's own regression test into a flake.
const SPAWN_TIMEOUT_MS = 20_000;

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "vesper-route-authz-all-"));
  roots.push(root);
  return root;
}

function run(cwd: string): { status: number; output: string } {
  try {
    const output = execFileSync(TSX_BIN, [SCRIPT], { cwd, encoding: "utf8", stdio: "pipe" });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("check-route-authz-all", () => {
  it("fails instead of passing a vacuous scan when no route matches RESOURCE_ROUTE", () => {
    const root = fixture();
    mkdirSync(join(root, "apps", "web", "src", "app", "api"), { recursive: true });

    const result = run(root);

    expect(result.output).toContain("examined 0 resource-ID route(s)");
    expect(result.output).toContain(`No resource-ID routes matched ${RESOURCE_ROUTE.source}`);
    expect(result.output).toContain("verifies nothing until it matches again");
    expect(result.status).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  it("still passes a real resource-ID route carrying recognized authorization evidence", () => {
    const root = fixture();
    const routeDir = join(root, "apps", "web", "src", "app", "api", "items", "[id]");
    mkdirSync(routeDir, { recursive: true });
    writeFileSync(join(routeDir, "route.ts"), SAFE_ROUTE);

    const result = run(root);

    expect(result.output).toContain("examined 1 resource-ID route(s)");
    expect(result.status).toBe(0);
  }, SPAWN_TIMEOUT_MS);
});

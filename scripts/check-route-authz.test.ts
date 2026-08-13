import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder } from "@/server/test-support";
import {
  contentChangedPaths,
  RESOURCE_ROUTE,
  resourceRouteHasAuthorizationEvidence,
} from "./check-route-authz";

const API_DIR = path.join(process.cwd(), "apps/web/src/app/api");
const BARE_WITH_USER_CALL = /\bwithUser(?:<[^>\n]+>)?\s*\(/;

/**
 * The route-authorization gate reads source, so its fast lint path looks only at
 * files whose source changed. Renames are the trap: a repository-wide move
 * makes every file in the tree "changed", and the gate would then report
 * findings about code the change never touched. The unit-test census below is
 * the separate whole-tree backstop for pre-existing routes.
 */
describe("contentChangedPaths", () => {
  it("keeps added, copied and modified paths", () => {
    const status = [
      "A\tapps/web/src/app/api/items/[id]/route.ts",
      "M\tapps/web/src/app/api/chats/[chatId]/route.ts",
      "C075\tapps/web/src/app/api/a/route.ts\tapps/web/src/app/api/b/route.ts",
    ].join("\n");

    expect(contentChangedPaths(status)).toEqual([
      "apps/web/src/app/api/items/[id]/route.ts",
      "apps/web/src/app/api/chats/[chatId]/route.ts",
      "apps/web/src/app/api/b/route.ts",
    ]);
  });

  it("drops a pure rename but keeps a rename that also edited the file", () => {
    const status = [
      "R100\tsrc/app/api/items/[id]/route.ts\tapps/web/src/app/api/items/[id]/route.ts",
      "R087\tsrc/app/api/chats/[chatId]/route.ts\tapps/web/src/app/api/chats/[chatId]/route.ts",
    ].join("\n");

    expect(contentChangedPaths(status)).toEqual(["apps/web/src/app/api/chats/[chatId]/route.ts"]);
  });

  it("ignores blank lines rather than emitting empty paths", () => {
    expect(contentChangedPaths("\n\nM\tapps/web/src/app/api/x/route.ts\n\n")).toEqual([
      "apps/web/src/app/api/x/route.ts",
    ]);
  });
});

interface Fixture {
  name: string;
  path: string;
  source: string;
  safe: boolean;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: "a guarded owner lookup is authorization evidence",
    path: "apps/web/src/app/api/chats/[chatId]/route.ts",
    source: `
export const GET = withUser(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  return jsonOk({ chat: owned.chat });
});
`,
    safe: true,
  },
  {
    name: "the successor gate may guard through its ok result",
    path: "apps/web/src/app/api/chats/[chatId]/sim-command/route.ts",
    source: `
export const POST = withUser(async (user, req, ctx) => {
  const { chatId } = await ctx.params;
  const gate = await requireSimChat(chatId, user.id);
  if (!gate.ok) return gate.response;
  return jsonOk({ branchId: gate.sim.branchId });
});
`,
    safe: true,
  },
  {
    name: "an inline id plus owner predicate is authorization evidence",
    path: "apps/web/src/app/api/items/[id]/route.ts",
    source: `
export const DELETE = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const [deleted] = await db()
    .delete(items)
    .where(and(eq(items.id, id), eq(items.ownerId, user.id)))
    .returning({ id: items.id });
  if (!deleted) return jsonError("not_found", "item not found", 404);
  return jsonOk({ deleted: true });
});
`,
    safe: true,
  },
  {
    name: "the intentional owner-or-public clone seam is recognized",
    path: "apps/web/src/app/api/characters/[id]/clone/route.ts",
    source: `
export const POST = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const result = await cloneToLibrary("character", id, user.id);
  if (!result.ok) return jsonError("not_found", "character not found", 404);
  return jsonOk({ id: result.id }, 201);
});
`,
    safe: true,
  },
  {
    name: "the intentional owner-or-public view seam is recognized",
    path: "apps/web/src/app/api/locations/[id]/route.ts",
    source: `
export const GET = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const row = await findViewable("location", id, user.id);
  if (!row) return jsonError("not_found", "location not found", 404);
  return jsonOk({ row });
});
`,
    safe: true,
  },
  {
    name: "mentioning an approved helper in a comment proves nothing",
    path: "apps/web/src/app/api/chats/[chatId]/route.ts",
    source: `
export const GET = withUser(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  // loadOwnedChat(chatId, user.id) would be the right gate.
  return jsonOk({ chatId });
});
`,
    safe: false,
  },
  {
    name: "calling an approved helper with another owner proves nothing",
    path: "apps/web/src/app/api/chats/[chatId]/route.ts",
    source: `
export const GET = withUser(async (user, req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, body.value.ownerId);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  return jsonOk({ chat: owned.chat });
});
`,
    safe: false,
  },
  {
    name: "discarding an approved helper result proves nothing",
    path: "apps/web/src/app/api/chats/[chatId]/route.ts",
    source: `
export const GET = withUser(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  await loadOwnedChat(chatId, user.id);
  return jsonOk({ chatId });
});
`,
    safe: false,
  },
  {
    name: "an owner predicate on an unrelated id does not guard the route resource",
    path: "apps/web/src/app/api/items/[id]/route.ts",
    source: `
export const DELETE = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const otherId = "different";
  await db().delete(items).where(and(eq(items.id, otherId), eq(items.ownerId, user.id)));
  return jsonOk({ id });
});
`,
    safe: false,
  },
  {
    name: "every bare handler in a mixed route must carry evidence",
    path: "apps/web/src/app/api/items/[id]/route.ts",
    source: `
export const GET = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const row = await findItem(user.id, id);
  if (!row) return jsonError("not_found", "item not found", 404);
  return jsonOk({ row });
});

export const DELETE = withUser(async (_user, _req, ctx) => {
  const { id } = await ctx.params;
  await db().delete(items).where(eq(items.id, id));
  return jsonOk({ deleted: true });
});
`,
    safe: false,
  },
];

describe("resource-route authorization guardrail", () => {
  it("audits every pre-existing bare-withUser resource route, not only changed files", () => {
    const candidates = sourceFilesUnder(API_DIR, { fileName: "route.ts" })
      .map((absolute) => ({
        path: repoRelative(absolute),
        source: fs.readFileSync(absolute, "utf8"),
      }))
      .filter(({ path: routePath, source }) => RESOURCE_ROUTE.test(routePath) && BARE_WITH_USER_CALL.test(source));

    // The 2026-08-12 backfill audit found 30 routes the old changed-file,
    // wrapper-name-only gate had never judged. Keep the census live without
    // making ordinary additions fail merely because the number grew.
    expect(candidates.length).toBeGreaterThanOrEqual(30);

    const unsafe = candidates
      .filter(({ path: routePath, source }) => !resourceRouteHasAuthorizationEvidence(routePath, source))
      .map(({ path: routePath }) => `  - ${routePath}`)
      .sort();

    expect(
      unsafe.join("\n"),
      "\nBare withUser resource routes with no recognized authorization evidence:\n",
    ).toBe("");
  });

  it.each(FIXTURES)("$name", ({ path: routePath, source, safe }) => {
    expect(resourceRouteHasAuthorizationEvidence(routePath, source)).toBe(safe);
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * S4's architectural tripwire (security-authz.plan.md slice 6). Ownership in
 * this app lives in application queries — there is no owner-aware repository
 * layer and no RLS — so one missed predicate on one mutation is a full IDOR.
 * This test turns that class of mistake into a failing build instead of a
 * breach: it statically scans every `src/app/api/**\/route.ts` for drizzle
 * `.update(` / `.delete(` chains and requires each to be owner-scoped, either
 * inline or through a verified owner-asserting helper.
 *
 * Deliberately a cheap line-based scanner, not an AST pass: no parser
 * dependency, no DB, no env — it runs under `pnpm test`. Precision comes from
 * being conservative (a statement window plus a named helper list), and the
 * escape hatch is an explicit, justified allow-list rather than a loosened
 * matcher.
 *
 * RLS remains open question OQ1 in the plan — this guardrail is the pragmatic
 * middle, not a decision against it.
 */

/** Route files live under this directory; vitest runs with CWD at the pnpm root. */
const API_DIR = path.join(process.cwd(), "src/app/api");

/**
 * Ownership evidence accepted *inside the mutation statement itself* — the
 * `where` names the owner column, or the handler's session user id.
 */
const INLINE_OWNERSHIP_TOKENS = [/\bownerId\b/, /\bowner_id\b/, /\buser\.id\b/];

/**
 * Owner-asserting helpers: each re-reads its row with `owner_id = :userId` and
 * makes the route 404 on a miss, so a mutation guarded by one is owner-scoped
 * even when its own `where` keys on an id. Verified 2026-07-26; a helper only
 * counts when the call passes `user.id`.
 */
const OWNER_ASSERTING_HELPERS = [
  "loadOwnedChat", // src/app/api/chats/owned.ts — chat + roster, owner-scoped
  "requireSimChat", // src/app/api/chats/[chatId]/sim-shared.ts — wraps loadOwnedChat
  "findOwnedCharacter", // src/app/api/characters/[id]/owned.ts
  "findPortrait", // characters/[id]/portraits/[imageId]/route.ts — images by owner + entity
  "ownedCharacter", // characters/[id]/relationships/route.ts
  "findItem", // items/[id]/route.ts
  "findLocation", // locations/[id]/route.ts
  "findPersona", // personas/[id]/route.ts
  "findCard", // social-cards/[id]/route.ts
] as const;

/**
 * The genuine exceptions, each verified safe by reading the route. An entry is
 * scoped to one table in one file so it can never blanket-exempt a future
 * mutation added beside it. Stale entries fail too — a removed mutation must
 * take its exemption with it.
 */
const ALLOW_LIST: readonly { file: string; table: string; reason: string }[] = [
  {
    file: "src/app/api/admin/sim/shadow/[chatId]/route.ts",
    table: "simShadowDivergences",
    reason:
      "admin-gated: the handler 404s unless user.role === 'admin', and a divergence verdict is operator triage data, not user-owned content",
  },
  {
    file: "src/app/api/chats/[chatId]/sim-command/route.ts",
    table: "simCommandRequests",
    reason:
      "private module helpers (markRequestFailed / runIdempotent) writing the idempotency ledger for a chatId the sole caller (POST) already gated through requireSimChat(chatId, user.id)",
  },
  {
    file: "src/app/api/successor-chats/[chatId]/route.ts",
    table: "simWorlds",
    reason:
      "world id is derived from the owner-checked chat (characterChats.ownerId = user.id) via its engine authority's branch, so the row is reached only through an owner-verified parent",
  },
];

/** A drizzle mutation: `.update(table)` / `.delete(table)` with a bare table identifier. */
const MUTATION_CALL = /\.(update|delete)\(\s*([A-Za-z_$][\w$]*)\s*\)/;

/** Chain roots that make a call a database write rather than e.g. `searchParams.delete("q")`. */
const DB_RECEIVER = /\bdb\(\)|\btx\b/;

/** Top-level declaration — the enclosing route handler or module helper. */
const TOP_LEVEL_DECL = /^(?:export\s+)?(?:const|let|async\s+function|function)\s/;

/** How far back a chain's `db()` / `tx` receiver may sit above the mutation line. */
const STATEMENT_LOOKBEHIND = 3;

/** Upper bound on a single statement, so a missing `;` can never run away. */
const STATEMENT_MAX_LINES = 60;

interface MutationSite {
  /** Repo-relative, POSIX-separated. */
  file: string;
  /** 1-based line of the `.update(` / `.delete(` call. */
  line: number;
  table: string;
  /** Ownership evidence inside the statement itself. */
  inline: boolean;
  /** Name of the owner-asserting helper guarding the enclosing function, if any. */
  helper: string | undefined;
}

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, acc);
    else if (entry.name === "route.ts") acc.push(full);
  }
  return acc;
}

/** True when `line` cannot be a continuation of the statement below it. */
function endsStatement(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return true;
  return /[;{},]$/.test(trimmed);
}

function scanFile(file: string, source: string): MutationSite[] {
  const lines = source.split("\n");
  const sites: MutationSite[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const call = MUTATION_CALL.exec(lines[i] ?? "");
    if (!call) continue;

    // Walk back to the chain root (`const [row] = await db()` / `await tx`),
    // stopping at the first line that cannot be a continuation.
    let start = i;
    for (let back = 0; back < STATEMENT_LOOKBEHIND; back += 1) {
      if (start === 0 || endsStatement(lines[start - 1] ?? "")) break;
      start -= 1;
    }
    // Then forward to the statement's terminating semicolon.
    let end = start;
    while (end + 1 < lines.length && end - start < STATEMENT_MAX_LINES && !/;\s*$/.test(lines[end] ?? "")) end += 1;

    const statement = lines.slice(start, end + 1).join("\n");
    if (!DB_RECEIVER.test(statement)) continue; // not a drizzle write (Map/Headers/URLSearchParams)

    // The enclosing route handler or module-level helper, for helper evidence.
    let decl = start;
    while (decl > 0 && !TOP_LEVEL_DECL.test(lines[decl] ?? "")) decl -= 1;
    const scope = lines.slice(decl, end + 1).join("\n");

    sites.push({
      file,
      line: i + 1,
      table: call[2] ?? "",
      inline: INLINE_OWNERSHIP_TOKENS.some((token) => token.test(statement)),
      helper: OWNER_ASSERTING_HELPERS.find((name) =>
        new RegExp(String.raw`\b${name}\s*\([^)]*user\.id`).test(scope),
      ),
    });
  }
  return sites;
}

function collectSites(): MutationSite[] {
  if (!fs.existsSync(API_DIR)) return []; // let the discovery assertion below report it
  return routeFiles(API_DIR)
    .sort()
    .flatMap((abs) => scanFile(path.relative(process.cwd(), abs).split(path.sep).join("/"), fs.readFileSync(abs, "utf8")));
}

const FIX_INSTRUCTIONS = [
  "Every mutation in a route handler must be owner-scoped. Fix one of these ways:",
  "  1. Add the ownership predicate to the statement's own where clause",
  "     (e.g. `and(eq(table.id, id), eq(table.ownerId, user.id))`) — preferred.",
  "  2. Route the write through an owner-asserting helper called with `user.id`",
  "     in the same function (findOwnedCharacter / loadOwnedChat / requireSimChat",
  "     are the models; add the new helper's name to OWNER_ASSERTING_HELPERS here",
  "     once it re-reads its row with `owner_id = :userId` and 404s on a miss).",
  "  3. Rarely — the write is genuinely not user-owned (admin-gated operator data,",
  "     or a row reached only through an owner-verified parent). Add an ALLOW_LIST",
  "     entry in this file with a one-line reason naming why it is safe.",
  "See docs/developer-notes/security-authz.plan.md slice 6 (S4).",
].join("\n");

describe("route-layer ownership guardrail (security-authz S4)", () => {
  const sites = collectSites();

  it("finds the route mutations it is meant to police", () => {
    // A scanner that silently matches nothing is worse than no scanner: this
    // pins that route discovery and the mutation matcher are both still live.
    expect(fs.existsSync(API_DIR)).toBe(true);
    expect(sites.length).toBeGreaterThan(20);
  });

  it("scopes every route mutation to the owner", () => {
    const unscoped = sites
      .filter((site) => !site.inline && site.helper === undefined)
      .filter((site) => !ALLOW_LIST.some((entry) => entry.file === site.file && entry.table === site.table))
      .map((site) => `  ${site.file}:${site.line} — .${site.table} write has no ownership predicate`);

    expect(unscoped.join("\n"), `\n${unscoped.length} unscoped route mutation(s):\n\n${FIX_INSTRUCTIONS}\n`).toBe("");
  });

  it("keeps the allow-list free of stale exemptions", () => {
    const stale = ALLOW_LIST.filter(
      (entry) =>
        !sites.some(
          (site) => site.file === entry.file && site.table === entry.table && !site.inline && site.helper === undefined,
        ),
    ).map((entry) => `  ${entry.file} (${entry.table})`);

    expect(
      stale.join("\n"),
      "\nALLOW_LIST entries no longer matching an unscoped mutation — the write was removed or is now owner-scoped inline. Delete the entry.\n",
    ).toBe("");
  });

  it("documents a reason for every exemption", () => {
    for (const entry of ALLOW_LIST) {
      expect(entry.reason.length, `${entry.file} needs a justifying reason`).toBeGreaterThan(20);
    }
  });
});

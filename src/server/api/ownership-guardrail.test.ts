import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * S4's architectural tripwire (security-authz.plan.md slice 6). Ownership in
 * this app lives in application queries — there is no owner-aware repository
 * layer and no RLS — so one missed predicate on one mutation is a full IDOR.
 * This test turns that class of mistake into a failing build: it statically
 * scans every `src/app/api/**\/route.ts` for drizzle `.update(` / `.delete(`
 * chains and requires each to be owner-scoped, either inside its own `where`
 * or through a verified owner-asserting helper — and it pins the simulation
 * layer's shell invariant, which is where the successor lane's writes live.
 *
 * **This is a regression tripwire, not a proof of semantic authorization.** It
 * checks that SOME ownership evidence sits in the RIGHT POSITION — an owner
 * token inside the mutation's own `.where(...)` argument, or an owner-asserting
 * helper called with `user.id` and actually branched on before the write. It
 * cannot tell whether the predicate is *correct*: `eq(t.ownerId, someoneElse)`
 * passes, and so does a helper that checks the wrong row. What it does catch is
 * the shape that has actually shipped bugs elsewhere — a write keyed on a
 * bare id with no owner condition anywhere near it. Semantic coverage is the
 * job of `src/server/api/authz-matrix.int.test.ts` (the two-user matrix), not
 * of this file.
 *
 * Deliberately a text scanner, not an AST pass: no parser dependency, no DB,
 * no env — it runs under `pnpm test`. Precision comes from parsing *just
 * enough* (comment stripping + balanced-delimiter extraction) that a token in
 * `.set({ ownerId })`, `.returning({ ownerId })` or a comment can no longer
 * satisfy the check. The escape hatch is an explicit, justified allow-list
 * rather than a loosened matcher.
 *
 * RLS remains open question OQ1 in the plan — this guardrail is the pragmatic
 * middle, not a decision against it.
 */

/** Route files live under this directory; vitest runs with CWD at the pnpm root. */
const API_DIR = path.join(process.cwd(), "src/app/api");

/** The successor lane's write surface — every branch mutation funnels through here. */
const SIM_DIR = path.join(process.cwd(), "src/server/engine/simulation");

/**
 * Ownership evidence accepted *inside the mutation's own `where` argument* —
 * the predicate names the owner column, or the handler's session user id.
 */
const INLINE_OWNERSHIP_TOKENS = [/\bownerId\b/, /\bowner_id\b/, /\buser\.id\b/];

/**
 * Owner-asserting helpers: each re-reads its row with `owner_id = :userId` and
 * makes the route 404 on a miss, so a mutation guarded by one is owner-scoped
 * even when its own `where` keys on an id. Every entry re-read and re-verified
 * 2026-07-26 (the portraits/personas/chats lookups moved into extracted
 * `owned.ts` modules for slice 5's authorization matrix — paths below are the
 * current ones). A helper only counts when the call passes `user.id` *and* its
 * result is branched on before the write (see `helperGuardBefore`).
 */
const OWNER_ASSERTING_HELPERS = [
  "loadOwnedChat", // src/app/api/chats/owned.ts — chat + roster, `characterChats.ownerId = userId`
  "loadOwnedRoster", // src/app/api/chats/owned.ts — every requested character, `characters.ownerId = userId`
  "requireSimChat", // src/app/api/chats/[chatId]/sim-shared.ts — wraps loadOwnedChat, then the authority read
  "findOwnedCharacter", // src/app/api/characters/[id]/owned.ts
  "findPortrait", // src/app/api/characters/[id]/portraits/owned.ts — image by owner + parent entity
  "ownedCharacter", // src/app/api/characters/[id]/relationships/route.ts
  "findItem", // src/app/api/items/[id]/route.ts
  "findLocation", // src/app/api/locations/[id]/route.ts
  "findPersona", // src/app/api/personas/[id]/owned.ts
  "findCard", // src/app/api/social-cards/[id]/route.ts
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

/** How far below a null-check the early `return` / `throw` may sit. */
const GUARD_EXIT_LOOKAHEAD = 3;

/* ------------------------------------------------------------------------ *
 * Text primitives — the "parse just enough" layer.                          *
 * ------------------------------------------------------------------------ */

/**
 * Blank every comment, preserving offsets and line breaks so line numbers and
 * slices still line up. String literals are deliberately LEFT INTACT: a raw
 * `sql`owner_id = ...`` predicate is genuine ownership evidence, and blanking
 * it would turn a scoped write into a false failure. The cost is that a literal
 * string containing "ownerId" would count — a shape that does not exist in the
 * tree and would be a bizarre way to write a predicate.
 */
function stripComments(source: string): string {
  const out = source.split("");
  let mode: "code" | "line" | "block" | "quote" = "code";
  let quote = "";
  for (let i = 0; i < out.length; i += 1) {
    const c = out[i] ?? "";
    const next = out[i + 1] ?? "";
    if (mode === "code") {
      if (c === "/" && (next === "/" || next === "*")) {
        mode = next === "/" ? "line" : "block";
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
      } else if (c === '"' || c === "'" || c === "`") {
        mode = "quote";
        quote = c;
      }
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      else out[i] = " ";
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
        mode = "code";
      } else if (c !== "\n") {
        out[i] = " ";
      }
      continue;
    }
    // quote: only the matching delimiter closes it; escapes consume the next char.
    if (c === "\\") i += 1;
    else if (c === quote) mode = "code";
  }
  return out.join("");
}

/**
 * Index of the delimiter closing the one at `open`, skipping string literals so
 * a paren or brace inside a literal cannot unbalance the count. `-1` when the
 * text runs out first (a truncated statement window).
 */
function matchDelimiter(text: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i += 1) {
    const c = text[i] ?? "";
    if (quote !== "") {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === openChar) depth += 1;
    else if (c === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The argument text of the call whose `(` sits at `open`. */
function callArguments(text: string, open: number): string {
  const close = matchDelimiter(text, open, "(", ")");
  // Unbalanced means the statement window was cut short. Return the tail rather
  // than nothing: this test's first duty is zero false failures.
  return close === -1 ? text.slice(open + 1) : text.slice(open + 1, close);
}

/** Every `.where(...)` argument in a statement, comments already blanked. */
function whereArguments(statement: string): string[] {
  const stripped = stripComments(statement);
  const spans: string[] = [];
  const call = /\.where\s*\(/g;
  let match = call.exec(stripped);
  while (match !== null) {
    spans.push(callArguments(stripped, match.index + match[0].length - 1));
    match = call.exec(stripped);
  }
  return spans;
}

/**
 * The mutation is owner-scoped by its own predicate. Only the `.where(...)`
 * argument counts — `.set({ ownerId: user.id })`, `.returning({ ownerId })` and
 * a trailing comment all sit outside it, and a statement with no `.where(` at
 * all is unscoped by construction (drizzle updates/deletes without a `where`
 * hit the whole table).
 */
function hasWhereOwnership(statement: string): boolean {
  return whereArguments(statement).some((span) => INLINE_OWNERSHIP_TOKENS.some((token) => token.test(span)));
}

/* ------------------------------------------------------------------------ *
 * Helper-guard detection.                                                    *
 * ------------------------------------------------------------------------ */

/**
 * Did a `return` / `throw` follow the check on line `at`? Same line first (the
 * house style — `if (!owned) return jsonError(...)`), otherwise the next few.
 */
function exitsWithin(lines: readonly string[], at: number): boolean {
  for (let i = at; i <= at + GUARD_EXIT_LOOKAHEAD && i < lines.length; i += 1) {
    if (/\breturn\b|\bthrow\b/.test(lines[i] ?? "")) return true;
  }
  return false;
}

/**
 * Is the helper's RESULT actually load-bearing? Calling an owner-asserting
 * helper and ignoring what it returns proves nothing, so evidence of a branch
 * is required. Three shapes are recognized, matching what the tree writes:
 *
 *   a. the call is itself negated — `if (!(await ownedCharacter(id, user.id))) return …`
 *   b. the call is bound and null-checked — `const owned = await loadOwnedChat(…)`
 *      followed by `if (!owned) return …` / `if (!gate.ok) return …` /
 *      `if (owned === undefined) throw …`
 *   c. the bound name feeds a ternary or `??` — `existing ?? jsonError(…)`,
 *      `owned ? a : b`
 *
 * **Approximations, on purpose.** (c) accepts the expression as a guard without
 * proving the mutation sits on its safe branch, and (b) does not verify that
 * the early exit belongs to the null-check's own block rather than a nearby
 * one. Both are looser than a control-flow analysis would be; the direction of
 * the error is a false PASS on contrived code, never a false failure on real
 * code. A positive `if (guard) { … mutate … }` block is NOT recognized — write
 * the early-exit shape or take an allow-list entry.
 */
function resultIsGuarded(lines: readonly string[], callLine: number): boolean {
  const line = lines[callLine] ?? "";
  // (a) the call is the condition.
  if (/\bif\s*\(\s*!/.test(line) && exitsWithin(lines, callLine)) return true;

  const binding = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
  if (!binding) return false;
  const name = binding[1] ?? "";
  const negated = new RegExp(String.raw`\bif\s*\(\s*!\s*${name}\b`);
  const compared = new RegExp(String.raw`\bif\s*\(\s*${name}\s*={2,3}\s*(?:null|undefined|false)\b`);
  const chosen = new RegExp(String.raw`\b${name}\s*\?\??(?!\.)`);
  for (let i = callLine; i < lines.length; i += 1) {
    const candidate = lines[i] ?? "";
    // (b) null-check with an early exit.
    if ((negated.test(candidate) || compared.test(candidate)) && exitsWithin(lines, i)) return true;
    // (c) ternary / nullish guard. Skipped on the call line itself, where `?.`
    // and the call's own arguments would read as a false positive.
    if (i > callLine && chosen.test(candidate)) return true;
  }
  return false;
}

/**
 * The owner-asserting helper guarding this mutation, if any: invoked with
 * `user.id`, inside the same enclosing top-level declaration, on a line ABOVE
 * the mutation, with its result branched on.
 *
 * "Same enclosing declaration" means the module-level handler (`export const
 * PATCH = withUser(...)`), not the innermost arrow function — several handlers
 * legitimately mutate from inside a nested `void (async () => …)` continuation
 * whose guard was proven by the handler that opened it.
 */
function helperGuardBefore(scopeBeforeMutation: string): string | undefined {
  const stripped = stripComments(scopeBeforeMutation);
  const lines = stripped.split("\n");
  for (const helper of OWNER_ASSERTING_HELPERS) {
    const call = new RegExp(String.raw`\b${helper}\s*\(`, "g");
    let match = call.exec(stripped);
    while (match !== null) {
      const open = match.index + match[0].length - 1;
      if (/\buser\.id\b/.test(callArguments(stripped, open))) {
        const callLine = stripped.slice(0, match.index).split("\n").length - 1;
        if (resultIsGuarded(lines, callLine)) return helper;
      }
      match = call.exec(stripped);
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------------ *
 * The scanner.                                                               *
 * ------------------------------------------------------------------------ */

type Verdict = "where-owned" | "helper-guarded" | "unscoped";

interface MutationSite {
  /** Repo-relative, POSIX-separated. */
  file: string;
  /** 1-based line of the `.update(` / `.delete(` call. */
  line: number;
  table: string;
  /** Ownership evidence inside the statement's own `where` argument. */
  whereOwned: boolean;
  /** Name of the owner-asserting helper guarding the enclosing declaration, if any. */
  helper: string | undefined;
}

function verdictOf(site: MutationSite): Verdict {
  if (site.whereOwned) return "where-owned";
  return site.helper === undefined ? "unscoped" : "helper-guarded";
}

/** True when `line` cannot be a continuation of the statement below it. */
function endsStatement(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return true;
  return /[;{},]$/.test(trimmed);
}

/** Classify every drizzle mutation in one source file. Pure — the fixtures drive this directly. */
function scanSource(file: string, source: string): MutationSite[] {
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

    // The enclosing route handler or module-level helper, up to (not including)
    // the mutation statement — a helper call BELOW the write guards nothing.
    let decl = start;
    while (decl > 0 && !TOP_LEVEL_DECL.test(lines[decl] ?? "")) decl -= 1;

    sites.push({
      file,
      line: i + 1,
      table: call[2] ?? "",
      whereOwned: hasWhereOwnership(statement),
      helper: helperGuardBefore(lines.slice(decl, start).join("\n")),
    });
  }
  return sites;
}

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, acc);
    else if (entry.name === "route.ts") acc.push(full);
  }
  return acc;
}

function repoRelative(absolute: string): string {
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

function collectSites(): MutationSite[] {
  if (!fs.existsSync(API_DIR)) return []; // let the discovery assertion below report it
  return routeFiles(API_DIR)
    .sort()
    .flatMap((abs) => scanSource(repoRelative(abs), fs.readFileSync(abs, "utf8")));
}

const FIX_INSTRUCTIONS = [
  "Every mutation in a route handler must be owner-scoped. Fix one of these ways:",
  "  1. Put the ownership predicate in the statement's own where clause",
  "     (e.g. `and(eq(table.id, id), eq(table.ownerId, user.id))`) — preferred.",
  "     Only `.where(...)` counts: a token in `.set(...)`, `.returning(...)` or a",
  "     comment is not a predicate, and a write with no `.where(` hits every row.",
  "  2. Route the write through an owner-asserting helper called with `user.id`",
  "     ABOVE the mutation in the same handler, and branch on its result",
  "     (`const owned = await loadOwnedChat(chatId, user.id); if (!owned) return …`).",
  "     findOwnedCharacter / loadOwnedChat / requireSimChat are the models; add a",
  "     new helper's name to OWNER_ASSERTING_HELPERS here once it re-reads its row",
  "     with `owner_id = :userId` and 404s on a miss.",
  "  3. Rarely — the write is genuinely not user-owned (admin-gated operator data,",
  "     or a row reached only through an owner-verified parent). Add an ALLOW_LIST",
  "     entry in this file with a one-line reason naming why it is safe.",
  "See docs/developer-notes/security-authz.plan.md slice 6 (S4).",
].join("\n");

/* ------------------------------------------------------------------------ *
 * Simulation layer: the shell invariant.                                     *
 * ------------------------------------------------------------------------ */

/**
 * The successor lane cannot be scanned the way routes are: `sim_*` tables carry
 * no owner column at all (a branch is owned transitively, through the chat that
 * anchors it), so a token scan there would be nothing but false positives. The
 * invariant that actually holds is structural — every durable branch write goes
 * through one of four command shells, and each shell proves ownership via
 * `authorizeSimulationCommand` BEFORE it reads or writes anything
 * (security-authz.plan.md §Follow-ups 1; the helper itself is
 * `src/server/engine/simulation/command-authz.ts`, re-verified 2026-07-26 —
 * it resolves the branch's anchoring chat and compares `characterChats.ownerId`
 * to the command principal).
 */
const SIM_SHELLS: readonly { name: string; file: string }[] = [
  { name: "runSimulationCommand", file: "command-runner.ts" },
  { name: "submitDurableMoveActor", file: "space-store.ts" },
  { name: "submitDurableJourneyArrival", file: "space-store.ts" },
  { name: "submitDurableTriggerSchedule", file: "scheduler-store.ts" },
];

const SIM_SHELL_NAMES = SIM_SHELLS.map((shell) => shell.name);

/** The first branch write a shell may perform: the locked transaction or a bare DML call. */
const SIM_WRITE_CALL = /\.transaction\s*\(|\.(?:insert|update|delete)\s*\(/;

/** Exported durable command entry points — the shells plus everything that must delegate to one. */
const DURABLE_EXPORT = /^export\s+async\s+function\s+(submitDurable[A-Za-z0-9_$]*)\b/gm;

/**
 * The body of `export async function <name>`, brace-matched. Generic parameter
 * lists (`<TResult extends { status: … }>`) carry braces of their own, so the
 * body's `{` is the first one seen at angle- AND paren-depth zero.
 */
function functionBody(source: string, name: string): string | undefined {
  const stripped = stripComments(source);
  const decl = new RegExp(String.raw`export\s+async\s+function\s+${name}\b`).exec(stripped);
  if (!decl) return undefined;
  let angle = 0;
  let paren = 0;
  let open = -1;
  for (let i = decl.index + decl[0].length; i < stripped.length; i += 1) {
    const c = stripped[i] ?? "";
    if (c === "<") angle += 1;
    else if (c === ">" && angle > 0) angle -= 1;
    else if (c === "(") paren += 1;
    else if (c === ")") paren -= 1;
    else if (c === "{" && angle === 0 && paren === 0) {
      open = i;
      break;
    }
  }
  if (open === -1) return undefined;
  const close = matchDelimiter(stripped, open, "{", "}");
  return close === -1 ? stripped.slice(open) : stripped.slice(open, close + 1);
}

/** 0-based index of the first line matching `pattern`, or `-1`. */
function firstLineMatching(body: string, pattern: RegExp): number {
  return body.split("\n").findIndex((line) => pattern.test(line));
}

function simulationSources(): { file: string; source: string }[] {
  if (!fs.existsSync(SIM_DIR)) return [];
  return fs
    .readdirSync(SIM_DIR)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .sort()
    .map((name) => ({ file: name, source: fs.readFileSync(path.join(SIM_DIR, name), "utf8") }));
}

/* ------------------------------------------------------------------------ *
 * Fixtures — the classifier's own regression tests.                          *
 * ------------------------------------------------------------------------ */

/** `ownerId` in `.set(...)` is a value being written, not a predicate. */
const FIXTURE_TOKEN_IN_SET = `
export const PATCH = withUser(async (user, req, ctx) => {
  db().update(characters).set({ ownerId: user.id }).where(eq(characters.id, id));
});
`;

/** `ownerId` in `.returning(...)` is a column being read back. */
const FIXTURE_TOKEN_IN_RETURNING = `
export const DELETE = withUser(async (user, _req, ctx) => {
  db().delete(characters).where(eq(characters.id, id)).returning({ ownerId: characters.ownerId });
});
`;

/** A claim in a comment is not a predicate — trailing and inline, both blanked. */
const FIXTURE_TOKEN_IN_COMMENT = `
export const DELETE = withUser(async (user, _req, ctx) => {
  await db().delete(items).where(/* ownerId proven above */ eq(items.id, id)); // user.id checked by the caller
});
`;

/** No `where` at all: an update that hits every row in the table. */
const FIXTURE_NO_WHERE = `
export const DELETE = withUser(async (user, _req, ctx) => {
  await db().delete(items);
});
`;

/** The helper never sees `user.id`, so it asserts nothing about this caller. */
const FIXTURE_HELPER_WITHOUT_USER = `
export const PATCH = withUser(async (user, req, ctx) => {
  const owned = await loadOwnedChat(chatId, body.value.ownerId);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  await db().update(characterChats).set({ title }).where(eq(characterChats.id, chatId));
});
`;

/** Called, but the answer is thrown away — no branch, no guard. */
const FIXTURE_HELPER_RESULT_IGNORED = `
export const PATCH = withUser(async (user, req, ctx) => {
  const owned = await loadOwnedChat(chatId, user.id);
  await db().update(characterChats).set({ title }).where(eq(characterChats.id, chatId));
  if (!owned) return jsonError("not_found", "chat not found", 404);
});
`;

/** The guard runs after the write — too late to stop it. */
const FIXTURE_HELPER_AFTER_MUTATION = `
export const PATCH = withUser(async (user, req, ctx) => {
  await db().update(characterChats).set({ title }).where(eq(characterChats.id, chatId));
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
});
`;

/** The owner predicate where it belongs. */
const FIXTURE_WHERE_OWNED = `
export const PATCH = withUser(async (user, req, ctx) => {
  await db().update(items).set(update).where(and(eq(items.id, id), eq(items.ownerId, user.id)));
});
`;

/** Same, wrapped across lines — the span extraction is not line-based. */
const FIXTURE_WHERE_OWNED_MULTILINE = `
export const PATCH = withUser(async (user, req, ctx) => {
  const [row] = await db()
    .update(items)
    .set(update)
    .where(
      and(
        eq(items.id, id),
        eq(items.ownerId, user.id),
      ),
    )
    .returning();
});
`;

/** Bind, null-check, early return — the house shape. */
const FIXTURE_HELPER_GUARDED = `
export const PATCH = withUser(async (user, req, ctx) => {
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  await db().update(characterChats).set({ title }).where(eq(characterChats.id, chatId));
});
`;

/** The negated-call shape, with no binding at all. */
const FIXTURE_HELPER_GUARDED_INLINE = `
export const DELETE = withUser(async (user, _req, ctx) => {
  if (!(await loadOwnedChat(chatId, user.id))) return jsonError("not_found", "chat not found", 404);
  await db().delete(characterChatMessages).where(eq(characterChatMessages.id, messageId));
});
`;

/** A guard proven by the handler, a write issued from its nested continuation. */
const FIXTURE_HELPER_GUARDED_NESTED = `
export const POST = withUser(async (user, req, ctx) => {
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  void (async () => {
    await db()
      .update(characterChats)
      .set({ lastReplyFailure: failure })
      .where(eq(characterChats.id, chatId));
  })();
});
`;

function fixtureVerdicts(source: string): Verdict[] {
  return scanSource("fixture.ts", source).map(verdictOf);
}

/* ------------------------------------------------------------------------ *
 * Tests.                                                                     *
 * ------------------------------------------------------------------------ */

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
      .filter((site) => verdictOf(site) === "unscoped")
      .filter((site) => !ALLOW_LIST.some((entry) => entry.file === site.file && entry.table === site.table))
      .map((site) => `  ${site.file}:${site.line} — .${site.table} write has no ownership predicate`);

    expect(unscoped.join("\n"), `\n${unscoped.length} unscoped route mutation(s):\n\n${FIX_INSTRUCTIONS}\n`).toBe("");
  });

  it("keeps the allow-list free of stale exemptions", () => {
    const stale = ALLOW_LIST.filter(
      (entry) =>
        !sites.some(
          (site) => site.file === entry.file && site.table === entry.table && verdictOf(site) === "unscoped",
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

  it("keeps every bucket of the census populated", () => {
    // Baseline census, 2026-07-26 (18 route files): 31 mutation sites —
    // 14 owner-scoped by their own `where`, 13 helper-guarded, 4 allow-listed
    // across 3 allow-list entries (the sim-command file contributes two sites
    // under one entry). Asserted as shape rather than exact counts so adding a
    // properly-scoped route does not fail the build; the numbers are here as
    // the record of what the scanner saw when it was rewritten.
    const byVerdict = (want: Verdict) => sites.filter((site) => verdictOf(site) === want).length;
    expect(byVerdict("where-owned") + byVerdict("helper-guarded") + byVerdict("unscoped")).toBe(sites.length);
    expect(byVerdict("where-owned")).toBeGreaterThan(8);
    expect(byVerdict("helper-guarded")).toBeGreaterThan(8);
    // Every unscoped site is allow-listed, and every allow-list entry is used —
    // both directions are asserted above; this pins that the bucket is small.
    expect(byVerdict("unscoped")).toBeLessThan(8);
  });
});

describe("ownership classifier (fixtures)", () => {
  it("rejects an ownership token outside the where clause", () => {
    expect(fixtureVerdicts(FIXTURE_TOKEN_IN_SET)).toEqual(["unscoped"]);
    expect(fixtureVerdicts(FIXTURE_TOKEN_IN_RETURNING)).toEqual(["unscoped"]);
    expect(fixtureVerdicts(FIXTURE_TOKEN_IN_COMMENT)).toEqual(["unscoped"]);
  });

  it("rejects a mutation with no where clause at all", () => {
    expect(fixtureVerdicts(FIXTURE_NO_WHERE)).toEqual(["unscoped"]);
  });

  it("rejects a helper that is not a guard", () => {
    expect(fixtureVerdicts(FIXTURE_HELPER_WITHOUT_USER)).toEqual(["unscoped"]);
    expect(fixtureVerdicts(FIXTURE_HELPER_RESULT_IGNORED)).toEqual(["unscoped"]);
    expect(fixtureVerdicts(FIXTURE_HELPER_AFTER_MUTATION)).toEqual(["unscoped"]);
  });

  it("accepts an owner predicate inside the where clause", () => {
    expect(fixtureVerdicts(FIXTURE_WHERE_OWNED)).toEqual(["where-owned"]);
    expect(fixtureVerdicts(FIXTURE_WHERE_OWNED_MULTILINE)).toEqual(["where-owned"]);
  });

  it("accepts a mutation guarded by an owner-asserting helper", () => {
    expect(fixtureVerdicts(FIXTURE_HELPER_GUARDED)).toEqual(["helper-guarded"]);
    expect(fixtureVerdicts(FIXTURE_HELPER_GUARDED_INLINE)).toEqual(["helper-guarded"]);
    expect(fixtureVerdicts(FIXTURE_HELPER_GUARDED_NESTED)).toEqual(["helper-guarded"]);
  });
});

describe("simulation command-shell invariant (security-authz S4)", () => {
  const sources = simulationSources();
  const byFile = new Map(sources.map((entry) => [entry.file, entry.source]));

  it("finds the simulation stores it is meant to police", () => {
    expect(fs.existsSync(SIM_DIR)).toBe(true);
    expect(sources.length).toBeGreaterThan(20);
  });

  it("proves ownership in every command shell before it reads or writes", () => {
    const violations: string[] = [];
    for (const shell of SIM_SHELLS) {
      const source = byFile.get(shell.file);
      const body = source === undefined ? undefined : functionBody(source, shell.name);
      if (body === undefined) {
        violations.push(`  ${shell.file} — ${shell.name} not found (renamed or moved?)`);
        continue;
      }
      const authorized = firstLineMatching(body, /\bauthorizeSimulationCommand\s*\(/);
      const written = firstLineMatching(body, SIM_WRITE_CALL);
      if (authorized === -1) {
        violations.push(`  ${shell.file} — ${shell.name} never calls authorizeSimulationCommand`);
      } else if (written !== -1 && authorized > written) {
        violations.push(`  ${shell.file} — ${shell.name} writes before it authorizes`);
      }
    }

    expect(
      violations.join("\n"),
      [
        "\nsim_* tables have no owner column, so a branch write is authorized structurally:",
        "every durable command shell must call authorizeSimulationCommand(...) above its",
        "first transaction/insert/update. See security-authz.plan.md slice 6 + §Follow-ups 1.\n",
      ].join("\n"),
    ).toBe("");
  });

  it("routes every other durable submit through one of the shells", () => {
    const delegatesToShell = new RegExp(String.raw`\b(?:${SIM_SHELL_NAMES.join("|")})\s*[(<]`);
    const violations: string[] = [];
    let found = 0;
    for (const { file, source } of sources) {
      const stripped = stripComments(source);
      DURABLE_EXPORT.lastIndex = 0;
      let match = DURABLE_EXPORT.exec(stripped);
      while (match !== null) {
        const name = match[1] ?? "";
        found += 1;
        const body = SIM_SHELL_NAMES.includes(name) ? undefined : functionBody(source, name);
        if (body !== undefined && !delegatesToShell.test(body)) {
          violations.push(`  ${file} — ${name} does not delegate to a command shell`);
        }
        match = DURABLE_EXPORT.exec(stripped);
      }
    }

    expect(found).toBeGreaterThan(20); // the matcher still sees the durable surface
    expect(
      violations.join("\n"),
      [
        "\nA durable submit that does not go through runSimulationCommand (or one of the",
        "three stores that still keep an inlined copy of the shell) has no ownership gate",
        "at all — it would accept any principal for any branch. Call the shell.",
        "See security-authz.plan.md slice 6 + §Follow-ups 1.\n",
      ].join("\n"),
    ).toBe("");
  });
});

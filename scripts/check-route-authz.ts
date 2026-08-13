import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Route-handler wrappers that carry the ownership (or admin/support) check
 * themselves, all exported from `apps/web/src/server/api/authz.ts`.
 *
 * Exported so `scripts/ownership-guardrail.test.ts` can cross-check this list
 * against its hand-maintained row-lookup helper list. The two lists describe
 * different mechanisms and deliberately stay disjoint.
 */
export const APPROVED_ROUTE_AUTHZ_WRAPPERS = [
  "withOwnedChat",
  "withOwnedEntity",
  "withOwnerAdmin",
  "withOwnerAdminResource",
  "withOwnerAdminOwnedChat",
  "withCrossAccountSupport",
  "withAuthorizedResource",
] as const;

/**
 * Audited authorization seams that a resource-ID handler may call from inside
 * bare `withUser`. Unlike the old wrapper regex, a name alone is NOT evidence:
 * the call must receive both `user.id` and one of the route's path parameters,
 * and its result must be load-bearing in an immediate early-return/throw guard.
 *
 * Most are owner-strict lookups. `findViewable` and `cloneToLibrary` are the
 * intentional owner-or-public seams for shareable library resources.
 */
export const APPROVED_ROUTE_AUTHZ_HELPERS = [
  "loadOwnedChat",
  "loadOwnedRoster",
  "requireSimChat",
  "findOwnedCharacter",
  "findPortrait",
  "ownedCharacter",
  "findItem",
  "findLocation",
  "findPersona",
  "findCard",
  "ownsItem",
  "ownsLocation",
  "deleteOwnedImage",
  "findViewable",
  "cloneToLibrary",
] as const;

// Anchored at the application workspace, not merely at `src/`: after the app
// moved to apps/web an unanchored pattern would still match by coincidence, and
// this gate has to fail loudly rather than keep working by accident.
export const RESOURCE_ROUTE = /^apps\/web\/src\/app\/api\/.+\/\[[^/]+\]\/.*route\.ts$/;

const WITH_USER_CALL = /\bwithUser(?:<[^>\n]+>)?\s*\(/g;
const OWNER_TOKEN = /\bowner(?:Id|_id)\b/;
const USER_ID = /\buser\.id\b/;
const GUARD_CHECK_LOOKAHEAD = 4;
const GUARD_EXIT_LOOKAHEAD = 3;

/**
 * The lint script is production tooling, so it cannot import the application's
 * test-support barrel. These tiny text primitives intentionally mirror the
 * guardrail scanner's "parse just enough" behavior: comments are blanked while
 * offsets stay stable, and call arguments are delimiter-matched rather than
 * line-matched.
 */
function stripComments(source: string): string {
  const out = source.split("");
  let mode: "code" | "line" | "block" | "quote" = "code";
  let quote = "";
  for (let i = 0; i < out.length; i += 1) {
    const char = out[i] ?? "";
    const next = out[i + 1] ?? "";
    if (mode === "code") {
      if (char === "/" && (next === "/" || next === "*")) {
        mode = next === "/" ? "line" : "block";
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
      } else if (char === '"' || char === "'" || char === "`") {
        mode = "quote";
        quote = char;
      }
      continue;
    }
    if (mode === "line") {
      if (char === "\n") mode = "code";
      else out[i] = " ";
      continue;
    }
    if (mode === "block") {
      if (char === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
        mode = "code";
      } else if (char !== "\n") {
        out[i] = " ";
      }
      continue;
    }
    if (char === "\\") i += 1;
    else if (char === quote) mode = "code";
  }
  return out.join("");
}

function matchDelimiter(text: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quote !== "") {
      if (char === "\\") i += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function callArguments(text: string, open: number): string {
  const close = matchDelimiter(text, open, "(", ")");
  return close === -1 ? text.slice(open + 1) : text.slice(open + 1, close);
}

function methodCallArguments(source: string, method: string): string[] {
  const stripped = stripComments(source);
  const spans: string[] = [];
  const call = new RegExp(String.raw`\.${method}\s*\(`, "g");
  let match = call.exec(stripped);
  while (match !== null) {
    spans.push(callArguments(stripped, match.index + match[0].length - 1));
    match = call.exec(stripped);
  }
  return spans;
}

function routeParameterNames(path: string): string[] {
  return [...path.matchAll(/\[(?:\.\.\.)?([A-Za-z_$][\w$]*)\]/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
}

/** A route parameter used as a variable, not merely the `.id` property of a table. */
function hasRouteParam(text: string, params: readonly string[]): boolean {
  return params.some((param) => new RegExp(String.raw`(?:^|[^.$\w])${param}\b`).test(text));
}

function exitsWithin(lines: readonly string[], at: number): boolean {
  for (let i = at; i <= at + GUARD_EXIT_LOOKAHEAD && i < lines.length; i += 1) {
    if (/\breturn\b|\bthrow\b/.test(lines[i] ?? "")) return true;
  }
  return false;
}

/**
 * A helper call only counts when its answer controls a nearby early exit.
 * Merely importing/calling an approved helper cannot bless the handler, and a
 * check much later in the handler is too late to be useful route-level evidence.
 */
function resultIsGuarded(lines: readonly string[], callLine: number): boolean {
  const line = lines[callLine] ?? "";
  if (/\bif\s*\(\s*!/.test(line) && exitsWithin(lines, callLine)) return true;

  const binding = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
  if (!binding) return false;
  const name = binding[1] ?? "";
  const negated = new RegExp(String.raw`\bif\s*\(\s*!\s*${name}\b`);
  const compared = new RegExp(String.raw`\bif\s*\(\s*${name}\s*={2,3}\s*(?:null|undefined|false)\b`);
  const chosen = new RegExp(String.raw`\b${name}\s*\?\??(?!\.)`);
  const last = Math.min(lines.length - 1, callLine + GUARD_CHECK_LOOKAHEAD);

  for (let i = callLine; i <= last; i += 1) {
    const candidate = lines[i] ?? "";
    if ((negated.test(candidate) || compared.test(candidate)) && exitsWithin(lines, i)) return true;
    if (i > callLine && chosen.test(candidate)) return true;
  }
  return false;
}

function hasGuardedAuthorizationHelper(source: string, params: readonly string[]): boolean {
  const stripped = stripComments(source);
  const lines = stripped.split("\n");

  for (const helper of APPROVED_ROUTE_AUTHZ_HELPERS) {
    const call = new RegExp(String.raw`\b${helper}\s*\(`, "g");
    let match = call.exec(stripped);
    while (match !== null) {
      const open = match.index + match[0].length - 1;
      const args = callArguments(stripped, open);
      if (USER_ID.test(args) && hasRouteParam(args, params)) {
        const callLine = stripped.slice(0, match.index).split("\n").length - 1;
        if (resultIsGuarded(lines, callLine)) return true;
      }
      match = call.exec(stripped);
    }
  }
  return false;
}

/**
 * Direct owner predicates are also first-class authorization evidence. Require
 * the SAME `.where(...)` span to contain the session user, an owner column, and
 * one of the route's path-parameter variables; an unrelated owned query cannot
 * satisfy the check by accident.
 */
function hasInlineOwnershipPredicate(source: string, params: readonly string[]): boolean {
  return methodCallArguments(source, "where").some(
    (span) => USER_ID.test(span) && OWNER_TOKEN.test(span) && hasRouteParam(span, params),
  );
}

function withUserBodies(source: string): string[] {
  const stripped = stripComments(source);
  const bodies: string[] = [];
  WITH_USER_CALL.lastIndex = 0;
  let match = WITH_USER_CALL.exec(stripped);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    bodies.push(callArguments(stripped, open));
    match = WITH_USER_CALL.exec(stripped);
  }
  return bodies;
}

/**
 * Whether every bare `withUser` handler in one resource-ID route carries a
 * recognized authorization seam. This is deliberately a structural tripwire,
 * not a proof of semantic authorization; the two-user matrix remains the
 * semantic regression net.
 */
export function resourceRouteHasAuthorizationEvidence(path: string, source: string): boolean {
  if (!RESOURCE_ROUTE.test(path)) return true;
  const params = routeParameterNames(path);
  const handlers = withUserBodies(source);
  if (handlers.length === 0) return true;
  return handlers.every(
    (handler) => hasGuardedAuthorizationHelper(handler, params) || hasInlineOwnershipPredicate(handler, params),
  );
}

/**
 * Paths whose CONTENT a range changed, from `git diff --name-status`.
 *
 * A pure rename (`R100`) is excluded: this gate reads route semantics rather
 * than paths, so content already judged before a directory move does not need a
 * second changed-file finding. Renames with edits and copies still count.
 */
export function contentChangedPaths(nameStatus: string): string[] {
  const files: string[] = [];
  for (const line of nameStatus.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[2]?.trim();
      if (destination !== undefined && destination !== "" && status !== "R100") files.push(destination);
      continue;
    }
    const path = fields[1]?.trim();
    if (path !== undefined && path !== "") files.push(path);
  }
  return files;
}

function changedFiles(): string[] {
  const explicitBase = process.env.ROUTE_AUTHZ_BASE;
  const candidates = explicitBase
    ? [`${explicitBase}...HEAD`]
    : ["origin/main...HEAD", "main...HEAD", "HEAD~1...HEAD"];

  for (const range of candidates) {
    try {
      const nameStatus = execFileSync(
        "git",
        ["diff", "--name-status", "--find-renames", "-l0", "--diff-filter=ACMR", range],
        { encoding: "utf8" },
      );
      return contentChangedPaths(nameStatus);
    } catch {
      // Try the next locally available base.
    }
  }
  throw new Error("could not determine a base revision for route authorization checks");
}

function main(): void {
  const unsafe: string[] = [];
  for (const path of changedFiles()) {
    if (!RESOURCE_ROUTE.test(path)) continue;
    const source = readFileSync(resolve(path), "utf8");
    if (!resourceRouteHasAuthorizationEvidence(path, source)) unsafe.push(relative(process.cwd(), path));
  }

  if (unsafe.length > 0) {
    console.error("Sensitive resource-ID routes contain bare withUser handlers with no recognized authorization evidence:");
    for (const path of unsafe) console.error(`  - ${path}`);
    console.error(
      "Use an owner-scoped wrapper, a guarded approved ownership/visibility seam, or an inline (resource id, owner id) predicate.",
    );
    process.exit(1);
  }
}

const entryPoint = process.argv[1];
const isMain =
  entryPoint !== undefined &&
  resolve(entryPoint).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main();

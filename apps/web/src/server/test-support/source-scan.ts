import fs from "node:fs";
import path from "node:path";

/**
 * The "parse just enough" text primitives the architectural tripwire tests are
 * built on (`src/server/api/ownership-guardrail.test.ts`,
 * `scripts/image-internal-callers.test.ts`), extracted so the two files stop
 * carrying their own copies of comment stripping, delimiter matching and
 * directory walking.
 *
 * Deliberately text scanners, not an AST pass: no parser dependency, no DB, no
 * env — they run under `pnpm test`. Precision comes from parsing just enough
 * that a token inside a comment or a nested call can no longer satisfy a check.
 *
 * **Behaviour is frozen.** These are the guardrails' classifiers; a "better"
 * parse here silently changes a security verdict. Policy — which helpers assert
 * ownership, which sites are allow-listed — deliberately stays in the tests.
 */

/* ------------------------------------------------------------------------ *
 * Text primitives.                                                          *
 * ------------------------------------------------------------------------ */

/**
 * Blank every comment, preserving offsets and line breaks so line numbers and
 * slices still line up. String literals are deliberately LEFT INTACT: a raw
 * sql`owner_id = ...` predicate is genuine ownership evidence, and blanking it
 * would turn a scoped write into a false failure. The cost is that a literal
 * string containing "ownerId" would count — a shape that does not exist in the
 * tree and would be a bizarre way to write a predicate.
 */
export function stripComments(source: string): string {
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
export function matchDelimiter(text: string, open: number, openChar: string, closeChar: string): number {
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
export function callArguments(text: string, open: number): string {
  const close = matchDelimiter(text, open, "(", ")");
  // Unbalanced means the statement window was cut short. Return the tail rather
  // than nothing: a guardrail's first duty is zero false failures.
  return close === -1 ? text.slice(open + 1) : text.slice(open + 1, close);
}

/**
 * Every argument span of `.<method>(...)` in `source`, comments blanked first —
 * the generalization of the guardrail's `whereArguments` (`.where`) so the same
 * extraction serves any chained call.
 *
 * `method` is interpolated into a regular expression; pass a plain identifier,
 * never user input.
 */
export function methodCallArguments(source: string, method: string): string[] {
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

/**
 * The body of `export async function <name>`, brace-matched, comments blanked.
 * Generic parameter lists (`<TResult extends { status: … }>`) carry braces of
 * their own, so the body's `{` is the first one seen at angle- AND paren-depth
 * zero. `undefined` when the declaration is not found — callers report that as a
 * rename rather than as a pass.
 *
 * Matches the `export async function` form only; that is the shape of the
 * simulation layer's durable command surface, which is what it exists to police.
 */
export function functionBody(source: string, name: string): string | undefined {
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

/* ------------------------------------------------------------------------ *
 * Directory walking.                                                        *
 * ------------------------------------------------------------------------ */

const DEFAULT_EXTENSIONS = [".ts", ".tsx"] as const;

/** `foo.test.ts` / `foo.int.test.ts` / the `.tsx` variants. */
const TEST_FILE = /\.(?:int\.)?test\.(?:ts|tsx)$/;

/** `__like_this__` — the convention for transient fixture directories. */
const FIXTURE_DIR = /^__.*__$/;

export interface SourceFilesOptions {
  /** Collect only files with this exact basename (e.g. `"route.ts"`); disables the extension/test filters. */
  fileName?: string;
  /** Extensions treated as source when `fileName` is unset. Default `[".ts", ".tsx"]`. */
  extensions?: readonly string[];
  /** Include `*.test.ts` / `*.int.test.ts`. Default `false`. */
  includeTests?: boolean;
  /** Descend into subdirectories. Default `true`; `false` reads one level, like the simulation-store census. */
  recursive?: boolean;
  /**
   * Skip `__name__` directories. Default `true`, and it is not cosmetic:
   * `image-internal-imports.test.ts` plants `src/app/api/__image_internal_lint_fixture__/route.ts`
   * in the live tree mid-run and removes it in `afterAll`, so a parallel worker
   * walking `src/app/api` can list the file and then have `readFileSync` throw
   * ENOENT. That race is a real flake this default closes; the fixture's content
   * carries no mutation and no internal import, so no census or verdict moves.
   */
  skipFixtureDirs?: boolean;
}

/** Absolute paths, in `readdir` order — sort at the call site when output stability matters. */
export function sourceFilesUnder(dir: string, options: SourceFilesOptions = {}): string[] {
  const {
    fileName,
    extensions = DEFAULT_EXTENSIONS,
    includeTests = false,
    recursive = true,
    skipFixtureDirs = true,
  } = options;

  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) continue;
        if (skipFixtureDirs && FIXTURE_DIR.test(entry.name)) continue;
        walk(absolute);
        continue;
      }
      if (fileName !== undefined) {
        if (entry.name === fileName) found.push(absolute);
        continue;
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      if (!includeTests && TEST_FILE.test(entry.name)) continue;
      found.push(absolute);
    }
  };
  walk(dir);
  return found;
}

/** Repo-relative, POSIX-separated — the identity every scanner reports sites under. */
export function repoRelative(absolute: string): string {
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

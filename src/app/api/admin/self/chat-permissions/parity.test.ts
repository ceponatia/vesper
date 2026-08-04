import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The chat-permissions `/self/` twin is load-bearing, and nothing else enforces
 * it — the same failure mode the chat-inspector parity test documents: the
 * client (`src/lib/api-permissions.ts`) requests
 * `/api/admin/self/chat-permissions/:chatId`, the handlers live under
 * `/api/admin/chat-permissions/:chatId`, and `withOwnerAdminOwnedChat` 404s the
 * canonical namespace by construction. A canonical route without its one-line
 * re-export twin type-checks, lints, passes its own tests, and 404s in the real
 * app.
 *
 * The chat-inspector suite's walker is rooted at its own feature tree, so this
 * feature carries its own (single-route) check: the twin must re-export from
 * the canonical specifier, and every verb the canonical route declares.
 */

const here = dirname(fileURLToPath(import.meta.url));
const canonicalRoute = resolve(here, "..", "..", "chat-permissions", "[chatId]", "route.ts");
const twinRoute = join(here, "[chatId]", "route.ts");

const CANONICAL_SPECIFIER = "@/app/api/admin/chat-permissions/[chatId]/route";

const httpVerbs = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const isVerb = (name: string): boolean => (httpVerbs as readonly string[]).includes(name);

/** The verbs a canonical handler declares (`export const GET = …`). */
function declaredVerbs(source: string): string[] {
  return [...source.matchAll(/^export const ([A-Za-z_]+)\b/gm)]
    .map((match) => match[1] ?? "")
    .filter(isVerb)
    .sort();
}

/** The verbs a twin re-exports (`export { GET, POST } from "…"`). */
function reExportedVerbs(source: string): string[] {
  return [...source.matchAll(/export\s*\{([^}]*)\}\s*from/g)]
    .flatMap((match) => (match[1] ?? "").split(","))
    .map((name) => name.trim())
    .filter(isVerb)
    .sort();
}

describe("chat-permissions /self/ mirror parity", () => {
  const canonical = readFileSync(canonicalRoute, "utf8");
  const twin = readFileSync(twinRoute, "utf8");

  it("declares the verbs the feature ships — a broken read must not pass vacuously", () => {
    expect(declaredVerbs(canonical)).toEqual(["GET", "POST"]);
  });

  it("re-exports the canonical route path from the twin", () => {
    expect(twin).toContain(CANONICAL_SPECIFIER);
  });

  it("re-exports every verb the canonical route declares", () => {
    // A twin that re-exports only GET from a route that also POSTs is the same
    // 404, one method deep.
    expect(reExportedVerbs(twin)).toEqual(declaredVerbs(canonical));
  });
});

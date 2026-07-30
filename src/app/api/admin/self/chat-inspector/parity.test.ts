import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The `/self/` mirror is load-bearing, and nothing else enforces it.
 *
 * The inspector client (`src/lib/api-inspector.ts`) requests
 * `/api/admin/self/chat-inspector/:chatId/…` for EVERY panel, while the handlers
 * live under `/api/admin/chat-inspector/:chatId/…`. Each mirrored path is a
 * one-line re-export twin, so a new panel that ships only the canonical route
 * type-checks, lints, passes its own tests, and then 404s in the real app — which
 * is exactly how the physical-guidance panel shipped broken. The failure is
 * invisible to every other gate because the missing file is the whole bug.
 *
 * So this walks the two trees as plain filesystem data and demands they match,
 * in both directions: no canonical route without a twin (the 404 above), and no
 * twin without a canonical route (a mirror pointing at nothing).
 */

const here = dirname(fileURLToPath(import.meta.url));
const canonicalRoot = resolve(here, "..", "..", "chat-inspector", "[chatId]");
const twinRoot = resolve(here, "[chatId]");

/** Route-bearing directories under a `[chatId]` root, as `/`-joined relative paths ("" = the root itself). */
function routeDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), rel === "" ? entry.name : `${rel}/${entry.name}`);
      else if (entry.name === "route.ts") found.push(rel);
    }
  };
  walk(root, "");
  return found.sort();
}

/** The module specifier a twin must re-export from. */
const canonicalSpecifier = (rel: string): string =>
  `@/app/api/admin/chat-inspector/[chatId]${rel === "" ? "" : `/${rel}`}/route`;

const routeFile = (root: string, rel: string): string => readFileSync(join(root, rel, "route.ts"), "utf8");

const httpVerbs = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const isVerb = (name: string): boolean => (httpVerbs as readonly string[]).includes(name);

/** The verbs a canonical handler declares (`export const GET = …`). */
function declaredVerbs(source: string): string[] {
  return [...source.matchAll(/^export const ([A-Za-z_]+)\b/gm)]
    .map((match) => match[1] ?? "")
    .filter(isVerb)
    .sort();
}

/** The verbs a twin re-exports (`export { GET, PATCH } from "…"`). */
function reExportedVerbs(source: string): string[] {
  return [...source.matchAll(/export\s*\{([^}]*)\}\s*from/g)]
    .flatMap((match) => (match[1] ?? "").split(","))
    .map((name) => name.trim())
    .filter(isVerb)
    .sort();
}

const canonical = routeDirs(canonicalRoot);
const twins = routeDirs(twinRoot);

describe("chat-inspector /self/ mirror parity", () => {
  it("found the canonical tree at all — a broken walk must not pass vacuously", () => {
    expect(canonical.length).toBeGreaterThan(5);
    // The panel whose missing twin is the reason this test exists.
    expect(canonical).toContain("physical-guidance");
  });

  it("mirrors every canonical route under /self/, with no orphan twins", () => {
    expect(twins).toEqual(canonical);
  });

  it("re-exports the canonical route path from each twin, and every verb it declares", () => {
    for (const rel of canonical) {
      const twin = routeFile(twinRoot, rel);
      expect(twin, `${rel || "[chatId]"}/route.ts must re-export its canonical handler`).toContain(
        canonicalSpecifier(rel),
      );
      // A twin that re-exports only GET from a route that also PATCHes is the same
      // 404, one method deep.
      expect(reExportedVerbs(twin), `${rel || "[chatId]"} verb parity`).toEqual(
        declaredVerbs(routeFile(canonicalRoot, rel)),
      );
    }
  });
});

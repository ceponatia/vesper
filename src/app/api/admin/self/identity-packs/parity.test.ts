import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The identity-pack admin surface is `/api/admin/self` and nothing else, and
 * nothing but this test says so.
 *
 * The chat-inspector and chat-permissions parity tests police the OTHER shape —
 * handlers under the ambiguous `/api/admin/*` namespace with a one-line `/self/`
 * re-export twin, where a missing twin 404s in the real app while every gate
 * passes. This feature deliberately has no canonical/twin split: the handlers
 * live at the path the client calls. The risks that leaves are the ones checked
 * here, and each is invisible to lint, typecheck and the route's own tests:
 *
 * 1. A twin (or a canonical route) appearing under `/api/admin/identity-packs`.
 *    `withOwnerAdmin` fails closed outside `/api/admin/self`, so such a file is
 *    dead on arrival — and if it were wired with a bare `withUser` instead, it
 *    would be an ADMIN surface open to every signed-in user.
 * 2. A handler here that does not go through an owner-admin wrapper. The
 *    directory alone grants nothing; the wrapper is the whole gate.
 * 3. A handler that reads or serves image bytes. Admin history and batch
 *    payloads are metadata by contract (image-identity-packs.spec.lifecycle.md
 *    §"Privacy boundary"); a bulk payload is the easiest place to breach that
 *    and the hardest place to notice it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(here, "..", "..");
/** `src/app/api` — `here` sits three segments below it (`admin/self/identity-packs`). */
const appApiRoot = resolve(here, "..", "..", "..");
/** `src/server/api/authz.ts` — five segments up to `src`, then across. */
const authzSource = resolve(here, "..", "..", "..", "..", "..", "server", "api", "authz.ts");

/** Repo path as a `/`-joined string, so the assertions read the same on any platform. */
const posix = (path: string): string => path.split(sep).join("/");

/** Route files under this feature, as `/`-joined paths relative to the feature root. */
function routeFiles(root: string): string[] {
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

const featureSource = (rel: string): string => readFileSync(join(here, rel, "route.ts"), "utf8");

/**
 * Wrappers that carry the owner-admin gate. `withOwnPackHistory` is this
 * feature's own composition over `withOwnerAdminResource` (`owned.ts`), which
 * the last case below pins so this list cannot be satisfied by a helper that
 * quietly stopped gating anything.
 */
const ADMIN_WRAPPERS = ["withOwnerAdmin", "withOwnerAdminResource", "withOwnPackHistory"] as const;

/** Anything that turns an id into pixels. None of it belongs on an admin metadata surface. */
const BYTE_READERS = ["readImageBytes", "absoluteImagePath", "saveImageBuffer", "imageUrl", "/file"] as const;

const routes = routeFiles(here);

describe("identity-packs admin surface", () => {
  it("found the routes at all — a broken walk must not pass vacuously", () => {
    expect(routes).toEqual(["[packId]/history", "[packId]/override", "batch"]);
  });

  it("lives beneath the owner-admin namespace, which is what makes the wrapper valid", () => {
    // `withOwnerAdmin` compares the REQUEST path against this prefix, so moving
    // either the directory or the prefix without the other 404s every handler
    // here. The constant is read as TEXT rather than imported: this is a pure
    // test, and importing the api barrel would drag the database and image
    // modules into it for one string.
    expect(readFileSync(authzSource, "utf8")).toContain('OWNER_ADMIN_API_PREFIX = "/api/admin/self"');
    expect(posix(relative(appApiRoot, here))).toBe("admin/self/identity-packs");
  });

  it("has no canonical twin outside /self — the handlers ARE the path the client calls", () => {
    const outsideSelf = readdirSync(adminRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(outsideSelf).not.toContain("identity-packs");
  });

  it("gates every handler behind an owner-admin wrapper, never a bare withUser", () => {
    for (const rel of routes) {
      const source = featureSource(rel);
      expect(
        ADMIN_WRAPPERS.some((wrapper) => source.includes(wrapper)),
        `${rel}/route.ts must use one of ${ADMIN_WRAPPERS.join(", ")}`,
      ).toBe(true);
      expect(/\bwithUser\b/.test(source), `${rel}/route.ts must not gate on bare withUser`).toBe(false);
    }
  });

  it("composes the feature's own wrapper from the admin resource wrapper", () => {
    const owned = readFileSync(join(here, "owned.ts"), "utf8");
    expect(owned).toContain("withOwnerAdminResource");
    // The ownership comparison is the reason a pack id in a URL is not
    // authorization even for an administrator.
    expect(owned).toContain("history.ownerId === user.id");
  });

  it("serves metadata only — no image bytes and no file URLs", () => {
    for (const rel of routes) {
      const source = featureSource(rel);
      for (const reader of BYTE_READERS) {
        expect(source.includes(reader), `${rel}/route.ts must not reach for image bytes (${reader})`).toBe(false);
      }
    }
  });
});

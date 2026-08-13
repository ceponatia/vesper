import { describe, expect, it } from "vitest";
import { resolveLibraryScope, searchLibraryIds, type LibraryScope } from "./library";
import type { ShareableKind } from "./visibility";
import type { LibraryKind } from "@/server/memory";

/**
 * The `kind × scope` matrix for library discovery (security-authz.plan.md
 * §Follow-ups item 3). Only the shareable tables carry a `visibility` column,
 * so a non-`owned` scope on any other kind must be refused *before* SQL is
 * built — the old code emitted `visibility = 'public'` regardless of kind and
 * 500'd on the invalid statement.
 */

/**
 * Every library kind, tagged. A `Record<LibraryKind, …>` on purpose: adding a
 * kind fails typecheck here until its tier is declared, so the matrix below can
 * never silently stop covering one.
 */
const KIND_TIERS: Record<LibraryKind, "shareable" | "owner-only"> = {
  character: "shareable",
  location: "shareable",
  item: "shareable",
  social_card: "shareable",
  persona: "owner-only",
};

const KINDS = Object.keys(KIND_TIERS) as LibraryKind[];
const SHAREABLE_KINDS = KINDS.filter((kind) => KIND_TIERS[kind] === "shareable");
const OWNER_ONLY_KINDS = KINDS.filter((kind) => KIND_TIERS[kind] === "owner-only");
const SCOPES: LibraryScope[] = ["owned", "public", "all"];

describe("resolveLibraryScope", () => {
  it("covers every kind, with both tiers populated", () => {
    expect(SHAREABLE_KINDS).toEqual(["character", "location", "item", "social_card"]);
    expect(OWNER_ONLY_KINDS).toEqual(["persona"]);
  });

  it("accepts every scope for every shareable kind", () => {
    for (const kind of SHAREABLE_KINDS) {
      for (const scope of SCOPES) {
        const decision = resolveLibraryScope(kind, scope);
        expect(decision, `${kind} × ${scope}`).toEqual({ supported: true, scope });
      }
    }
  });

  it("accepts the owned scope for every kind, including the owner-only ones", () => {
    for (const kind of KINDS) {
      expect(resolveLibraryScope(kind, "owned"), `${kind} × owned`).toEqual({ supported: true, scope: "owned" });
    }
  });

  it("defaults to owned when no scope is given", () => {
    for (const kind of KINDS) {
      expect(resolveLibraryScope(kind), `${kind} × <default>`).toEqual({ supported: true, scope: "owned" });
      expect(resolveLibraryScope(kind, undefined), `${kind} × undefined`).toEqual({ supported: true, scope: "owned" });
    }
  });

  it("refuses a non-owned scope for an owner-only kind, with a diagnostic and no throw", () => {
    for (const kind of OWNER_ONLY_KINDS) {
      for (const scope of SCOPES.filter((s) => s !== "owned")) {
        expect(() => resolveLibraryScope(kind, scope)).not.toThrow();
        const decision = resolveLibraryScope(kind, scope);
        expect(decision.supported, `${kind} × ${scope}`).toBe(false);
        if (decision.supported) continue; // narrowing only — the assertion above is the gate
        expect(decision.diagnostic.severity).toBe("warn");
        expect(decision.diagnostic.code).toBe("api.library.scope_unsupported");
        expect(decision.diagnostic.context).toEqual({ kind, scope });
        // The message names the kind and the refused scope, so the log line is
        // actionable without re-reading this module.
        expect(decision.diagnostic.message).toContain(kind);
        expect(decision.diagnostic.message).toContain(scope);
      }
    }
  });

  it("never reports a scope on a refusal, so no predicate can be built from it", () => {
    const decision = resolveLibraryScope("persona", "public");
    expect(Object.keys(decision).sort()).toEqual(["diagnostic", "supported"]);
  });
});

describe("searchLibraryIds scope backstop", () => {
  it("returns nothing for a dynamic owner-only kind at a non-owned scope, without querying", async () => {
    // The overloads make this unrepresentable at a statically-known call site;
    // the casts stand in for the dynamic kind/scope a future caller could hold
    // (a query-string value widened to LibraryKind). Reaching the database at
    // all IS the regression this guards — the old code would have compiled
    // `visibility = 'public'` against `personas` and thrown.
    const dynamicKind: LibraryKind = "persona";
    const kind = dynamicKind as ShareableKind;
    expect(await searchLibraryIds(kind, "owner-id", { scope: "public" })).toEqual([]);
    expect(await searchLibraryIds(kind, "owner-id", { scope: "all" })).toEqual([]);
  });
});

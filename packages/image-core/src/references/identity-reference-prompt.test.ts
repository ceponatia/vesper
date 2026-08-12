import { describe, expect, it } from "vitest";
import {
  identityReferenceStrategies,
  type IdentityReferenceRole,
  type IdentityReferenceStrategy,
} from "../identity/identity-pack";
import { compileIdentityReferencePrompt } from "./identity-reference-prompt";

const BASE = "Change the subject's outfit to a charcoal three-piece suit.";

/**
 * The role order each strategy sends, mirroring `identityRolePlan` in
 * `src/server/images/identity-pack-references.ts`. Restated here rather than
 * imported because that module is server-side (IO, database) and these are pure
 * tests — and because the point of the assertions below is that the compiled
 * NUMBERING follows whatever order it is handed, not that it agrees with one
 * particular producer.
 */
const ROLES_BY_STRATEGY: Record<IdentityReferenceStrategy, IdentityReferenceRole[]> = {
  canonical_only: ["canonical_identity"],
  face_detail_only: ["face_detail"],
  canonical_then_face_detail: ["canonical_identity", "face_detail"],
  face_detail_then_canonical: ["face_detail", "canonical_identity"],
};

const AUTHORITY =
  "Preserve the subject's canonical identity, hair, build, and apparent age from the canonical identity reference. " +
  "Use the facial-detail reference only to reinforce facial likeness.";

describe("compileIdentityReferencePrompt", () => {
  it("returns the base prompt untouched with no references", () => {
    expect(compileIdentityReferencePrompt({ basePrompt: BASE, roles: [] })).toBe(BASE);
  });

  it("returns the base prompt untouched with one reference, whichever role it is", () => {
    for (const role of ["canonical_identity", "face_detail"] as const) {
      expect(compileIdentityReferencePrompt({ basePrompt: BASE, roles: [role] })).toBe(BASE);
    }
  });

  it("numbers the bindings in send order for canonical-then-face-detail", () => {
    const compiled = compileIdentityReferencePrompt({
      basePrompt: BASE,
      roles: ROLES_BY_STRATEGY.canonical_then_face_detail,
    });
    expect(compiled).toBe(
      [
        "Image 1: the canonical identity reference for the subject.",
        "Image 2: a close facial-detail reference for the same subject.",
        AUTHORITY,
        "",
        BASE,
      ].join("\n"),
    );
  });

  it("numbers the bindings in send order for face-detail-then-canonical", () => {
    const compiled = compileIdentityReferencePrompt({
      basePrompt: BASE,
      roles: ROLES_BY_STRATEGY.face_detail_then_canonical,
    });
    expect(compiled).toBe(
      [
        "Image 1: a close facial-detail reference for the same subject.",
        "Image 2: the canonical identity reference for the subject.",
        AUTHORITY,
        "",
        BASE,
      ].join("\n"),
    );
  });

  it("differs between the two two-reference strategies — the whole reason it exists", () => {
    const forward = compileIdentityReferencePrompt({
      basePrompt: BASE,
      roles: ROLES_BY_STRATEGY.canonical_then_face_detail,
    });
    const reversed = compileIdentityReferencePrompt({
      basePrompt: BASE,
      roles: ROLES_BY_STRATEGY.face_detail_then_canonical,
    });
    expect(forward).not.toBe(reversed);
  });

  it("keeps every strategy's compiled prompt ending in the base prompt", () => {
    for (const strategy of identityReferenceStrategies) {
      const compiled = compileIdentityReferencePrompt({ basePrompt: BASE, roles: ROLES_BY_STRATEGY[strategy] });
      expect(compiled.endsWith(BASE)).toBe(true);
      // Single-reference strategies stay simple; two-reference ones gain a preamble.
      expect(compiled === BASE).toBe(ROLES_BY_STRATEGY[strategy].length < 2);
    }
  });

  it("emits the authority clause only when both roles are present", () => {
    const bothRoles = compileIdentityReferencePrompt({
      basePrompt: BASE,
      roles: ["canonical_identity", "face_detail"],
    });
    expect(bothRoles).toContain(AUTHORITY);

    // Two references of the SAME role have no conflict to arbitrate, so the
    // clause — which names both references by name — would describe nothing.
    const sameRole = compileIdentityReferencePrompt({
      basePrompt: BASE,
      roles: ["canonical_identity", "canonical_identity"],
    });
    expect(sameRole).not.toContain(AUTHORITY);
    expect(sameRole).toBe(
      [
        "Image 1: the canonical identity reference for the subject.",
        "Image 2: the canonical identity reference for the subject.",
        "",
        BASE,
      ].join("\n"),
    );
  });

  it("binds a lone reference only when the caller asks for it by name", () => {
    // `multi_reference_compose` is the one strategy whose defining semantic is
    // naming EACH reference, so it must produce different text than the default
    // at a single reference — otherwise it is `instruction_edit` under a second
    // name, and a profile could claim a different configuration while sending
    // byte-identical bytes. Zero references stays a no-op either way: there is
    // nothing to name, and the no-pack baseline must not pick up text the
    // harness invented.
    const named = compileIdentityReferencePrompt({
      basePrompt: BASE,
      roles: ["canonical_identity"],
      nameEveryReference: true,
    });
    expect(named).toBe(["Image 1: the canonical identity reference for the subject.", "", BASE].join("\n"));
    expect(named).not.toBe(compileIdentityReferencePrompt({ basePrompt: BASE, roles: ["canonical_identity"] }));
    expect(compileIdentityReferencePrompt({ basePrompt: BASE, roles: [], nameEveryReference: true })).toBe(BASE);
    // At two references the flag changes nothing — the bindings were already
    // emitted, so the two strategies differ only where they must.
    const roles: IdentityReferenceRole[] = ["canonical_identity", "face_detail"];
    expect(compileIdentityReferencePrompt({ basePrompt: BASE, roles, nameEveryReference: true })).toBe(
      compileIdentityReferencePrompt({ basePrompt: BASE, roles }),
    );
  });

  it("is deterministic — the same input compiles to the same string", () => {
    const once = compileIdentityReferencePrompt({ basePrompt: BASE, roles: ["face_detail", "canonical_identity"] });
    const twice = compileIdentityReferencePrompt({ basePrompt: BASE, roles: ["face_detail", "canonical_identity"] });
    expect(once).toBe(twice);
  });
});

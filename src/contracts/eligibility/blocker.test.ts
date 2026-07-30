import { describe, expect, it } from "vitest";
import { affordanceSubjectId } from "../affordances/core";
import { ADULT_ELIGIBILITY_ANCHOR_ID } from "./declaration";
import { adultEligibilityBlockerLinks, adultEligibilityEditorTarget } from "./blocker";
import type { AdultEligibilityVerdict } from "./contact-adapter";

const mara = affordanceSubjectId("char_mara");
const player = affordanceSubjectId("persona_brian");

describe("adultEligibilityEditorTarget (blocked-action routing)", () => {
  it("routes a persona to the persona editor, at the declaration anchor", () => {
    expect(adultEligibilityEditorTarget({ kind: "persona", entityId: "p1" })).toEqual({
      target: "persona-editor",
      entityId: "p1",
      anchorId: ADULT_ELIGIBILITY_ANCHOR_ID,
      label: "Edit persona",
    });
  });

  it("routes an owned character to the character editor", () => {
    expect(adultEligibilityEditorTarget({ kind: "character", entityId: "c1" })?.target).toBe("character-editor");
  });

  it("offers Duplicate to edit for a foreign character — the copy-on-use seam, not a dead end", () => {
    expect(adultEligibilityEditorTarget({ kind: "character", entityId: "c1", foreign: true })).toEqual({
      target: "duplicate-character",
      entityId: "c1",
      anchorId: ADULT_ELIGIBILITY_ANCHOR_ID,
      label: "Duplicate to edit",
    });
  });

  it("yields no target for a participant with no library identity", () => {
    expect(adultEligibilityEditorTarget(undefined)).toBeUndefined();
  });
});

describe("adultEligibilityBlockerLinks", () => {
  it("links every not-positively-eligible participant — unresolved blocks a gated action too", () => {
    const verdicts: AdultEligibilityVerdict[] = [
      { id: mara, result: "unresolved", entity: { kind: "character", entityId: "c1", foreign: true } },
      { id: player, result: "ineligible", entity: { kind: "persona", entityId: "p1" } },
    ];
    expect(adultEligibilityBlockerLinks(verdicts).map((link) => link.target)).toEqual([
      "duplicate-character",
      "persona-editor",
    ]);
  });

  it("skips eligible participants and entity-less verdicts, and dedupes a repeated entity", () => {
    const verdicts: AdultEligibilityVerdict[] = [
      { id: mara, result: "eligible", entity: { kind: "character", entityId: "c1" } },
      { id: player, result: "unresolved" },
      { id: player, result: "unresolved", entity: { kind: "persona", entityId: "p1" } },
      { id: player, result: "unresolved", entity: { kind: "persona", entityId: "p1" } },
    ];
    const links = adultEligibilityBlockerLinks(verdicts);
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe("persona-editor");
  });
});

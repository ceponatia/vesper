import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../../diagnostics";
import {
  affordanceSubjectId,
  emptyAffordancePerceptionView,
  AFFORDANCE_INPUT_INVALID,
  AFFORDANCE_INPUT_UNAVAILABLE,
} from "../../core";
import { affordanceDomains } from "../../domains";
import type { AffordanceRead } from "../../derive-affordance-read";
import { footAffordanceDomain, FOOT_DOMAIN_ID } from "./domain";
import {
  committedFootContact,
  footAttributeFixture,
  footObserver,
  footWorkedCases,
  readFootAffordances,
  type FootFixture,
} from "./fixtures";
import {
  FOOT_ARTICULATION_ID,
  FOOT_CONTACT_PRESSURE_ID,
  FOOT_GLIDE_RESPONSE_ID,
  FOOT_NAIL_CONTACT_ID,
  FOOT_SURFACE_TEXTURE_ID,
} from "./phenomena";

/**
 * The foot domain end to end, through the real staged runner — the same entry
 * point a lane adapter would call.
 */

function read(fixture: FootFixture, previous?: AffordanceRead): AffordanceRead {
  return readFootAffordances({
    attributes: fixture.attributes,
    payload: fixture.payload,
    perception: fixture.perception,
    ...(previous === undefined ? {} : { previousCues: previous.nextCues }),
  });
}

function tagsFor(result: AffordanceRead, id: string): readonly string[] {
  return result.observations.find((observation) => observation.id === id)?.semanticTags ?? [];
}

function ids(result: AffordanceRead): readonly string[] {
  return result.observations.map((observation) => observation.id);
}

describe("the first calibration fixture — lotioned arch, palm slides arch → heel", () => {
  const result = read(footWorkedCases.lotionArchToHeelSlide());

  it("commits a direct-skin contact with no reposition", () => {
    const contact = committedFootContact({
      detail: "arch",
      locationId: "foot_arch",
      pressure: "moderate",
      area: "broad",
    });
    expect(contact.phase).toBe("active");
    expect(contact.transmission.directSkinContact).toBe(true);
    expect(contact.implicitAdjustments).toEqual([]);
  });

  it("reads broad moderate pressure across the arch and the heel", () => {
    expect(tagsFor(result, FOOT_CONTACT_PRESSURE_ID)).toEqual([
      "pressure_moderate",
      "area_broad",
      "arch",
      "crosses_arch",
      "crosses_heel_pad",
    ]);
  });

  it("reads a soft arch, softened by the lotion", () => {
    expect(tagsFor(result, FOOT_SURFACE_TEXTURE_ID)).toEqual(["soft_arch", "moisture_softened"]);
  });

  it("reads the glide as a localized catch at the dry callused heel", () => {
    const tags = tagsFor(result, FOOT_GLIDE_RESPONSE_ID);
    expect(tags[0]).toBe("rough_surface_catch");
    expect(tags).toContain("heel_pad");
    expect(tags).toContain("crosses_arch");
  });

  it("invents no toe curl, sweat, scent, scratch, residue transfer, or pleasure", () => {
    expect(ids(result)).not.toContain(FOOT_ARTICULATION_ID);
    expect(ids(result)).not.toContain(FOOT_NAIL_CONTACT_ID);
    const everything = result.observations.flatMap((observation) => observation.semanticTags).join(" ");
    expect(everything).not.toMatch(/sweat|scent|smell|scratch|residue|transfer|pleasure|curl/u);
  });

  it("offers at most the cue cap, strongest first", () => {
    expect(result.cues.length).toBeLessThanOrEqual(2);
    expect(result.cues[0]?.id).toBe(FOOT_GLIDE_RESPONSE_ID);
  });
});

describe("the slice-2 fixture matrix", () => {
  it("filters a socked touch instead of blocking or baring it", () => {
    const result = read(footWorkedCases.sockFilteredTouch());
    expect(tagsFor(result, FOOT_SURFACE_TEXTURE_ID)).toEqual(["soft_arch", "ribbed_sock_filtered"]);
    expect(ids(result)).toContain(FOOT_CONTACT_PRESSURE_ID);
  });

  it("lets an open-toed sandal expose the toes it touches", () => {
    const result = read(footWorkedCases.openToedSandal());
    expect(tagsFor(result, FOOT_SURFACE_TEXTURE_ID)).toEqual(["soft_toe_pads"]);
    expect(tagsFor(result, FOOT_ARTICULATION_ID)).toContain("restricted_by_contact");
  });

  it("reports a toe movement inside a rigid boot as restricted, and nothing else", () => {
    const result = read(footWorkedCases.rigidBootHiddenToes());
    expect(ids(result)).toEqual([FOOT_ARTICULATION_ID]);
    expect(tagsFor(result, FOOT_ARTICULATION_ID)).toEqual([
      "foot_left",
      "toes_curled",
      "arch_neutral",
      "restricted_by_footwear",
    ]);
  });

  it("keeps a damp sole readable while the dorsal surface has dried", () => {
    const result = read(footWorkedCases.dampSoleDryDorsal());
    expect(tagsFor(result, FOOT_SURFACE_TEXTURE_ID)).toContain("moisture_softened");
  });

  it("suppresses glide on an unknown surface state without suppressing the rest", () => {
    const result = read(footWorkedCases.unknownSurfaceState());
    expect(ids(result)).toContain(FOOT_CONTACT_PRESSURE_ID);
    expect(ids(result)).not.toContain(FOOT_GLIDE_RESPONSE_ID);
    expect(result.suppressed.find((entry) => entry.phenomenonId === FOOT_GLIDE_RESPONSE_ID)?.code).toBe(
      "unknown_surface_state",
    );
  });

  it("says nothing at all when no contact is committed", () => {
    const result = read(footWorkedCases.noCommittedContact());
    expect(result.observations).toEqual([]);
    expect(result.cues).toEqual([]);
  });
});

describe("perception and repetition", () => {
  it("suppresses everything for an observer who can see nothing", () => {
    const fixture = footWorkedCases.lotionArchToHeelSlide();
    const blind = readFootAffordances({
      attributes: fixture.attributes,
      payload: fixture.payload,
      perception: emptyAffordancePerceptionView(),
    });
    expect(blind.observations).toEqual([]);
    expect(blind.suppressed.some((entry) => entry.code.startsWith("affordance.perception."))).toBe(true);
  });

  it("suppresses a heel read for an observer whose view of the heel is blocked", () => {
    const fixture = footWorkedCases.lotionArchToHeelSlide();
    const partial = readFootAffordances({
      attributes: fixture.attributes,
      payload: fixture.payload,
      perception: footObserver({ heel: "hidden" }),
    });
    expect(ids(partial)).not.toContain(FOOT_GLIDE_RESPONSE_ID);
    expect(ids(partial)).toContain(FOOT_CONTACT_PRESSURE_ID);
  });

  it("stays silent on an unchanged held contact after its first useful mention", () => {
    const fixture = footWorkedCases.lotionArchToHeelSlide();
    const first = read(fixture);
    expect(first.cues.length).toBeGreaterThan(0);
    const second = read(fixture, first);
    expect(second.cues).toEqual([]);
    // The physical read is unchanged: only the mention is gated.
    expect(ids(second)).toEqual(ids(first));
  });

  it("does not let one foot's pose gate the other foot's", () => {
    const posed = (side: "left" | "right"): FootFixture => ({
      attributes: footAttributeFixture({ arch: "average", nails: "neat", toes: "average" }),
      payload: {
        condition: { moisture: 0, contributors: [], placedSubstances: [], placedResidues: [] },
        articulation: [{ side, toes: "curled", arch: "neutral" }],
      },
      perception: footObserver(),
    });
    const left = read(posed("left"));
    const right = read(posed("right"), left);
    expect(left.cues.map((cue) => cue.repeatKey)).toEqual(["foot:articulation:feet:left"]);
    // A different foot is a different fact; a subject-wide key would have gated it.
    expect(right.cues.map((cue) => cue.repeatKey)).toEqual(["foot:articulation:feet:right"]);
  });

  it("restores priority when the contact changes", () => {
    const held = footWorkedCases.restingPalmOnArch();
    const first = read(held);
    const firmer = footWorkedCases.lotionArchToHeelSlide();
    const second = read(firmer, first);
    expect(second.cues.length).toBeGreaterThan(0);
  });
});

describe("determinism", () => {
  it("gives identical fixtures identical observations, evidence, and repeat keys", () => {
    for (const build of Object.values(footWorkedCases)) {
      const left = read(build());
      const right = read(build());
      expect(right.observations).toEqual(left.observations);
      expect(right.evidence).toEqual(left.evidence);
      expect(right.suppressed).toEqual(left.suppressed);
      expect(right.nextCues).toEqual(left.nextCues);
    }
  });

  it("derives the same contact id from the same attempt and event", () => {
    const first = committedFootContact({ detail: "arch", locationId: "foot_arch", pressure: "light" });
    const second = committedFootContact({ detail: "arch", locationId: "foot_arch", pressure: "light" });
    expect(second.contactId).toBe(first.contactId);
  });
});

describe("the slice-1 gate still governs what may be observed", () => {
  it("refuses a romantically-framed foot contact in a lane with no permission owner", () => {
    // The fixture's policy grant covers `affectionate_touch` only, which is the
    // audit's RECOMMENDED default for the first foot trial. A `romantic` attempt
    // is rejected by the gate, so no committed contact exists to observe.
    expect(() => committedFootContact({ detail: "arch", locationId: "foot_arch", actionKind: "romantic" })).toThrow(
      /did not commit/u,
    );
  });
});

describe("registration is slice 3's job", () => {
  it("is absent from the live domain tuple", () => {
    expect(affordanceDomains.map((domain) => domain.id)).not.toContain(FOOT_DOMAIN_ID);
  });

  it("would be inert if it were there: an unfed lane produces nothing but one diagnostic", () => {
    const sink = new DiagnosticCollector();
    const unfed = readFootAffordances({
      attributes: footAttributeFixture({ arch: "average", nails: "neat", toes: "average" }),
      payload: undefined,
      perception: footObserver(),
      sink,
    });
    expect(unfed.observations).toEqual([]);
    expect(unfed.constraints).toEqual([]);
    expect(unfed.cues).toEqual([]);
    expect(sink.items.map((entry) => entry.code)).toEqual([AFFORDANCE_INPUT_UNAVAILABLE]);
    expect(sink.hasErrors).toBe(false);
  });

  it("says nothing at all for a character with no authored feet attributes", () => {
    const unauthored = readFootAffordances({
      attributes: [],
      payload: footWorkedCases.lotionArchToHeelSlide().payload,
      perception: footObserver(),
    });
    expect(unauthored.observations).toEqual([]);
    expect(unauthored.suppressed).toHaveLength(footAffordanceDomain.phenomenonIds.length);
  });

  it("reports a corrupt committed contact as INVALID, never as an absent owner", () => {
    const fixture = footWorkedCases.lotionArchToHeelSlide();
    const corrupt = readFootAffordances({
      attributes: fixture.attributes,
      // A blob that is present and unreadable. "Nobody answered" and "an owner
      // answered with something nobody meant" are the two halves of the adapter
      // result law, and reporting the second as the first hides a real bug
      // behind the warning every unowned input already emits.
      payload: { ...fixture.payload, contact: { phase: "active", contactId: 42 } },
      perception: fixture.perception,
    });
    const pressure = corrupt.suppressed.find((entry) => entry.phenomenonId === FOOT_CONTACT_PRESSURE_ID);
    expect(pressure?.code).toBe(AFFORDANCE_INPUT_INVALID);

    // Contrast: a contact for somebody ELSE's foot is a read that worked and
    // found nothing here, which is `unavailable`.
    const elsewhere = readFootAffordances({
      attributes: fixture.attributes,
      payload: { ...fixture.payload, contact: committedFootContact({ detail: "arch", locationId: "shoulders" }) },
      perception: fixture.perception,
    });
    expect(
      elsewhere.suppressed.find((entry) => entry.phenomenonId === FOOT_CONTACT_PRESSURE_ID)?.code,
    ).toBe(AFFORDANCE_INPUT_UNAVAILABLE);
  });

  it("keeps its fixture builders out of the public barrel", async () => {
    const barrel: Record<string, unknown> = await import("./index");
    expect(barrel["committedFootContact"]).toBeUndefined();
    expect(barrel["readFootAffordances"]).toBeUndefined();
    expect(barrel["footWorkedCases"]).toBeUndefined();
    // The domain itself is still exported.
    expect(barrel["footAffordanceDomain"]).toBeDefined();
  });

  it("never claims a foot read about another subject", () => {
    const fixture = footWorkedCases.lotionArchToHeelSlide();
    const elsewhere = readFootAffordances({
      attributes: fixture.attributes,
      payload: fixture.payload,
      perception: fixture.perception,
      subjectId: affordanceSubjectId("somebody_else"),
    });
    expect(elsewhere.observations).toEqual([]);
  });
});

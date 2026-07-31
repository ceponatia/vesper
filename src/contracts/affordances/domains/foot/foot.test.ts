import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../../diagnostics";
import { materializeRegistryDefaults, type AttributeValue } from "../../../attributes";
import {
  affordanceSubjectId,
  emptyAffordancePerceptionView,
  resolvedAttributeSnapshot,
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
  footwearFixture,
  readFootAffordances,
  FOOT_FIXTURE_SUBJECT,
  type FootFixture,
} from "./fixtures";
import { FOOT_FOOTWEAR_ANOMALY } from "./footwear";
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

  it("reports a toe movement inside a rigid boot as restricted and HIDDEN", () => {
    const result = read(footWorkedCases.rigidBootHiddenToes());
    expect(ids(result)).toEqual([FOOT_ARTICULATION_ID]);
    // The pose detail is not an externally available fact — a rigid shell moves
    // as one piece — so it never reaches a prompt. What the boot cannot hide is
    // that it is a boot and that it is stopping her.
    expect(tagsFor(result, FOOT_ARTICULATION_ID)).toEqual([
      "foot_left",
      "pose_hidden_by_footwear",
      "restricted_by_footwear",
    ]);
  });

  it("lets flexible fabric transmit the same toe curl", () => {
    const result = read(footWorkedCases.sockTransmittedToeCurl());
    const tags = tagsFor(result, FOOT_ARTICULATION_ID);
    expect(tags).toEqual(["foot_left", "toes_curled", "arch_neutral", "restricted_by_contact"]);
    expect(tags).not.toContain("pose_hidden_by_footwear");
    // …and the touch through it is filtered rather than bare or blocked.
    expect(tagsFor(result, FOOT_SURFACE_TEXTURE_ID)).toContain("ribbed_sock_filtered");
  });

  it("keeps a damp left sole and a dry right sole apart", () => {
    const result = read(footWorkedCases.dampLeftFootDryRight());
    // The contact is on the LEFT sole, which is the wet one.
    expect(tagsFor(result, FOOT_SURFACE_TEXTURE_ID)).toContain("moisture_softened");

    const dryRight = readFootAffordances({
      attributes: footWorkedCases.dampLeftFootDryRight().attributes,
      payload: {
        ...footWorkedCases.dampLeftFootDryRight().payload,
        contact: committedFootContact({
          detail: "plantar_surface",
          locationId: "sole",
          side: "right",
          pressure: "light",
          area: "broad",
        }),
      },
      perception: footObserver(),
    });
    expect(tagsFor(dryRight, FOOT_SURFACE_TEXTURE_ID)).not.toContain("moisture_softened");
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
        condition: [{ moisture: 0, contributors: [], placedSubstances: [], placedResidues: [] }],
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

describe("partial profiles — each axis gates only its own surfaces", () => {
  /** Arch and toes authored, toenail upkeep missing. */
  const noNails: readonly AttributeValue[] = [
    { id: "feet.arch", value: "average", source: "creation" },
    { id: "feet.toes", value: "average", source: "creation" },
  ];
  const dryFoot = { moisture: 0, contributors: [], placedSubstances: [], placedResidues: [] };

  it("missing toenails plus known contact pressure still emits pressure", () => {
    const result = readFootAffordances({
      attributes: noNails,
      payload: {
        condition: [dryFoot],
        contact: committedFootContact({ detail: "toenails", locationId: "toenails", pressure: "moderate" }),
        tactile: { available: true },
      },
      perception: footObserver(),
    });
    expect(ids(result)).toContain(FOOT_CONTACT_PRESSURE_ID);
  });

  it("missing toenails suppresses nail contact, not heel texture", () => {
    const onNails = readFootAffordances({
      attributes: noNails,
      payload: {
        condition: [dryFoot],
        contact: committedFootContact({ detail: "toenails", locationId: "toenails", pressure: "moderate" }),
        tactile: { available: true },
      },
      perception: footObserver(),
    });
    expect(onNails.suppressed.find((entry) => entry.phenomenonId === FOOT_NAIL_CONTACT_ID)?.code).toBe(
      "surface_unprofiled",
    );

    const onHeel = readFootAffordances({
      attributes: noNails,
      payload: {
        condition: [dryFoot],
        contact: committedFootContact({ detail: "heel_pad", locationId: "heel", pressure: "light", area: "broad" }),
        footwear: [],
        tactile: { available: true },
      },
      perception: footObserver(),
    });
    const heelTexture = onHeel.observations.find((observation) => observation.id === FOOT_SURFACE_TEXTURE_ID);
    expect(heelTexture?.semanticTags.some((tag) => tag.endsWith("_heel_pad"))).toBe(true);
  });

  it("materialized registry defaults produce structure only — no moisture, scent, product, residue, or contact", () => {
    // A body born from nothing but registry defaults, in a lane that answered
    // nothing: the structural profile exists, and not one observation does.
    const defaulted = materializeRegistryDefaults([]);
    expect(defaulted.map((value) => value.id).sort()).toEqual(["feet.arch", "feet.nails", "feet.size", "feet.toes"]);
    const result = readFootAffordances({
      attributes: defaulted,
      payload: {},
      perception: footObserver(),
    });
    expect(result.observations).toEqual([]);
    expect(result.cues).toEqual([]);
    const everything = JSON.stringify([result.evidence, result.observations]);
    expect(everything).not.toMatch(/moisture|scent|smell|lotion|residue|sweat/u);
  });
});

describe("the slice-1 gate still governs what may be observed", () => {
  it("refuses a romantically-framed foot contact in a lane with no permission owner", () => {
    // The fixture's policy grant covers `affectionate_touch` only. Romantic
    // contact needs a permission owner and positive adult eligibility for every
    // participant (owner ruling, 2026-07-30) and legacy chat can produce
    // neither, so the attempt is rejected by the gate and no committed contact
    // exists to observe. Relabeling it to make the trial commit is exactly what
    // the same ruling forbids.
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

  it("still reads pressure for a character with no authored feet attributes, and nothing axis-dependent", () => {
    // Pressure requires no `feet.*` attribute — the committed contact carries
    // it. The axis-calibrated surfaces (arch subtree here) stay suppressed.
    const unauthored = readFootAffordances({
      attributes: [],
      payload: footWorkedCases.lotionArchToHeelSlide().payload,
      perception: footObserver(),
    });
    expect(ids(unauthored)).toEqual([FOOT_CONTACT_PRESSURE_ID]);
    expect(
      unauthored.suppressed.find((entry) => entry.phenomenonId === FOOT_SURFACE_TEXTURE_ID)?.code,
    ).toBe("surface_unprofiled");
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

  it("reports contradictory per-foot reads as INVALID rather than merging them", () => {
    const fixture = footWorkedCases.lotionArchToHeelSlide();
    const request = (payload: unknown) => ({
      subjectId: FOOT_FIXTURE_SUBJECT,
      storyTime: 100,
      attributes: resolvedAttributeSnapshot([...fixture.attributes]),
      payload,
    });

    // Two poses for one foot: curled and spread at once has no resolution, so
    // the read carries no value and the phenomenon that REQUIRES it is
    // suppressed with the standard code and diagnostic.
    const sink = new DiagnosticCollector();
    const posed = readFootAffordances({
      attributes: fixture.attributes,
      payload: {
        ...fixture.payload,
        articulation: [
          { side: "left", toes: "curled", arch: "neutral" },
          { side: "left", toes: "spread", arch: "extended" },
        ],
      },
      perception: fixture.perception,
      sink,
    });
    expect(posed.suppressed.find((entry) => entry.phenomenonId === FOOT_ARTICULATION_ID)?.code).toBe(
      AFFORDANCE_INPUT_INVALID,
    );
    expect(sink.items.some((entry) => entry.code === AFFORDANCE_INPUT_INVALID)).toBe(true);
    expect(
      footAffordanceDomain.trace(
        request({
          ...fixture.payload,
          articulation: [
            { side: "left", toes: "curled", arch: "neutral" },
            { side: "left", toes: "spread", arch: "extended" },
          ],
        }),
      ).inputs?.["articulation"],
    ).toBe("invalid");

    // Two supports for one foot — trapped and free at once. `support` is an
    // OPTIONAL dependency, but optional tolerates only absence, never
    // corruption: an owner answered and the answer is unreadable, so running
    // without it would let a possibly-trapped foot read as unrestricted.
    // The dependent phenomenon is suppressed with the invalid code instead.
    const supported = footAffordanceDomain.trace(
      request({
        ...fixture.payload,
        support: [
          { side: "left", supportRole: "weight_bearing", mobility: "trapped" },
          { side: "left", supportRole: "free", mobility: "free" },
        ],
        articulation: [{ side: "left", toes: "relaxed", arch: "neutral" }],
      }),
    );
    expect(supported.inputs?.["support"]).toBe("invalid");
    const articulationRead = supported.resolutions.find(
      (resolution) => resolution.kind === "suppressed" && resolution.phenomenonId === FOOT_ARTICULATION_ID,
    );
    expect(articulationRead?.kind).toBe("suppressed");
    if (articulationRead?.kind !== "suppressed") return;
    expect(articulationRead.code).toBe(AFFORDANCE_INPUT_INVALID);
    expect(articulationRead.detail).toContain("support");
    expect(supported.diagnostics.some((entry) => entry.code === AFFORDANCE_INPUT_INVALID)).toBe(true);
  });

  it("refuses a `center` foot in every foot-owned payload", () => {
    // A foot is left or right. The contact core's shared side vocabulary carries
    // `center` for surfaces that genuinely have a middle, and a payload spending
    // it on a foot describes something nobody has — so it fails the FOOT schema
    // and degrades `invalid` rather than arriving as a third foot, which the
    // two-distinct-feet agreement rule could then have counted as the second one.
    const fixture = footWorkedCases.lotionArchToHeelSlide();
    const centered = {
      condition: [{ side: "center", contributors: [], placedSubstances: [], placedResidues: [] }],
      support: [{ side: "center", supportRole: "free", mobility: "free" }],
      articulation: [{ side: "center", toes: "relaxed", arch: "neutral" }],
    };

    for (const [key, value] of Object.entries(centered)) {
      const payload = {
        ...fixture.payload,
        // A real foot's pose, so the articulation phenomenon reaches the input
        // under test instead of stopping at its own missing dependency.
        articulation: [{ side: "left", toes: "relaxed", arch: "neutral" }],
        [key]: value,
      };
      expect(
        footAffordanceDomain.trace({
          subjectId: FOOT_FIXTURE_SUBJECT,
          storyTime: 100,
          attributes: resolvedAttributeSnapshot([...fixture.attributes]),
          payload,
        }).inputs?.[key],
        key,
      ).toBe("invalid");

      const sink = new DiagnosticCollector();
      const result = readFootAffordances({
        attributes: fixture.attributes,
        payload,
        perception: fixture.perception,
        sink,
      });
      // The dependent phenomenon carries no value at all — required or optional,
      // a corrupt answer is never run as an absent one — and the standard
      // diagnostic goes with it.
      const dependent = key === "condition" ? FOOT_GLIDE_RESPONSE_ID : FOOT_ARTICULATION_ID;
      expect(result.suppressed.find((entry) => entry.phenomenonId === dependent)?.code, key).toBe(
        AFFORDANCE_INPUT_INVALID,
      );
      expect(
        sink.items.some((entry) => entry.code === AFFORDANCE_INPUT_INVALID),
        key,
      ).toBe(true);
    }
  });

  it("reports a repeated wardrobe layer id instead of accepting it in silence", () => {
    const sink = new DiagnosticCollector();
    const fixture = footWorkedCases.sockFilteredTouch();
    const doubled = readFootAffordances({
      attributes: fixture.attributes,
      payload: {
        ...fixture.payload,
        footwear: [footwearFixture(), footwearFixture({ parts: ["upper"], order: 1 })],
      },
      perception: fixture.perception,
      sink,
    });
    expect(sink.items.map((entry) => entry.code)).toContain(FOOT_FOOTWEAR_ANOMALY);
    expect(sink.hasErrors).toBe(false);
    // The read still works. An unreadable wardrobe that makes a shod foot read
    // bare is the one direction this layer must never fail in.
    expect(tagsFor(doubled, FOOT_SURFACE_TEXTURE_ID)).toEqual(["soft_arch", "ribbed_sock_filtered"]);
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

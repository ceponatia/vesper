import { describe, expect, it } from "vitest";
import { AFFORDANCE_UNIT_ONE } from "@/contracts";
import type { VisualImageFact } from "@/contracts/images/visual-digest";
import {
  VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID,
  VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID,
  VISUAL_STATE_CONDITION_ACTIVE_KIND_ID,
  VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
  VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
} from "@/contracts/visual-state";
import { attr } from "@/server/test-support";
import {
  visualFactClauseResolver,
  VISUAL_CLAUSE_OMIT_CURATED,
  VISUAL_CLAUSE_OMIT_GARMENT_NOTES,
  VISUAL_CLAUSE_OMIT_SCENE_PLAN,
  VISUAL_CLAUSE_OMIT_WARDROBE_ROUTE,
} from "./visual-fact-clauses";

/**
 * The shared clause resolver's THREE-ANSWER contract with
 * `buildVisualSubjectSegments` (visual-fact-clauses.ts): a string is the
 * clause, `{ omit }` is a deliberate cut, and `undefined` is degradation that
 * costs a REQUIRED fact its render eligibility. The distinctions decide whether
 * a route renders, suppresses, or refuses — so each case below kills a specific
 * mix-up: a sparse non-human refusing every avatar over an unauthored wing
 * description, a curated lane cut reading as a lost anchor, or an unknown kind
 * leaking a fingerprint into a provider prompt.
 */

function fact(over: Partial<VisualImageFact>): VisualImageFact {
  return {
    key: "s/x",
    subjectId: "s",
    kindId: VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID,
    layer: "identity",
    locus: { kind: "subject", subjectId: "s" },
    sourceRef: { kind: "appearance", ref: { kind: "attribute", attributeId: "hair.color" } },
    sourceKey: "appearance:attribute:hair.color",
    value: '"x"',
    truthFingerprint: '"x"',
    semanticTags: [],
    stability: "inherent",
    required: true,
    segmentKind: "identity",
    visibility: { basis: "identity_required", evidence: [] },
    priority: AFFORDANCE_UNIT_ONE,
    ...over,
  };
}

function groupFact(group: "horns" | "wings"): VisualImageFact {
  return fact({
    kindId: VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
    sourceRef: { kind: "species_feature", speciesId: "succubus", featureGroup: group },
    value: { group },
    segmentKind: "morphology",
  });
}

describe("visualFactClauseResolver", () => {
  it("phrases a species feature group from its authored attributes — the canonical owner answers", () => {
    const resolve = visualFactClauseResolver({ attributes: [attr("horns.shape", "spiraled", "base")] });
    expect(resolve(groupFact("horns"))).toBe("Horns: spiraled");
  });

  it("falls back to the group word when nothing is authored — a sparse non-human must never refuse", () => {
    const resolve = visualFactClauseResolver({ attributes: [] });
    expect(resolve(groupFact("wings"))).toBe("wings");
  });

  it("answers a curated cut as a deliberate omission, and a valueless attribute as degradation", () => {
    const resolve = visualFactClauseResolver({
      attributes: [attr("hair.color", "deep_violet", "base")],
      omitAttributeIds: new Set(["hair.color"]),
    });
    expect(resolve(fact({}))).toEqual({ omit: VISUAL_CLAUSE_OMIT_CURATED });
    // No omit listing and no authored value: nothing honest to say — undefined,
    // which a required fact turns into a pre-spend refusal upstream.
    const bare = visualFactClauseResolver({ attributes: [] });
    expect(
      bare(fact({ sourceRef: { kind: "appearance", ref: { kind: "attribute", attributeId: "eyes.color" } } })),
    ).toBeUndefined();
  });

  it("resolves nothing for kinds with no phrasing arm — a fingerprint never becomes prompt text", () => {
    const resolve = visualFactClauseResolver({ attributes: [] });
    expect(
      resolve(
        fact({
          kindId: VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID,
          sourceRef: { kind: "appearance", ref: { kind: "anatomy", locusKey: "hands" } },
        }),
      ),
    ).toBeUndefined();
  });

  // The WP-C scene arms. The wardrobe case is the load-bearing one: a WORN
  // garment fact rides the digest's REQUIRED lane, so an arm that answered
  // `undefined` would put it in `missingRequired` and refuse every cast-1 scene
  // render in a chat with a garment store — over a garment the route-owned
  // outfit line states anyway. The others are the double-statement guards: the
  // garment narration owns garment-state prose, the scene plan owns pose.
  it.each([
    [
      "a worn garment defers to the route's authoritative outfit line",
      fact({
        kindId: VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
        locus: { kind: "item", itemInstanceId: "g1" },
        sourceRef: { kind: "garment", garmentInstanceId: "g1" },
        value: { name: "silk kimono", locus: { kind: "worn" } },
        segmentKind: "wardrobe",
      }),
      { omit: VISUAL_CLAUSE_OMIT_WARDROBE_ROUTE },
    ],
    [
      "garment current state defers to the garment narration",
      fact({
        kindId: VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
        locus: { kind: "garment_part", garmentInstanceId: "g1", partId: "front" },
        sourceRef: { kind: "garment_part", garmentInstanceId: "g1", partId: "front" },
        value: { channel: "closure", band: "open" },
        segmentKind: "current_state",
        required: false,
      }),
      { omit: VISUAL_CLAUSE_OMIT_GARMENT_NOTES },
    ],
    [
      "body language defers to the scene plan's staging and pose",
      fact({
        kindId: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
        locus: { kind: "subject", subjectId: "s" },
        sourceRef: { kind: "scene_relation", relationId: "r1" },
        value: { posture: "kneeling" },
        segmentKind: "pose",
        required: false,
      }),
      { omit: VISUAL_CLAUSE_OMIT_SCENE_PLAN },
    ],
  ])("%s", (_name, subject, expected) => {
    expect(visualFactClauseResolver({ attributes: [] })(subject)).toEqual(expected);
  });

  it("phrases current-state owners, and degrades a malformed value to silence", () => {
    const resolve = visualFactClauseResolver({ attributes: [] });
    const condition = fact({
      kindId: VISUAL_STATE_CONDITION_ACTIVE_KIND_ID,
      locus: { kind: "subject", subjectId: "s" },
      sourceRef: { kind: "body_condition", conditionId: "c1" },
      value: { condition: "blindfolded" },
      segmentKind: "current_state",
      required: false,
    });
    expect(resolve(condition)).toBe("blindfolded");
    const wetness = fact({
      kindId: VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID,
      locus: { kind: "body", locus: { bodyLocationId: "hair" } },
      sourceRef: { kind: "body_surface", subjectId: "s", locationId: "hair" },
      value: { band: "soaked" },
      segmentKind: "current_state",
      required: false,
    });
    expect(resolve(wetness)).toBe("hair soaked");
    // A value that fails its own schema is degradation — silence, never a
    // fingerprint or a guessed band in a provider prompt.
    expect(resolve({ ...condition, value: '"fingerprint"' })).toBeUndefined();
    expect(resolve({ ...wetness, value: { band: "dripping" } })).toBeUndefined();
  });
});

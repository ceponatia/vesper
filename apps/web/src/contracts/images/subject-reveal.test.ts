import { describe, expect, it } from "vitest";
import type { AttributeValue } from "../attributes";
import type { RegionExposure } from "../items/visibility";
import { realizeBody } from "../species";
import {
  IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT,
  IMAGE_SUBJECT_REVEAL_OWNER,
  subjectIntimateRevealFacts,
} from "./subject-reveal";

/**
 * The typed intimate reveal — what a permitting scene rung states beside the
 * cut, and the coverage rule that decides it. Both, because `revealSurfaces`
 * has one caller: the projection below. This file owns what the projection adds
 * (which attributes become facts at all, and the fact each becomes) AND the
 * region-by-region matrix — shape through clothing, skin when its own region is
 * bare, untagged anatomy when its own region is exposed, sensory never.
 *
 * Falsified against a projection that read every attribute (hair colour would
 * become an "intimate" fact), against one that skipped applicability (a body
 * with no breasts would state nipples), against one that gated every tier on
 * exposure alike (a dressed subject would state no silhouette at all), and
 * against one that read a single coverage answer for the whole body (a bare
 * pelvis would uncover the torso's skin).
 */

const base = (id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue => ({
  id,
  value,
  source: "base",
});
const COVERED = { torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" } as const;

describe("subjectIntimateRevealFacts", () => {
  const attributes = [
    base("hair.color", "auburn"), // not intimate at all
    base("breasts.size", "full"), // shape — reads through clothing
    base("breasts.nipples", "large"), // skin — needs the torso bare
    base("vulva.labia_minora", "protruding"), // untagged — needs the pelvis exposed
    base("vulva.scent", "musky"), // sensory — never renders, however bare the body
  ];

  it("projects only the intimate attributes this coverage state lets a route show, as typed subject facts", () => {
    const facts = subjectIntimateRevealFacts({
      subjectId: "chr-1",
      attributes,
      exposure: { ...COVERED, torso: "bare" },
      realizedBody: realizeBody({ intimateRegions: ["breasts", "vulva"] }),
    });
    expect(facts.map((fact) => fact.value)).toEqual(["breast size: full", "nipples: large"]);
    for (const fact of facts) {
      expect(fact.concept).toBe(IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT);
      expect(fact.subjectRef).toBe("subject.chr-1");
      expect(fact.disposition).toBe("optional_visual");
      expect(fact.source).toEqual({ owner: IMAGE_SUBJECT_REVEAL_OWNER, key: expect.any(String), entityId: "chr-1" });
    }
    expect(new Set(facts.map((fact) => fact.key)).size).toBe(facts.length);
  });

  it("gates each region on its OWN coverage, and states silhouette through clothing", () => {
    const reveal = (exposure: RegionExposure) =>
      subjectIntimateRevealFacts({
        subjectId: "chr-1",
        attributes,
        exposure,
        realizedBody: realizeBody({ intimateRegions: ["breasts", "vulva"] }),
      }).map((fact) => fact.value);
    // Dressed: the silhouette is all a covered body lets the prompt say.
    expect(reveal(COVERED)).toEqual(["breast size: full"]);
    // Bare below the waist only: the pelvis earns its untagged anatomy while the
    // still-covered torso keeps its surface detail withheld.
    expect(reveal({ ...COVERED, pelvis: "bare" })).toEqual(["breast size: full", "labia minora: protruding"]);
  });

  it("states nothing for anatomy the realized body does not have", () => {
    const facts = subjectIntimateRevealFacts({
      subjectId: "chr-1",
      attributes,
      exposure: { ...COVERED, torso: "bare", pelvis: "bare" },
      realizedBody: realizeBody({ intimateRegions: [] }),
    });
    expect(facts).toEqual([]);
  });
});

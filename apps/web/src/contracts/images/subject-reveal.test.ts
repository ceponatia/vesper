import { describe, expect, it } from "vitest";
import type { AttributeValue } from "../attributes";
import { realizeBody } from "../species";
import {
  IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT,
  IMAGE_SUBJECT_REVEAL_OWNER,
  subjectIntimateRevealFacts,
} from "./subject-reveal";

/**
 * The typed intimate reveal — what a permitting scene rung states beside the
 * cut. The coverage rule itself (shape through clothing, skin when bare,
 * untagged anatomy when exposed, sensory never) is `revealSurfaces`, pinned by
 * the prose reveal's matrix in `server/images/prompts.test.ts`, which calls the
 * same function; this file owns only what the projection adds — which
 * attributes become facts at all, and the fact each becomes.
 *
 * Falsified against a projection that read every attribute (hair colour would
 * become an "intimate" fact) and against one that skipped applicability (a body
 * with no breasts would state nipples).
 */

const base = (id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue => ({
  id,
  value,
  source: "base",
});
const COVERED = { torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" } as const;

describe("subjectIntimateRevealFacts", () => {
  const attributes = [
    base("hair.color", "auburn"),
    base("breasts.size", "full"),
    base("breasts.nipples", "large"),
    base("vulva.labia_minora", "protruding"),
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

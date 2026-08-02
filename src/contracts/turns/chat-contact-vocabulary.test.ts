import { describe, expect, it } from "vitest";
import {
  chatAffectionateTargetLocationIds,
  chatAffectionateTargetLocationOf,
  chatContactGestureSchema,
  chatContactGestures,
  chatContactTargetNounAlternation,
  contactSentenceEligible,
  normalizeTypographicQuotes,
  CHAT_CONTACT_SOURCE_LOCATION,
  CHAT_CONTACT_TARGET_LOCATION,
  CHAT_GESTURE_CONTACT,
} from "./chat-contact-vocabulary";

/**
 * The shared chat-contact vocabulary
 * (romantic-contact-affordances.spec.actor-control.md §"Closed decision
 * schema": one vocabulary for the detector, the classifier schema, the
 * evidence verifiers, and the adapter).
 *
 * These tests pin the two things a shared vocabulary exists for: the derived
 * artifacts (canonical-id enum, noun alternation) can never drift from the
 * map they derive from, and the sentence gates moved here behave exactly as
 * they did inside the adapter.
 */

describe("the target-location vocabulary", () => {
  it("keeps the canonical-id enum in lockstep with the map values", () => {
    expect(new Set(chatAffectionateTargetLocationIds)).toEqual(new Set(Object.values(CHAT_CONTACT_TARGET_LOCATION)));
  });

  it("resolves written nouns to canonical ids, case- and whitespace-insensitively", () => {
    expect(chatAffectionateTargetLocationOf("shoulder")).toBe("shoulders");
    expect(chatAffectionateTargetLocationOf("Upper Back")).toBe("back");
    expect(chatAffectionateTargetLocationOf("  hand ")).toBe("hands");
    expect(chatAffectionateTargetLocationOf("thigh")).toBeUndefined();
    expect(chatAffectionateTargetLocationOf("")).toBeUndefined();
  });

  it("orders the noun alternation longest-first so compound nouns win", () => {
    const re = new RegExp(`\\b(${chatContactTargetNounAlternation})\\b`, "iu");
    expect(re.exec("her upper back")?.[1]).toBe("upper back");
    expect(re.exec("her shoulders")?.[1]).toBe("shoulders");
    expect(re.exec("her upper arm")?.[1]).toBe("upper arm");
    expect(re.exec("her arm")?.[1]).toBe("arm");
  });

  it("carries every map noun in the alternation", () => {
    const re = new RegExp(`^(?:${chatContactTargetNounAlternation})$`, "iu");
    for (const noun of Object.keys(CHAT_CONTACT_TARGET_LOCATION)) {
      expect(noun).toMatch(re);
    }
  });
});

describe("the gesture vocabulary", () => {
  it("is the closed three-gesture set with a schema over exactly those members", () => {
    expect(chatContactGestures).toEqual(["rest", "pat", "squeeze"]);
    expect(chatContactGestureSchema.safeParse("rest").success).toBe(true);
    expect(chatContactGestureSchema.safeParse("stroke").success).toBe(false);
  });

  it("states pressure per gesture and never states an area", () => {
    expect(CHAT_GESTURE_CONTACT.rest).toEqual({ pressure: "light" });
    expect(CHAT_GESTURE_CONTACT.pat).toEqual({ pressure: "light", motion: "tapping" });
    expect(CHAT_GESTURE_CONTACT.squeeze).toEqual({ pressure: "moderate" });
    for (const gesture of chatContactGestures) {
      expect(CHAT_GESTURE_CONTACT[gesture].area).toBeUndefined();
    }
  });

  it("keeps the acting surface constant", () => {
    expect(CHAT_CONTACT_SOURCE_LOCATION).toBe("hands");
  });
});

describe("the shared sentence gate (moved verbatim from the adapter)", () => {
  it("accepts a plain completed affectionate sentence", () => {
    expect(contactSentenceEligible("I rest my hand on your shoulder.")).toBe(true);
  });

  it("vetoes questions, hedges, negation, and romantic framing", () => {
    expect(contactSentenceEligible("Do I rest my hand on your shoulder?")).toBe(false);
    expect(contactSentenceEligible("Maybe I rest my hand on your shoulder.")).toBe(false);
    expect(contactSentenceEligible("I don't rest my hand on your shoulder.")).toBe(false);
    expect(contactSentenceEligible("I kiss you and rest my hand on your shoulder.")).toBe(false);
    expect(contactSentenceEligible("I rest my hand on your thigh.")).toBe(false);
  });
});

describe("quote normalization", () => {
  it("maps curly quotes to straight ones without changing a single offset", () => {
    const raw = "“Don’t pull away,” she says.";
    const normalized = normalizeTypographicQuotes(raw);
    expect(normalized).toBe("\"Don't pull away,\" she says.");
    expect(normalized.length).toBe(raw.length);
  });
});

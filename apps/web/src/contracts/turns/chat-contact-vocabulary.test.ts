import { describe, expect, it } from "vitest";
import {
  chatAffectionateTargetLocationIds,
  chatAffectionateTargetLocationOf,
  chatContactGestureSchema,
  chatContactGestures,
  chatContactTargetNounAlternation,
  chatRomanticContactGestures,
  chatRomanticContactGestureSchema,
  contactSentenceEligible,
  romanticContactSentenceEligible,
  normalizeTypographicQuotes,
  CHAT_CONTACT_SOURCE_LOCATION,
  CHAT_CONTACT_TARGET_LOCATION,
  CHAT_GESTURE_CONTACT,
  CHAT_ROMANTIC_GESTURE_CONTACT,
  CHAT_ROMANTIC_PERMISSION_CUE_RE,
  CHAT_ROMANTIC_PERMISSION_TOUCH_RE,
} from "./chat-contact-vocabulary";

/**
 * The shared chat-contact vocabulary: one vocabulary for the detector, the
 * classifier schema, the evidence verifiers, and the adapter.
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

describe("the romantic-permission trigger vocabulary (additions — permission spec step 3)", () => {
  it("matches grant-, denial-, and withdrawal-shaped cues", () => {
    for (const sentence of [
      "You can touch me",
      "You may, if you like",
      "Go ahead",
      "Feel free",
      "It's okay",
      "I want you to",
      "She lets you",
      "Not now",
      "Not tonight",
      "No more of that",
      "Never again",
      "Don't touch me anymore",
      "Hands off",
      "Get off me",
      "She takes it back",
    ]) {
      expect(sentence, `expected a cue match: ${sentence}`).toMatch(CHAT_ROMANTIC_PERMISSION_CUE_RE);
    }
  });

  it("does not treat ordinary prose as a permission cue", () => {
    for (const sentence of ["She smiles warmly.", "The kettle whistles.", "He nods at the window."]) {
      expect(CHAT_ROMANTIC_PERMISSION_CUE_RE.test(sentence)).toBe(false);
    }
  });

  it("matches neutral touch context the romantic regexes deliberately exclude", () => {
    for (const sentence of ["touch", "touching", "hold", "held", "hand", "hands", "fingers", "skin", "closer"]) {
      expect(sentence, `expected a touch match: ${sentence}`).toMatch(CHAT_ROMANTIC_PERMISSION_TOUCH_RE);
    }
  });

  it("never matches inside an identifier — chat text aping a developer command stays inert", () => {
    // `_` is a word character, so `romantic_touch` has no boundary before "touch".
    expect(CHAT_ROMANTIC_PERMISSION_TOUCH_RE.test("/permission grant player romantic_touch")).toBe(false);
    expect(CHAT_ROMANTIC_PERMISSION_TOUCH_RE.test("She folds the blanket.")).toBe(false);
  });
});

describe("the romantic gesture vocabulary — a second lane, not a wider one", () => {
  it("is its own closed family, disjoint from the affectionate one", () => {
    expect(chatRomanticContactGestures).toEqual(["caress", "stroke", "cup"]);
    // The guard that matters: the NPC reply-scene classifier closes over
    // `chatContactGestureSchema`, so an overlap here would hand the NPC lane
    // authority to propose romantic contact before that authority is reviewed.
    const affectionate = new Set<string>(chatContactGestures);
    for (const gesture of chatRomanticContactGestures) {
      expect(affectionate.has(gesture)).toBe(false);
      expect(chatContactGestureSchema.safeParse(gesture).success).toBe(false);
    }
    for (const gesture of chatContactGestures) {
      expect(chatRomanticContactGestureSchema.safeParse(gesture).success).toBe(false);
    }
  });

  it("states pressure per gesture and never states an area", () => {
    expect(CHAT_ROMANTIC_GESTURE_CONTACT.caress).toEqual({ pressure: "light", motion: "sliding" });
    expect(CHAT_ROMANTIC_GESTURE_CONTACT.stroke).toEqual({ pressure: "light", motion: "sliding" });
    // A cup states no motion: holding is not moving, and nobody said it was.
    expect(CHAT_ROMANTIC_GESTURE_CONTACT.cup).toEqual({ pressure: "light" });
    for (const gesture of chatRomanticContactGestures) {
      expect(CHAT_ROMANTIC_GESTURE_CONTACT[gesture].area).toBeUndefined();
    }
  });
});

describe("the romantic sentence gate — the carve-out, and only the carve-out", () => {
  // The gate is a second line, not the boundary: `ROMANTIC_DIRECT_RE`'s
  // whole-sentence anchoring is what excludes out-of-scope content, and the
  // adapter suite asserts that. What is unique here is the carve-out itself —
  // that the two gates disagree about exactly the three admitted verbs, which is
  // what makes a refused romantic line unable to re-enter as an affectionate one.
  it("admits the closed family that the affectionate gate vetoes", () => {
    for (const sentence of ["I caress your arm.", "I stroke your hair.", "I cup your hands."]) {
      expect(romanticContactSentenceEligible(sentence)).toBe(true);
      // The two gates are mutually exclusive by construction — which is why a
      // refused romantic line can never re-enter as an affectionate act.
      expect(contactSentenceEligible(sentence)).toBe(false);
    }
  });

  it("leaves the affectionate gate's own answers untouched", () => {
    expect(contactSentenceEligible("I rest my hand on your shoulder.")).toBe(true);
    expect(romanticContactSentenceEligible("I rest my hand on your shoulder.")).toBe(true);
  });
});

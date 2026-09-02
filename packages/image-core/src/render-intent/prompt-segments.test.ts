import { DiagnosticCollector } from "@vesper/contracts";
import { describe, expect, it } from "vitest";
import {
  fitImagePromptSegments,
  type ImagePromptBudget,
  type ImagePromptSegment,
  type ImagePromptSegmentKind,
  imagePromptBudgetFromBinding,
  imagePromptSegmentKinds,
  isMandatoryImagePromptSegmentKind,
  joinImagePromptSegments,
  normalizeImagePromptSegments,
  orderImagePromptSegments,
  reportImagePromptFitting,
} from "./prompt-segments";

/**
 * One segment, with the boilerplate defaulted. `mandatory` defaults to the kind's
 * own classification so a fixture does not have to restate the spec's floor, and
 * every test that cares states it.
 */
function segment(
  kind: ImagePromptSegmentKind,
  text: string,
  extra: Partial<Omit<ImagePromptSegment, "kind" | "text">> = {},
): ImagePromptSegment {
  return { kind, text, mandatory: isMandatoryImagePromptSegmentKind(kind), priority: 0, ...extra };
}

const kinds = (segments: readonly ImagePromptSegment[]): ImagePromptSegmentKind[] =>
  segments.map((entry) => entry.kind);

describe("segment vocabulary", () => {
  it("classifies exactly the kinds the spec names as mandatory", () => {
    const mandatory = imagePromptSegmentKinds.filter(isMandatoryImagePromptSegmentKind);
    expect(mandatory).toEqual(["operation", "identity", "morphology", "age", "wardrobe", "exposure"]);
  });

  it("keeps the canonical order the spec's union declares", () => {
    expect(imagePromptSegmentKinds).toEqual([
      "operation",
      "identity",
      "morphology",
      "age",
      "framing",
      "pose",
      "current_state",
      "wardrobe",
      "exposure",
      "setting",
      "lighting",
      "atmosphere",
      "style",
      "quality",
    ]);
  });
});

describe("orderImagePromptSegments", () => {
  it("emits canonical kind order regardless of the order supplied", () => {
    const ordered = orderImagePromptSegments([
      segment("quality", "sharp."),
      segment("identity", "Mira."),
      segment("setting", "a cafe."),
      segment("operation", "Change only the outfit."),
    ]);
    expect(kinds(ordered)).toEqual(["operation", "identity", "setting", "quality"]);
  });

  it("breaks ties within a kind by priority, then by the caller's order", () => {
    const ordered = orderImagePromptSegments([
      segment("setting", "low", { priority: 1 }),
      segment("setting", "high", { priority: 9 }),
      segment("setting", "also low", { priority: 1 }),
    ]);
    expect(ordered.map((entry) => entry.text)).toEqual(["high", "low", "also low"]);
  });

  it("never lets priority move a segment across kinds", () => {
    // A wildly prioritized atmosphere segment still reads AFTER identity: priority
    // decides who is eaten first, never who is read first.
    const ordered = orderImagePromptSegments([
      segment("atmosphere", "moody.", { priority: 100 }),
      segment("identity", "Mira.", { priority: -100 }),
    ]);
    expect(kinds(ordered)).toEqual(["identity", "atmosphere"]);
  });

  it("does not reorder the caller's array", () => {
    const supplied = [segment("quality", "sharp."), segment("identity", "Mira.")];
    orderImagePromptSegments(supplied);
    expect(kinds(supplied)).toEqual(["quality", "identity"]);
  });
});

describe("normalizeImagePromptSegments", () => {
  it("promotes a load-bearing kind that arrived optional, and says so", () => {
    const sink = new DiagnosticCollector();
    const [normalized] = normalizeImagePromptSegments(
      [{ kind: "age", text: "an adult in her late twenties.", mandatory: false, priority: 0, source: "character.age" }],
      sink,
    );
    expect(normalized?.mandatory).toBe(true);
    const codes = sink.items.map((entry) => entry.code);
    expect(codes).toContain("image_prompt.segment_mandatory_promoted");
  });

  it("drops an empty segment with a diagnostic rather than emitting blank text", () => {
    const sink = new DiagnosticCollector();
    const normalized = normalizeImagePromptSegments([segment("setting", "   "), segment("identity", "Mira.")], sink);
    expect(kinds(normalized)).toEqual(["identity"]);
    expect(sink.items.map((entry) => entry.code)).toContain("image_prompt.segment_empty");
  });

  it("trims text and repairs a non-finite priority", () => {
    const [normalized] = normalizeImagePromptSegments([segment("style", "  painterly.  ", { priority: Number.NaN })]);
    expect(normalized?.text).toBe("painterly.");
    expect(normalized?.priority).toBe(0);
  });

  it("leaves a well-formed optional segment alone and reports nothing", () => {
    const sink = new DiagnosticCollector();
    const normalized = normalizeImagePromptSegments([segment("lighting", "warm evening light.")], sink);
    expect(normalized[0]?.mandatory).toBe(false);
    expect(sink.items).toEqual([]);
  });
});

describe("fitImagePromptSegments", () => {
  const identity = segment("identity", "Preserve Mira's exact face. Preserve her hair and skin tone.");
  const setting = segment("setting", "A cafe interior. Rain on the windows.", { priority: 5 });
  const atmosphere = segment("atmosphere", "Quiet and unhurried.", { priority: 1 });
  const lighting = segment("lighting", "Warm evening light.", { priority: 3 });

  it("keeps every segment when no budget is declared", () => {
    const fitted = fitImagePromptSegments([identity, setting, atmosphere]);
    expect(kinds(fitted.segments)).toEqual(["identity", "setting", "atmosphere"]);
    expect(fitted.removed).toEqual([]);
    expect(fitted.overBudget).toBe(false);
  });

  it("gives up the LOWEST-priority optional segment first", () => {
    const fitted = fitImagePromptSegments([identity, setting, lighting, atmosphere], { maxCharacters: 120 });
    // atmosphere (priority 1) is a single sentence, so it goes entirely before
    // lighting (3) or setting (5) is touched.
    expect(kinds(fitted.removed)).toEqual(["atmosphere"]);
    expect(kinds(fitted.segments)).toContain("identity");
  });

  it("compresses a multi-sentence optional segment before removing it", () => {
    // Budget forces exactly one sentence out of `setting`; nothing is removed.
    const fitted = fitImagePromptSegments([identity, setting], { maxCharacters: 78 });
    expect(fitted.removed).toEqual([]);
    expect(fitted.compressed).toEqual([{ kind: "setting", droppedSentences: 1 }]);
    expect(fitted.segments.find((entry) => entry.kind === "setting")?.text).toBe("A cafe interior.");
  });

  it("degrades an unprioritized prompt from its tail", () => {
    const fitted = fitImagePromptSegments(
      [segment("identity", "Mira."), segment("setting", "A cafe."), segment("quality", "Sharp.")],
      { maxCharacters: 15 },
    );
    // Equal priority everywhere, so the later canonical kind goes first.
    expect(kinds(fitted.removed)).toEqual(["quality"]);
  });

  it("never removes a mandatory segment, even when nothing else is left", () => {
    const fitted = fitImagePromptSegments([identity, segment("age", "An adult in her late twenties.")], {
      maxCharacters: 10,
    });
    expect(fitted.removed).toEqual([]);
    expect(kinds(fitted.segments).sort()).toEqual(["age", "identity"]);
    expect(fitted.overBudget).toBe(true);
  });

  it("shortens a mandatory segment only by whole sentences, never mid-sentence", () => {
    const fitted = fitImagePromptSegments([identity], { maxCharacters: 40 });
    const text = fitted.segments[0]?.text ?? "";
    expect(text).toBe("Preserve Mira's exact face.");
    // The property the spec states: whatever survives ends where a sentence ended.
    expect(text.endsWith(".")).toBe(true);
  });

  it("stops compressing a mandatory segment at its last sentence", () => {
    const fitted = fitImagePromptSegments([segment("identity", "Preserve Mira's exact face.")], { maxCharacters: 5 });
    expect(fitted.segments[0]?.text).toBe("Preserve Mira's exact face.");
    expect(fitted.overBudget).toBe(true);
  });

  it("does not touch a mandatory segment to satisfy the ADVISORY length alone", () => {
    // Over the recommendation, under the provider's ceiling: the render is fine,
    // and cutting an identity lock to chase a quality hint would trade a real
    // guarantee for a soft one.
    const fitted = fitImagePromptSegments([identity], { recommendedCharacters: 20, maxCharacters: 10_000 });
    expect(fitted.compressed).toEqual([]);
    expect(fitted.withinRecommended).toBe(false);
    expect(fitted.overBudget).toBe(false);
  });

  it("exhausts optional material before a mandatory segment loses a sentence", () => {
    // An advisory length ABOVE the hard ceiling is a misconfiguration; phase 1
    // stops early, and the hard-ceiling pass must still eat the optional segment
    // before it touches identity.
    const fitted = fitImagePromptSegments([identity, atmosphere], {
      recommendedCharacters: 10_000,
      maxCharacters: 62,
    });
    expect(kinds(fitted.removed)).toEqual(["atmosphere"]);
    expect(fitted.compressed).toEqual([]);
  });
});

describe("joinImagePromptSegments", () => {
  it("emits only the segments' prose, in the order given", () => {
    expect(joinImagePromptSegments([segment("identity", "Mira."), segment("setting", "A cafe.")])).toBe(
      "Mira. A cafe.",
    );
  });

  it("never emits a segment's diagnostic source", () => {
    const compiled = joinImagePromptSegments([
      segment("identity", "Mira.", { source: "SOURCE-CANARY.character.attributes" }),
    ]);
    expect(compiled).toBe("Mira.");
    expect(compiled).not.toContain("SOURCE-CANARY");
  });

  it("never emits a segment's tag rendering into prose", () => {
    const compiled = joinImagePromptSegments([segment("style", "Painterly.", { tagText: "TAG-CANARY, painterly" })]);
    expect(compiled).toBe("Painterly.");
    expect(compiled).not.toContain("TAG-CANARY");
  });
});

describe("reportImagePromptFitting", () => {
  // The dialects' own sequence: normalize, fit, then report what fitting cost.
  const report = (segments: ImagePromptSegment[], budget: ImagePromptBudget, sink: DiagnosticCollector) =>
    reportImagePromptFitting(fitImagePromptSegments(normalizeImagePromptSegments(segments), budget), budget, sink);

  it("reports the trim as an info diagnostic when optional detail goes", () => {
    const sink = new DiagnosticCollector();
    report(
      [segment("identity", "Preserve Mira's exact face."), segment("atmosphere", "Quiet and unhurried.")],
      { maxCharacters: 30 },
      sink,
    );
    const trimmed = sink.items.find((entry) => entry.code === "image_prompt.segments_trimmed");
    expect(trimmed?.severity).toBe("info");
    expect(trimmed?.context?.removed).toEqual(["atmosphere"]);
  });

  it("warns when a mandatory segment had to lose a sentence", () => {
    const sink = new DiagnosticCollector();
    report([segment("identity", "Preserve Mira's exact face. Preserve her hair and skin tone.")], { maxCharacters: 40 }, sink);
    const warned = sink.items.find((entry) => entry.code === "image_prompt.mandatory_segment_compressed");
    expect(warned?.severity).toBe("warn");
  });

  it("reports the spec's prompt_too_long_required code rather than cutting a sentence in half", () => {
    const sink = new DiagnosticCollector();
    const fitted = fitImagePromptSegments([segment("identity", "Preserve Mira's exact face.")], { maxCharacters: 5 });
    reportImagePromptFitting(fitted, { maxCharacters: 5 }, sink);
    expect(joinImagePromptSegments(fitted.segments)).toBe("Preserve Mira's exact face.");
    const refused = sink.items.find((entry) => entry.code === "image_model.prompt_too_long_required");
    expect(refused?.severity).toBe("warn");
    expect(refused?.context?.maximum).toBe(5);
  });

  it("reports nothing when everything fits", () => {
    const sink = new DiagnosticCollector();
    report([segment("identity", "Mira.")], { maxCharacters: 500 }, sink);
    expect(sink.items).toEqual([]);
  });
});

describe("imagePromptBudgetFromBinding", () => {
  it("is empty when the version declares no prompt binding — no render is fitted today", () => {
    expect(imagePromptBudgetFromBinding(undefined)).toEqual({});
  });

  it("carries only the halves the probe actually recorded", () => {
    expect(imagePromptBudgetFromBinding({ field: "prompt", maxChars: 1024 })).toEqual({ maxCharacters: 1024 });
    expect(imagePromptBudgetFromBinding({ field: "prompt", maxChars: 1024, recommendedChars: 512 })).toEqual({
      maxCharacters: 1024,
      recommendedCharacters: 512,
    });
  });
});

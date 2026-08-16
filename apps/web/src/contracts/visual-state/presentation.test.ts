import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { crookedNoseAttributes, projectFixture } from "../appearance-features";
import { DiagnosticCollector } from "../diagnostics";
import { adaptProjectedAppearanceTruth } from "./compat";
import {
  VISUAL_STATE_KIND_UNKNOWN,
  VISUAL_STATE_LOCUS_INVALID,
  VISUAL_STATE_LOCUS_NOT_ALLOWED,
  VISUAL_STATE_PRESENTATION_ENTRY_MALFORMED,
  VISUAL_STATE_PRESENTATION_ENTRY_UNKNOWN,
  VISUAL_STATE_PRESENTATION_OPERATION_INVALID,
  VISUAL_STATE_VALUE_INVALID,
} from "./diagnostics";
import { visualStateGroomedPresentation, VISUAL_STATE_FIXTURE_SUBJECT_ID } from "./fixtures";
import {
  applyPresentationOperations,
  emptyCharacterPresentationState,
  parseCharacterPresentationState,
  parsePresentationOperations,
  presentationAspect,
  projectPresentationFeatures,
  PRESENTATION_MAX_ENTRIES,
  PRESENTATION_MAX_OPERATIONS,
  type CharacterPresentationState,
  type PresentationOperation,
} from "./presentation";

/**
 * The non-item presentation owner: the only place in this folder that owns truth
 * rather than reading it, so it is judged on the two properties that make that
 * safe — every write is a typed operation, and every value is a closed
 * vocabulary the registry parses.
 */

const HAIR_LOCUS = { kind: "body", locus: { bodyLocationId: "hair" } } as const;
const FACE_LOCUS = { kind: "body", locus: { bodyLocationId: "face" } } as const;

function applyHair(overrides: Partial<Extract<PresentationOperation, { kind: "apply" }>> = {}): PresentationOperation {
  return {
    kind: "apply",
    entryId: "pres_hair",
    subjectId: VISUAL_STATE_FIXTURE_SUBJECT_ID,
    kindId: "presentation.hairstyle",
    locus: HAIR_LOCUS,
    value: { arrangement: "loose" },
    atMinutes: 10,
    ...overrides,
  };
}

/** One grooming choice — the kind whose value discriminates several facts at one locus. */
function grooming(entryId: string, area: string, state: string, atMinutes = 10): PresentationOperation {
  return applyHair({
    entryId,
    kindId: "presentation.grooming",
    locus: FACE_LOCUS,
    value: { area, state },
    atMinutes,
  });
}

function reduce(
  operations: readonly PresentationOperation[],
  sink?: DiagnosticCollector,
  state: CharacterPresentationState = emptyCharacterPresentationState(),
): CharacterPresentationState {
  return applyPresentationOperations(state, operations, sink);
}

describe("applyPresentationOperations", () => {
  it("applies a typed choice", () => {
    const sink = new DiagnosticCollector();
    const state = reduce([applyHair()], sink);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.value).toEqual({ arrangement: "loose" });
    expect(state.entries[0]?.appliedAtMinutes).toBe(10);
    expectCleanSink(sink);
  });

  it("removes a choice by id", () => {
    const state = reduce([applyHair(), { kind: "remove", entryId: "pres_hair", atMinutes: 20 }]);
    expect(state.entries).toEqual([]);
  });

  it("supersedes the previous choice at the same subject, kind and locus", () => {
    const state = reduce([applyHair(), applyHair({ entryId: "pres_hair_2", value: { arrangement: "bun" }, atMinutes: 30 })]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.id).toBe("pres_hair_2");
    expect(state.entries[0]?.supersedesEntryId).toBe("pres_hair");
    expect(state.entries[0]?.value).toEqual({ arrangement: "bun" });
  });

  it("keeps two different choices on one body at once", () => {
    const state = visualStateGroomedPresentation();
    expect(state.entries.map((entry) => entry.kindId)).toEqual([
      "presentation.hairstyle",
      "presentation.makeup",
    ]);
  });

  it("rearranges hair without claiming it was reapplied", () => {
    const state = reduce([applyHair(), { kind: "rearrange", entryId: "pres_hair", arrangement: "bun", atMinutes: 40 }]);
    expect(state.entries[0]?.value).toEqual({ arrangement: "bun" });
    expect(state.entries[0]?.appliedAtMinutes).toBe(10);
    expect(state.entries[0]?.changedAtMinutes).toBe(40);
  });

  it("smudges makeup into a disturbed presentation, not a new facial mark", () => {
    const state = reduce([
      applyHair({ entryId: "pres_makeup", kindId: "presentation.makeup", locus: FACE_LOCUS, value: { style: "defined" } }),
      { kind: "smudge", entryId: "pres_makeup", disturbance: "smudged", atMinutes: 50 },
    ]);
    expect(state.entries[0]?.value).toEqual({ style: "defined", disturbance: "smudged" });
    expect(state.entries[0]?.kindId).toBe("presentation.makeup");
  });

  it("restores a disturbance and leaves everything else alone", () => {
    const state = reduce([
      applyHair(),
      { kind: "rearrange", entryId: "pres_hair", arrangement: "bun", atMinutes: 40 },
      { kind: "smudge", entryId: "pres_hair", disturbance: "tousled", atMinutes: 50 },
      { kind: "restore", entryId: "pres_hair", atMinutes: 60 },
    ]);
    // The hair is genuinely in a bun now — restoring undoes the tousling, not
    // the choice that was deliberately made.
    expect(state.entries[0]?.value).toEqual({ arrangement: "bun" });
    expect(state.entries[0]?.changedAtMinutes).toBe(60);
  });

  // A registered-but-item-backed kind is a different failure from an
  // unregistered one, and reporting both as "unknown kind" sent a reader looking
  // for a missing registry row that is right there.
  it("refuses an item-backed kind, so a garment cannot be applied as a bare choice", () => {
    const sink = new DiagnosticCollector();
    const state = reduce([applyHair({ kindId: "wardrobe.garment", value: { name: "coat", locus: { kind: "worn", actorId: "c:x" } } })], sink);
    expect(state.entries).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_OPERATION_INVALID);
  });

  it("refuses a kind nothing registers", () => {
    const sink = new DiagnosticCollector();
    expect(reduce([applyHair({ kindId: "presentation.tattoo_sleeve" })], sink).entries).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_KIND_UNKNOWN);
  });

  it("refuses a value outside the kind's vocabulary", () => {
    const sink = new DiagnosticCollector();
    expect(reduce([applyHair({ value: { arrangement: "however she likes it" } })], sink).entries).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_VALUE_INVALID);
  });

  it("refuses a locus kind the choice cannot sit at", () => {
    const sink = new DiagnosticCollector();
    const state = reduce([applyHair({ locus: { kind: "item", itemInstanceId: "g1" } })], sink);
    expect(state.entries).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_LOCUS_NOT_ALLOWED);
  });

  it("refuses a body location the registry does not know", () => {
    const sink = new DiagnosticCollector();
    const state = reduce([applyHair({ locus: { kind: "body", locus: { bodyLocationId: "not_a_place" } } })], sink);
    expect(state.entries).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_LOCUS_INVALID);
  });

  it("refuses to reuse an entry id", () => {
    const sink = new DiagnosticCollector();
    const state = reduce([applyHair(), applyHair({ locus: FACE_LOCUS })], sink);
    expect(state.entries).toHaveLength(1);
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_OPERATION_INVALID);
  });

  it("reports an operation against an entry that is not there", () => {
    const sink = new DiagnosticCollector();
    expect(reduce([{ kind: "remove", entryId: "pres_ghost", atMinutes: 10 }], sink).entries).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_ENTRY_UNKNOWN);
  });

  it("refuses to rearrange something with no arrangement", () => {
    const sink = new DiagnosticCollector();
    const state = reduce([
      applyHair({ entryId: "pres_nails", kindId: "presentation.nail_finish", locus: { kind: "body", locus: { bodyLocationId: "fingers" } }, value: { finish: "painted" } }),
      { kind: "rearrange", entryId: "pres_nails", arrangement: "bun", atMinutes: 20 },
    ], sink);
    expect(state.entries[0]?.value).toEqual({ finish: "painted" });
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_OPERATION_INVALID);
  });

  it("refuses to smudge something that cannot be disturbed", () => {
    const sink = new DiagnosticCollector();
    const state = reduce([
      applyHair({ entryId: "pres_brows", kindId: "presentation.grooming", locus: FACE_LOCUS, value: { area: "brows", state: "shaped" } }),
      { kind: "smudge", entryId: "pres_brows", disturbance: "smudged", atMinutes: 20 },
    ], sink);
    expect(state.entries[0]?.value).toEqual({ area: "brows", state: "shaped" });
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_OPERATION_INVALID);
  });

  /**
   * The grooming vocabulary discriminates four areas and the body registry has
   * no `brows` location, so brow grooming and facial-hair grooming both sit at
   * `face`. Without a discriminator in the slot, applying the second silently
   * deleted the first — two distinct facts, one slot, empty sink.
   */
  it("keeps two groomings of different areas at one body location", () => {
    const sink = new DiagnosticCollector();
    const state = reduce([grooming("pres_brows", "brows", "shaped"), grooming("pres_beard", "facial_hair", "trimmed")], sink);
    expect(state.entries.map((entry) => entry.id)).toEqual(["pres_beard", "pres_brows"]);
    expectCleanSink(sink);
  });

  it("still supersedes within one grooming area", () => {
    const state = reduce([grooming("pres_brows", "brows", "shaped"), grooming("pres_brows_2", "brows", "natural")]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.supersedesEntryId).toBe("pres_brows");
  });

  it("refuses an entry id the record schema rejects", () => {
    const sink = new DiagnosticCollector();
    const state = reduce([applyHair({ entryId: "p".repeat(200) })], sink);
    expect(state.entries).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_ENTRY_MALFORMED);
  });

  it("refuses a story minute before the beginning of the conversation", () => {
    const sink = new DiagnosticCollector();
    expect(reduce([applyHair({ atMinutes: -5 })], sink).entries).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_ENTRY_MALFORMED);
  });

  /**
   * The write path and the reload path have to produce the SAME entry. When only
   * the reload path ran the record schema, a padded subject id was admitted
   * untrimmed, projected under one key, and came back from storage under
   * another — with nothing reported at either end.
   */
  it("normalizes a padded subject id on the way in, not only on the way back", () => {
    const state = reduce([applyHair({ subjectId: "  padded_subject  " })]);
    expect(state.entries[0]?.subjectId).toBe("padded_subject");
    expect(parseCharacterPresentationState(JSON.parse(JSON.stringify(state)) as unknown)).toEqual(state);
  });

  it("does not stamp a change time for a restore that restores nothing", () => {
    const state = reduce([applyHair(), { kind: "restore", entryId: "pres_hair", atMinutes: 60 }]);
    expect(state.entries[0]?.changedAtMinutes).toBeUndefined();
  });

  it("does not stamp a change time for a rearrange to the arrangement already in force", () => {
    const state = reduce([applyHair(), { kind: "rearrange", entryId: "pres_hair", arrangement: "loose", atMinutes: 60 }]);
    expect(state.entries[0]?.changedAtMinutes).toBeUndefined();
  });

  it("refuses to restore something that cannot be disturbed", () => {
    const sink = new DiagnosticCollector();
    const state = reduce([grooming("pres_brows", "brows", "shaped"), { kind: "restore", entryId: "pres_brows", atMinutes: 20 }], sink);
    expect(state.entries[0]?.value).toEqual({ area: "brows", state: "shaped" });
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_OPERATION_INVALID);
  });

  it("evicts the oldest choice when the entry cap is reached", () => {
    const operations = Array.from({ length: PRESENTATION_MAX_ENTRIES + 2 }, (_, index) =>
      grooming(`pres_${String(index).padStart(2, "0")}`, "brows", "shaped", index),
    );
    // Every one of these supersedes the last (same subject, locus and area), so
    // the cap is reached with a mark fixture instead.
    const marks = Array.from({ length: PRESENTATION_MAX_ENTRIES + 2 }, (_, index) =>
      applyHair({
        entryId: `pres_mark_${String(index).padStart(2, "0")}`,
        kindId: "presentation.cosmetic_mark",
        locus: FACE_LOCUS,
        value: { mark: index % 2 === 0 ? "glitter" : "bindi" },
        atMinutes: index,
      }),
    );
    expect(operations).toHaveLength(PRESENTATION_MAX_ENTRIES + 2);
    const state = reduce(marks);
    expect(state.entries.length).toBeLessThanOrEqual(PRESENTATION_MAX_ENTRIES);
  });

  /** Nothing enforces copy-on-write, so it is asserted rather than assumed. */
  it("never mutates the state it was given", () => {
    const before = visualStateGroomedPresentation();
    const snapshot = JSON.stringify(before);
    applyPresentationOperations(before, [
      { kind: "smudge", entryId: "pres_makeup", disturbance: "smudged", atMinutes: 90 },
      { kind: "remove", entryId: "pres_hair", atMinutes: 95 },
    ]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("orders entries the same way whatever order the operations arrived in", () => {
    const hair = applyHair();
    const makeup = applyHair({ entryId: "pres_makeup", kindId: "presentation.makeup", locus: FACE_LOCUS, value: { style: "natural" } });
    expect(JSON.stringify(reduce([hair, makeup]))).toBe(JSON.stringify(reduce([makeup, hair])));
  });
});

describe("parsePresentationOperations", () => {
  it("keeps the usable operations and drops the rest one by one", () => {
    const sink = new DiagnosticCollector();
    const parsed = parsePresentationOperations(
      [applyHair(), { kind: "teleport", entryId: "x" }, { kind: "remove", entryId: "pres_hair", atMinutes: 20 }],
      sink,
    );
    expect(parsed.map((operation) => operation.kind)).toEqual(["apply", "remove"]);
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_OPERATION_INVALID, { times: 1 });
  });

  it("degrades a payload that is not a list at all", () => {
    const sink = new DiagnosticCollector();
    expect(parsePresentationOperations("not a list", sink)).toEqual([]);
    expect(sink.items.length).toBeGreaterThan(0);
  });

  it("refuses an arrangement outside the hair vocabulary rather than patching raw json", () => {
    const sink = new DiagnosticCollector();
    const parsed = parsePresentationOperations([{ kind: "rearrange", entryId: "pres_hair", arrangement: "swept", atMinutes: 5 }], sink);
    expect(parsed).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_OPERATION_INVALID);
  });

  // Reported, unlike the entry cap's documented silence: part of what a model
  // asked for did not happen, and a caller has to be able to see that.
  it("reports the surplus when a proposal exceeds the operation cap", () => {
    const sink = new DiagnosticCollector();
    const many = Array.from({ length: PRESENTATION_MAX_OPERATIONS + 3 }, (_, index) =>
      applyHair({ entryId: `pres_${index}` }),
    );
    expect(parsePresentationOperations(many, sink)).toHaveLength(PRESENTATION_MAX_OPERATIONS);
    expectDiagnostic(sink, VISUAL_STATE_PRESENTATION_OPERATION_INVALID, { times: 1 });
  });
});

describe("parseCharacterPresentationState", () => {
  /**
   * A HAND-WRITTEN literal, not a reducer-produced fixture. The reducer only
   * emits records it already built, so a round-trip over its own output cannot
   * catch a field the write path never checked — which is exactly how an
   * over-long id and a padded subject stayed invisible.
   */
  it("refuses a stored entry whose own record is out of contract", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseCharacterPresentationState(
      {
        version: 1,
        entries: [
          {
            id: "p".repeat(200),
            subjectId: VISUAL_STATE_FIXTURE_SUBJECT_ID,
            kindId: "presentation.hairstyle",
            locus: HAIR_LOCUS,
            value: { arrangement: "loose" },
            appliedAtMinutes: 10,
          },
        ],
      },
      sink,
    );
    expect(parsed.entries).toEqual([]);
    expect(sink.items.length).toBeGreaterThan(0);
  });

  it("accepts a hand-written entry the write path would also accept", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseCharacterPresentationState(
      {
        version: 1,
        entries: [
          {
            id: "pres_hair",
            subjectId: VISUAL_STATE_FIXTURE_SUBJECT_ID,
            kindId: "presentation.hairstyle",
            locus: HAIR_LOCUS,
            value: { arrangement: "loose" },
            appliedAtMinutes: 10,
          },
        ],
      },
      sink,
    );
    expect(parsed.entries).toEqual(reduce([applyHair()]).entries);
    expectCleanSink(sink);
  });

  it("round-trips a reduced state through JSON", () => {
    const sink = new DiagnosticCollector();
    const state = visualStateGroomedPresentation();
    const raw: unknown = JSON.parse(JSON.stringify(state));
    expect(parseCharacterPresentationState(raw, sink)).toEqual(state);
    expectCleanSink(sink);
  });

  it("drops one unreadable entry rather than the whole state", () => {
    const sink = new DiagnosticCollector();
    const state = visualStateGroomedPresentation();
    const raw = JSON.parse(JSON.stringify(state)) as { entries: { value: unknown }[] };
    const first = raw.entries[0];
    if (first !== undefined) first.value = { arrangement: "nonsense" };
    const parsed = parseCharacterPresentationState(raw, sink);
    expect(parsed.entries).toHaveLength(1);
    expectDiagnostic(sink, VISUAL_STATE_VALUE_INVALID);
  });

  it("degrades an unusable record to the empty state", () => {
    const sink = new DiagnosticCollector();
    expect(parseCharacterPresentationState({ version: 9 }, sink)).toEqual(emptyCharacterPresentationState());
  });
});

describe("projectPresentationFeatures", () => {
  it("projects each entry onto the presentation layer", () => {
    const sink = new DiagnosticCollector();
    const features = projectPresentationFeatures({ state: visualStateGroomedPresentation(), sink });
    expect(features.map((feature) => feature.key)).toEqual([
      `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/hair/presentation.hairstyle`,
      `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/face/presentation.makeup`,
    ]);
    for (const feature of features) {
      expect(feature.layer).toBe("presentation");
      expect(feature.stability).toBe("presentation");
    }
    expectCleanSink(sink);
  });

  it("gives each grooming area its own key, so one cannot drop the other", () => {
    const state = reduce([grooming("pres_brows", "brows", "shaped"), grooming("pres_beard", "facial_hair", "trimmed")]);
    const keys = projectPresentationFeatures({ state }).map((feature) => feature.key);
    expect(keys).toEqual([
      `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/face/presentation.grooming:facial_hair`,
      `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/face/presentation.grooming:brows`,
    ]);
    expect(new Set(keys).size).toBe(2);
  });

  it("leaves a kind with nothing to discriminate on a bare aspect", () => {
    expect(presentationAspect("presentation.hairstyle", { arrangement: "loose" })).toBe("presentation.hairstyle");
    expect(presentationAspect("presentation.cosmetic_mark", { mark: "bindi" })).toBe("presentation.cosmetic_mark:bindi");
  });

  it("carries the entry as the source, so the owner is traceable", () => {
    const [first] = projectPresentationFeatures({ state: visualStateGroomedPresentation() });
    expect(first?.sourceRef).toEqual({ kind: "presentation", presentationId: "pres_hair" });
  });

  it("changes its fingerprint when the choice is disturbed, and keeps its key", () => {
    const before = visualStateGroomedPresentation();
    const after = applyPresentationOperations(before, [
      { kind: "smudge", entryId: "pres_makeup", disturbance: "smudged", atMinutes: 90 },
    ]);
    const [, beforeMakeup] = projectPresentationFeatures({ state: before });
    const [, afterMakeup] = projectPresentationFeatures({ state: after });
    expect(afterMakeup?.key).toBe(beforeMakeup?.key);
    expect(afterMakeup?.truthFingerprint).not.toBe(beforeMakeup?.truthFingerprint);
    expect(afterMakeup?.changedAtMinutes).toBe(90);
  });

  it("modifies the identity features under the surface it is applied to", () => {
    // The fixture body's crooked nose sits at `nose`, which is under `face`.
    const identity = adaptProjectedAppearanceTruth(projectFixture({ attributes: crookedNoseAttributes() }));
    const features = projectPresentationFeatures({
      state: visualStateGroomedPresentation(),
      composeAgainst: identity,
    });
    const makeup = features.find((feature) => feature.kindId === "presentation.makeup");
    expect(makeup?.relationships).toEqual([
      { kind: "modifies", targetKey: `${VISUAL_STATE_FIXTURE_SUBJECT_ID}/nose/shape` },
    ]);
  });

  it("asserts no edge when there is nothing under the surface to modify", () => {
    const identity = adaptProjectedAppearanceTruth(projectFixture({ attributes: crookedNoseAttributes() }));
    const features = projectPresentationFeatures({
      state: visualStateGroomedPresentation(),
      composeAgainst: identity,
    });
    const hair = features.find((feature) => feature.kindId === "presentation.hairstyle");
    expect(hair?.relationships).toEqual([]);
  });

  it("never modifies another subject's identity", () => {
    const identity = adaptProjectedAppearanceTruth(projectFixture({ attributes: crookedNoseAttributes() }));
    const features = projectPresentationFeatures({
      state: visualStateGroomedPresentation("someone_else"),
      composeAgainst: identity,
    });
    expect(features.flatMap((feature) => feature.relationships)).toEqual([]);
  });

  it("produces byte-equal output from the same state", () => {
    const state = visualStateGroomedPresentation();
    expect(JSON.stringify(projectPresentationFeatures({ state }))).toBe(
      JSON.stringify(projectPresentationFeatures({ state })),
    );
  });
});

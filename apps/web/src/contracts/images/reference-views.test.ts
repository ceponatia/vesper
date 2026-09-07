import { describe, expect, it } from "vitest";
import {
  allReferenceViews,
  selectReferenceView,
  isConsumableReferenceView,
  normalizeReferenceViewTargets,
  plannedReferenceViews,
  projectReferenceViewState,
  REFERENCE_VIEW_BACKGROUND_CLAUSE,
  REFERENCE_VIEW_GENERATION_VERSION,
  referenceViewAngleById,
  referenceViewAngleIds,
  referenceViewAngles,
  referenceViewFaceVisibility,
  referenceViewFeedbackReasons,
  referenceViewReviewRequestSchema,
  referenceViewRestoreRequestSchema,
  referenceViewHistoryVerdict,
  referenceViewWardrobeEntries,
  referenceViewWardrobes,
  type ReferenceViewAngleId,
  type ReferenceViewHistoryVerdict,
  type ReferenceViewProjectionInput,
  type ReferenceViewStatus,
  type ReferenceViewVerdict,
} from "./reference-views";
import { FULLY_COVERED, type RegionExposure } from "../items/visibility";
import {
  sceneShotDistanceIds,
  sceneSubjectOrientationById,
  sceneSubjectOrientationIds,
  type SceneCameraSpec,
} from "./scene-camera";
import { VISUAL_IMAGE_AGE_ATTRIBUTE_ID } from "./visual-digest";
import type { AttributeValue } from "../attributes/value";

/**
 * The reference view registry and its projection.
 *
 * Two invariants, both of which fail silently in production if they break:
 *
 * 1. **The phrasing rules.** Every instruction this registry emits reaches an
 *    image model verbatim, and the three rules `scene-camera.ts` holds itself to
 *    are scars, not style — a limb noun paints a second person, a gendered
 *    pronoun mis-genders half the cast, and a negation anchors on the thing it
 *    negates. The patterns below are COPIED from `scene-camera.test.ts` for that
 *    file's stated reason: if the server-side backstop ever widens, the copies
 *    stop matching and the divergence is visible here rather than leaking into a
 *    prompt.
 * 2. **Consumability.** Exactly one function decides whether a view may be sent
 *    to a render, and every one of its four conditions is a way a wrong picture
 *    reaches a scene: a view of the portrait the owner replaced, a view nobody
 *    looked at, a view whose asset is gone, a view built by wording this code no
 *    longer emits. The table below kills the implementation that checks
 *    `status === "ready"` and stops.
 */

const LIMB_NOUN = /\b(hands?|arms?|legs?|foot|feet|fingers?|thumbs?|palms?|wrists?|knees?|elbows?)\b/i;
const GENDERED_PRONOUN = /\b(she|he|her|hers|his|him)\b/i;
const NEGATION = /\b(no|not|never|without|nor)\b/i;
const BARE_LIMB = /\b(?:a|an|one)\s+(hand|arm|leg|foot|finger|thumb|palm|wrist|knee|elbow)\b(?!['’-])/i;

const bind = (phrase: string): string => phrase.replaceAll("{name}", "Mira");
const everyPhrase = (): string[] => [
  ...referenceViewAngles.map((entry) => entry.instruction),
  ...referenceViewWardrobeEntries.map((entry) => entry.instruction),
  REFERENCE_VIEW_BACKGROUND_CLAUSE,
];

describe("the reference view registry", () => {
  it("has one entry per id, and no id twice", () => {
    expect(referenceViewAngles.map((entry) => entry.id)).toEqual([...referenceViewAngleIds]);
    expect(referenceViewWardrobeEntries.map((entry) => entry.id)).toEqual([...referenceViewWardrobes]);
    for (const ids of [referenceViewAngleIds, referenceViewWardrobes]) {
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("gives every angle a camera the scene vocabulary knows, a distinct camera id, an instruction and a label", () => {
    const cameraIds = new Set<string>();
    for (const angle of referenceViewAngles) {
      expect(sceneSubjectOrientationById(angle.camera.orientation), angle.id).toBeDefined();
      expect(angle.camera.distance, angle.id).toBe("full_figure");
      expect(angle.instruction.trim().length, angle.id).toBeGreaterThan(0);
      expect(angle.label.trim().length, angle.id).toBeGreaterThan(0);
      cameraIds.add(angle.cameraId);
    }
    expect(cameraIds.size).toBe(referenceViewAngles.length);
  });

  it("reads face visibility from the camera vocabulary rather than restating it", () => {
    for (const angle of referenceViewAngles) {
      expect(referenceViewFaceVisibility(angle), angle.id).toBe(
        sceneSubjectOrientationById(angle.camera.orientation)?.faceVisibility,
      );
    }
    // The three the sheet actually depends on: a front view can carry a full
    // identity lock, a back view cannot carry one at all.
    expect(referenceViewFaceVisibility(referenceViewAngleById("front_full")!)).toBe("full");
    expect(referenceViewFaceVisibility(referenceViewAngleById("back_full")!)).toBe("hidden");
    expect(referenceViewFaceVisibility(referenceViewAngleById("side_left")!)).toBe("partial");
  });

  // Two `profile` cameras with one instruction between them would be one view
  // rendered twice and billed twice — the camera vocabulary has no left/right,
  // so the handedness lives in the words or nowhere.
  //
  // Each side instruction names BOTH hands of the geometry — the own side toward
  // the camera, the other side turned away, and the frame edge that follows — so
  // "mentions the word left" says nothing: an entry stating every one of those
  // backwards still contains both words. The contract is that the entry names its
  // OWN side first and that the two entries are exact mirrors, and those two
  // assertions kill the edits that can realistically ship a wrong sheet: a
  // half-applied rewording of one side, and a rewording that inverts both at once.
  it("distinguishes the two side views in their instructions, not in their cameras", () => {
    const left = referenceViewAngleById("side_left");
    const right = referenceViewAngleById("side_right");
    expect(left?.camera).toEqual(right?.camera);
    expect(left?.instruction).not.toBe(right?.instruction);
    // The first hand named is the subject's own, per the registry's header: the
    // sheet is subject-relative, and the camera-relative consequence follows it.
    expect(left?.instruction.match(/\b(left|right)\b/)?.[1]).toBe("left");
    expect(right?.instruction.match(/\b(left|right)\b/)?.[1]).toBe("right");
    const mirrored = left?.instruction.replaceAll(/\b(left|right)\b/g, (word) => (word === "left" ? "right" : "left"));
    expect(mirrored).toBe(right?.instruction);
  });

  it("is the cross product of its two axes", () => {
    const views = allReferenceViews();
    expect(views).toHaveLength(referenceViewAngles.length * referenceViewWardrobeEntries.length);
    expect(new Set(views.map((view) => `${view.angle}:${view.wardrobe}`)).size).toBe(views.length);
  });

  it("marks exactly the undressed wardrobe intimate", () => {
    expect(referenceViewWardrobeEntries.filter((entry) => entry.intimate).map((entry) => entry.id)).toEqual(["bare"]);
  });
});

describe("the phrasing rules that keep a view from painting a second person", () => {
  it("names no limb in any instruction", () => {
    for (const phrase of everyPhrase()) expect(phrase).not.toMatch(LIMB_NOUN);
  });

  it("leaves no unbound limb once {name} is substituted", () => {
    for (const phrase of everyPhrase()) expect(BARE_LIMB.test(bind(phrase)), phrase).toBe(false);
  });

  it("uses no gendered pronoun — the cast is not all one gender", () => {
    for (const phrase of everyPhrase()) expect(phrase).not.toMatch(GENDERED_PRONOUN);
  });

  it("states the geometry that is, never the one that is not", () => {
    for (const phrase of everyPhrase()) expect(phrase).not.toMatch(NEGATION);
  });
});

const withBand = (band: string): { attributes: AttributeValue[] } => ({
  attributes: [{ id: VISUAL_IMAGE_AGE_ATTRIBUTE_ID, value: band, source: "creation" }],
});

describe("the age gate", () => {
  it("keeps the whole sheet for a recognized adult band", () => {
    expect(plannedReferenceViews(withBand("eighteen"))).toHaveLength(allReferenceViews().length);
  });

  // The ruling has no exception: a minor band produces no undressed view, and
  // the refusal is a gate — nothing about it reaches a model.
  it("drops every undressed view for a withheld band", () => {
    const planned = plannedReferenceViews(withBand("teen"));
    expect(planned.every((view) => view.wardrobe === "clothed")).toBe(true);
    expect(planned).toHaveLength(referenceViewAngles.length);
  });

  it("drops every undressed view when no age band resolves at all", () => {
    expect(plannedReferenceViews({ attributes: [] }).every((view) => view.wardrobe === "clothed")).toBe(true);
  });
});

/**
 * What a request for "rebuild these" resolves to before anything is admitted.
 *
 * Both halves are money. A duplicate slot that survives is charged twice and
 * rendered twice, and the second attempt supersedes the first mid-render — the
 * bill is real and the picture is not. A slot outside the plan that is quietly
 * dropped rather than refused turns the age gate into something a client can
 * discover by counting renders.
 *
 * The implementation this kills is `requested.filter(inPlan)`, which passes
 * every happy-path check.
 */
describe("normalizeReferenceViewTargets", () => {
  const ADULT = plannedReferenceViews(withBand("eighteen"));
  const CLOTHED_ONLY = plannedReferenceViews(withBand("teen"));
  const FRONT_CLOTHED = { angle: "front_full", wardrobe: "clothed" } as const;
  const FRONT_BARE = { angle: "front_full", wardrobe: "bare" } as const;
  const BACK_CLOTHED = { angle: "back_full", wardrobe: "clothed" } as const;

  it("keeps one attempt per slot, in the order the caller first named it", () => {
    expect(normalizeReferenceViewTargets([BACK_CLOTHED, FRONT_CLOTHED, BACK_CLOTHED], ADULT)).toEqual({
      targets: [BACK_CLOTHED, FRONT_CLOTHED],
      refused: [],
    });
  });

  it("refuses a slot the plan withheld rather than dropping it quietly", () => {
    expect(normalizeReferenceViewTargets([FRONT_CLOTHED, FRONT_BARE, FRONT_BARE], CLOTHED_ONLY)).toEqual({
      // Deduplicated on both sides, so a repeat cannot pad the refusal either.
      targets: [FRONT_CLOTHED],
      refused: [FRONT_BARE],
    });
  });

  it("passes a whole plan through unchanged — an accept builds exactly what it planned", () => {
    expect(normalizeReferenceViewTargets(ADULT, ADULT)).toEqual({ targets: ADULT, refused: [] });
  });
});

describe("what a stored row projects to, and what may be sent to a render", () => {
  const ACCEPTED = "portrait-a";
  const base: ReferenceViewProjectionInput = {
    current: true,
    status: "ready",
    sourceImageId: ACCEPTED,
    imageId: "view-1",
    imageStatus: "ready",
    generationVersion: REFERENCE_VIEW_GENERATION_VERSION,
    reviewedAt: new Date("2026-01-01T00:00:00Z"),
    acceptedImageId: ACCEPTED,
  };

  const cases: ReadonlyArray<[string, Partial<ReferenceViewProjectionInput>, string, boolean]> = [
    ["current, ready, reviewed, from the accepted portrait", {}, "approved", true],
    ["ready but nobody has looked at it", { reviewedAt: null }, "unreviewed", false],
    ["still rendering", { status: "pending", imageId: null, imageStatus: null }, "pending", false],
    ["the render failed", { status: "failed", imageId: null, imageStatus: null }, "failed", false],
    ["the owner turned it down", { status: "rejected" }, "rejected", false],
    ["reviewed, but the accepted portrait moved on", { acceptedImageId: "portrait-b" }, "stale", false],
    ["the character has no accepted portrait at all", { acceptedImageId: null }, "stale", false],
    ["its source pointer was cleared", { sourceImageId: null }, "stale", false],
    ["a newer attempt superseded it", { current: false, status: "superseded" }, "stale", false],
    ["its asset never became readable", { imageStatus: "pending" }, "stale", false],
    ["its asset is gone", { imageId: null, imageStatus: null }, "stale", false],
    ["it was built by wording this code no longer emits", { generationVersion: 0 }, "stale", false],
  ];

  it.each(cases)("%s ⇒ %s", (_name, patch, state, consumable) => {
    const row = { ...base, ...patch };
    expect(projectReferenceViewState(row)).toBe(state);
    expect(isConsumableReferenceView(row)).toBe(consumable);
  });

  // The rejection outranks staleness: a view the owner said no to must never
  // come back reading merely "out of date", which is a state the bulk build
  // would happily re-render.
  it("keeps a rejection visible even when the portrait also moved on", () => {
    expect(projectReferenceViewState({ ...base, status: "rejected", acceptedImageId: "portrait-b" })).toBe("rejected");
  });
});

/** `fnv1a32("char-b")` is even — a golden value; see the side-parity test below. */
const EVEN_KEY = "char-b";
/** `fnv1a32("char-a")` is odd. */
const ODD_KEY = "char-a";

/**
 * **Which view a shot asks for.** Three rules, each of which fails silently in a
 * render: a wrong angle anchors a back shot on a face, a wrong wardrobe dresses
 * a scene the story undressed, and an unstable side flips a character between
 * her left and her right in two consecutive images of one conversation.
 *
 * The angle table is exercised over the FULL orientation × distance product
 * rather than over hand-picked pairs, because the one case that matters is the
 * one nobody thought to write: an orientation added to `scene-camera.ts` that
 * silently starts claiming a view. The expectation below is the rule restated
 * independently — it kills an implementation that, say, gives `three_quarter` a
 * side, or lets a `close` front shot claim the full-length view.
 */
describe("selectReferenceView", () => {
  const camera = (orientation: string, distance: string): SceneCameraSpec =>
    ({ orientation, distance, height: "eye_level" }) as SceneCameraSpec;

  /** The table this slice implements, written out once and compared everywhere. */
  const expectedAngle = (orientation: string, distance: string, sideKey: string): ReferenceViewAngleId | null => {
    if (orientation === "away" || orientation === "away_glance_back") return "back_full";
    if (orientation === "profile") return sideKey === EVEN_KEY ? "side_left" : "side_right";
    if (orientation === "toward_viewer") return distance === "full_figure" || distance === "wide" ? "front_full" : null;
    return null;
  };

  const pairs = sceneSubjectOrientationIds.flatMap((orientation) =>
    sceneShotDistanceIds.map((distance) => [orientation, distance] as const),
  );

  it.each(pairs)("%s at %s picks the angle the table names", (orientation, distance) => {
    const selection = selectReferenceView({
      camera: camera(orientation, distance),
      exposure: FULLY_COVERED,
      allowIntimate: true,
      sideKey: EVEN_KEY,
    });
    const expected = expectedAngle(orientation, distance, EVEN_KEY);
    expect(selection.view === null ? null : selection.view.angle).toBe(expected);
  });

  // Not merely "some orientation returns nothing": the three-quarter turn is the
  // owner's four-angles ruling in code. A sheet with no oblique view must fall
  // through to the front-facing portrait rather than approximating with a side.
  it("a three-quarter turn selects nothing, at every distance", () => {
    for (const distance of sceneShotDistanceIds) {
      const selection = selectReferenceView({
        camera: camera("three_quarter", distance),
        exposure: FULLY_COVERED,
        allowIntimate: true,
        sideKey: EVEN_KEY,
      });
      expect(selection).toEqual({ view: null, reason: "no_rule" });
    }
  });

  // The face visibility is what earns a view the anchor's slot under a one-slot
  // capacity, so it has to come from the camera vocabulary rather than from a
  // second opinion about which angles have faces in them.
  it("reports the angle's own face visibility", () => {
    const back = selectReferenceView({
      camera: camera("away", "medium"),
      exposure: FULLY_COVERED,
      allowIntimate: true,
      sideKey: EVEN_KEY,
    });
    expect(back.view === null ? null : back.faceVisibility).toBe("hidden");
    const side = selectReferenceView({
      camera: camera("profile", "medium"),
      exposure: FULLY_COVERED,
      allowIntimate: true,
      sideKey: EVEN_KEY,
    });
    expect(side.view === null ? null : side.faceVisibility).toBe("partial");
  });

  /**
   * The wardrobe rule, default-shut in both directions. The row that matters
   * most is the partial undress: a torso bare over a covered pelvis reads
   * `clothed`, which is the conservative arm — an implementation using
   * `intimateRegionsBare` (torso OR pelvis) would pass every other row here and
   * fail this one, and would put the bare view into half-dressed scenes.
   */
  const exposure = (patch: Partial<RegionExposure>): RegionExposure => ({ ...FULLY_COVERED, ...patch });
  const wardrobeCases: ReadonlyArray<[string, RegionExposure | null, boolean, string]> = [
    ["fully covered", FULLY_COVERED, true, "clothed"],
    ["torso and pelvis bare", exposure({ torso: "bare", pelvis: "bare" }), true, "bare"],
    ["torso bare, pelvis covered", exposure({ torso: "bare" }), true, "clothed"],
    ["pelvis bare, torso covered", exposure({ pelvis: "bare" }), true, "clothed"],
    ["both regions sheer", exposure({ torso: "sheer", pelvis: "sheer" }), true, "clothed"],
    ["legs and feet bare only", exposure({ legs: "bare", feet: "bare" }), true, "clothed"],
    ["no coverage computed at all", null, true, "clothed"],
    ["bare, on a lane without intimate allowance", exposure({ torso: "bare", pelvis: "bare" }), false, "clothed"],
  ];

  it.each(wardrobeCases)("%s ⇒ %s", (_name, regions, allowIntimate, wardrobe) => {
    const selection = selectReferenceView({
      camera: camera("away", "medium"),
      exposure: regions,
      allowIntimate,
      sideKey: EVEN_KEY,
    });
    expect(selection.view === null ? null : selection.view.wardrobe).toBe(wardrobe);
  });

  /**
   * The side parity, pinned by GOLDEN keys.
   *
   * `profile` says side-on and nothing about handedness, so something has to
   * choose — and the choice has to be the same one next turn, or one character
   * shows her left side in this scene and her right in the next. The literals
   * are deliberate: they are `fnv1a32` parities, and a test that recomputed the
   * hash would agree with any implementation, including one that moved.
   */
  it("resolves one side per key, and keeps it", () => {
    const side = (sideKey: string) => {
      const selection = selectReferenceView({
        camera: camera("profile", "medium"),
        exposure: FULLY_COVERED,
        allowIntimate: true,
        sideKey,
      });
      return selection.view === null ? null : selection.view.angle;
    };
    expect(side(EVEN_KEY)).toBe("side_left");
    expect(side(ODD_KEY)).toBe("side_right");
    // Stability is the whole point: the same key answers the same way however
    // often a conversation asks.
    expect(side(EVEN_KEY)).toBe("side_left");
  });
});

/**
 * **What a past attempt says the owner decided about it.**
 *
 * The invariant: a ruling survives supersession. `reserveReferenceView` retires
 * the previous row by overwriting its `status` with `superseded`, so the status
 * of every attempt but the newest says nothing about whether the owner approved
 * it, rejected it, or never looked — which is the entire reason the `verdict`
 * column exists and the entire reason a slot's history is worth showing.
 *
 * Falsified against the two implementations somebody would actually write: one
 * that reads `status` alone (every retired attempt reads `unreviewed`, and the
 * history lies about every ruling the owner made) and one that reads `verdict`
 * alone (rows written before the column existed lose theirs, so a rejection the
 * backfill could not reach reads as never reviewed).
 */
describe("what a past attempt's verdict reads as", () => {
  type Row = { status: ReferenceViewStatus; verdict: ReferenceViewVerdict | null; reviewedAt: Date | string | null };
  const REVIEWED = new Date("2026-01-01T00:00:00Z");

  const cases: ReadonlyArray<[string, Row, ReferenceViewHistoryVerdict]> = [
    ["a rejection the next attempt superseded", { status: "superseded", verdict: "rejected", reviewedAt: REVIEWED }, "rejected"],
    ["an approval the next attempt superseded", { status: "superseded", verdict: "approved", reviewedAt: REVIEWED }, "approved"],
    ["a row replaced before anybody ruled on it", { status: "superseded", verdict: null, reviewedAt: null }, "unreviewed"],
    ["a pre-column rejection, recoverable from its status", { status: "rejected", verdict: null, reviewedAt: REVIEWED }, "rejected"],
    ["a pre-column approval, recoverable from its review stamp", { status: "ready", verdict: null, reviewedAt: REVIEWED }, "approved"],
    ["a finished render nobody has looked at", { status: "ready", verdict: null, reviewedAt: null }, "unreviewed"],
    ["a render that never produced bytes", { status: "failed", verdict: null, reviewedAt: null }, "unreviewed"],
  ];

  it.each(cases)("%s ⇒ %s", (_name, row, expected) => {
    expect(referenceViewHistoryVerdict(row)).toBe(expected);
  });
});


describe("reference review wire guards", () => {
  const request = { attemptId: "attempt", expectedRevision: 0, verdict: "reject" };
  it("requires an exact attempt and revision for review and restoration", () => {
    expect(referenceViewReviewRequestSchema.safeParse({ verdict: "approve" }).success).toBe(false);
    expect(referenceViewReviewRequestSchema.safeParse({ ...request, expectedRevision: -1 }).success).toBe(false);
    expect(referenceViewRestoreRequestSchema.safeParse({ attemptId: "old-attempt" }).success).toBe(false);
  });
  it("accepts optional registered feedback and rejects oversized or unknown correction data", () => {
    expect(referenceViewReviewRequestSchema.safeParse(request).success).toBe(true);
    expect(referenceViewReviewRequestSchema.safeParse({ ...request, feedback: { reasons: [...referenceViewFeedbackReasons], correction: "Keep the original jacket." } }).success).toBe(true);
    expect(referenceViewReviewRequestSchema.safeParse({ ...request, feedback: { reasons: [], correction: "x".repeat(1001) } }).success).toBe(false);
    expect(referenceViewReviewRequestSchema.safeParse({ ...request, feedback: { reasons: ["invented_reason"], correction: "" } }).success).toBe(false);
  });
});

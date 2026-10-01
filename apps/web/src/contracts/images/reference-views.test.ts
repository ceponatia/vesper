import { describe, expect, it } from "vitest";
import {
  allReferenceViews,
  imageAgeAllowsIntimate,
  selectReferenceView,
  isConsumableReferenceView,
  normalizeReferenceViewTargets,
  plannedReferenceViews,
  projectReferenceViewSlots,
  projectReferenceViewState,
  REFERENCE_VIEW_BACKGROUND_CLAUSE,
  REFERENCE_VIEW_GENERATION_VERSION,
  REFERENCE_VIEW_ROOT_ANGLE,
  REFERENCE_VIEW_ROOT_ANGLE_BINDING,
  referenceViewAncestors,
  referenceViewAngleById,
  referenceViewAngleIds,
  referenceViewAngles,
  referenceViewBuildOrder,
  referenceViewBuildsOnApproval,
  referenceViewDependents,
  referenceViewDependentsToBuild,
  referenceViewDescendantBusy,
  referenceViewDescendants,
  referenceViewFaceVisibility,
  referenceViewFeedbackReasons,
  referenceViewReviewRequestSchema,
  referenceViewRestoreRequestSchema,
  referenceViewQueueOutcomeSchema,
  referenceViewHistoryVerdict,
  referenceViewLineageId,
  referenceViewsReadyToBuild,
  referenceViewsWaitingInBatch,
  referenceViewUpstream,
  referenceViewUpstreamBinding,
  referenceViewWardrobeEntries,
  referenceViewWardrobes,
  sameReferenceView,
  type ReferenceView,
  type ReferenceViewAngleId,
  type ReferenceViewHistoryVerdict,
  type ReferenceViewProjectionInput,
  type ReferenceViewSlotFacts,
  type ReferenceViewSlotRow,
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
 *    to a render, and every one of its five conditions is a way a wrong picture
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
  // The clauses a dependent view's render introduces its upstream view with
  // reach the model verbatim too.
  ...referenceViewWardrobeEntries.flatMap((entry) => (entry.buildsFromBinding === null ? [] : [entry.buildsFromBinding])),
  REFERENCE_VIEW_ROOT_ANGLE_BINDING,
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

  // A profile may carry the attribute more than once and `resolveAttributes`
  // settles which one a cut states by source precedence. The gate refuses
  // unless EVERY entry is an adult, so whichever one the cut resolves, it can
  // never pass an adult entry while the render states a minor one.
  it.each([
    ["adult first, minor second", ["late_twenties", "teen"]],
    ["minor first, adult second", ["teen", "late_twenties"]],
    ["adult beside an unvalued band", ["late_twenties", "adult"]],
  ])("refuses duplicate age entries with any non-adult one — %s", (_label, values) => {
    const sources = ["creation", "manual"] as const;
    const profile: { attributes: AttributeValue[] } = {
      attributes: values.map((value, index): AttributeValue => ({
        id: VISUAL_IMAGE_AGE_ATTRIBUTE_ID,
        value,
        source: sources[index] ?? "creation",
      })),
    };
    expect(imageAgeAllowsIntimate(profile)).toBe(false);
    expect(plannedReferenceViews(profile).every((view) => view.wardrobe === "clothed")).toBe(true);
  });

  it("allows duplicate age entries that are all adults", () => {
    const profile: { attributes: AttributeValue[] } = {
      attributes: [
        { id: VISUAL_IMAGE_AGE_ATTRIBUTE_ID, value: "late_twenties", source: "creation" },
        { id: VISUAL_IMAGE_AGE_ATTRIBUTE_ID, value: "eighteen", source: "manual" },
      ],
    };
    expect(imageAgeAllowsIntimate(profile)).toBe(true);
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
    eligible: true,
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
    ["its slot is no longer in the character's age-gated plan", { eligible: false }, "ineligible", false],
    // The build order's rule: a view rendered from an upstream view stands only
    // while that view is its slot's approved current attempt.
    ["rendered from its upstream's approved current attempt", { upstreamViewId: "up-1", approvedUpstreamId: "up-1" }, "approved", true],
    ["its upstream view was regenerated and re-approved", { upstreamViewId: "up-1", approvedUpstreamId: "up-2" }, "stale", false],
    ["its upstream view has no approved current attempt", { upstreamViewId: "up-1", approvedUpstreamId: null }, "stale", false],
    ["it records no upstream — uploaded, or built before the build order", { upstreamViewId: null, approvedUpstreamId: null }, "approved", true],
    // The body-image rule (#671): a rendered view stands only while the
    // character's body-image set is the one it was rendered against, and a row
    // that records none was rendered against the empty set.
    ["rendered with no body image, and the character still has none", { method: "rendered", bodyReferenceSet: null, currentBodyReferenceSet: null }, "approved", true],
    ["rendered before the character's first body image", { method: "rendered", bodyReferenceSet: null, currentBodyReferenceSet: "img-a:clothed" }, "stale", false],
    ["rendered against the character's body-image set now", { method: "rendered", bodyReferenceSet: "img-a:clothed", currentBodyReferenceSet: "img-a:clothed" }, "approved", true],
    ["its body image was re-tagged since", { method: "rendered", bodyReferenceSet: "img-a:clothed", currentBodyReferenceSet: "img-a:unclothed" }, "stale", false],
    ["its body images were all removed since", { method: "rendered", bodyReferenceSet: "img-a:clothed", currentBodyReferenceSet: null }, "stale", false],
    ["uploaded — no body image was rendered into it", { method: "uploaded", bodyReferenceSet: null, currentBodyReferenceSet: "img-a:clothed" }, "approved", true],
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

const slotKeyOf = (view: ReferenceView): string => `${view.angle}:${view.wardrobe}`;
const slotSet = (views: readonly ReferenceView[]): Set<string> => new Set(views.map(slotKeyOf));
const ROOT: ReferenceView = { angle: REFERENCE_VIEW_ROOT_ANGLE, wardrobe: "clothed" };

/**
 * **Which approved view each view's body is rendered from.**
 *
 * The owner's order (#670): the front clothed view first, the other angles
 * dressed from it, and each undressed view from its own angle dressed. Derived
 * from the registries rather than copied, so an added angle is checked for the
 * same rule. The implementations this kills: a graph with a second root (two
 * views rendered from nothing, two bodies), a bare view built from the front
 * instead of its own angle, and a build order that renders a view before the
 * one it is built from.
 */
describe("the build order", () => {
  it("has exactly one root, the front dressed", () => {
    expect(allReferenceViews().filter((view) => referenceViewUpstream(view) === null)).toEqual([ROOT]);
  });

  it("builds every other angle dressed from the root, and the root's own undressed view from it", () => {
    const expected = [
      ...referenceViewAngles
        .filter((angle) => angle.id !== REFERENCE_VIEW_ROOT_ANGLE)
        .map((angle): ReferenceView => ({ angle: angle.id, wardrobe: "clothed" })),
      { angle: REFERENCE_VIEW_ROOT_ANGLE, wardrobe: "bare" },
    ];
    expect(slotSet(referenceViewDependents(ROOT))).toEqual(slotSet(expected));
  });

  it("builds each undressed view from its own angle dressed, and builds nothing from an undressed view", () => {
    for (const angle of referenceViewAngles) {
      const bare: ReferenceView = { angle: angle.id, wardrobe: "bare" };
      expect(referenceViewUpstream(bare), angle.id).toEqual({ angle: angle.id, wardrobe: "clothed" });
      expect(referenceViewDependents(bare), angle.id).toEqual([]);
    }
  });

  it("orders every view after the view it is built from", () => {
    const order = referenceViewBuildOrder();
    expect(slotSet(order)).toEqual(slotSet(allReferenceViews()));
    order.forEach((view, index) => {
      const upstream = referenceViewUpstream(view);
      if (upstream === null) return;
      expect(order.findIndex((entry) => sameReferenceView(entry, upstream)), slotKeyOf(view)).toBeLessThan(index);
    });
  });

  // A second identity image of one person reads as a second person unless the
  // prompt says why it is there, so every dependent carries the registry's
  // clause — and the root, which sends no upstream, carries none.
  it("introduces every upstream view in the registry's words, and the root's in none", () => {
    expect(referenceViewUpstreamBinding(ROOT)).toBeNull();
    for (const view of allReferenceViews()) {
      if (referenceViewUpstream(view) === null) continue;
      expect(referenceViewUpstreamBinding(view)?.trim().length ?? 0, slotKeyOf(view)).toBeGreaterThan(0);
    }
    // The two relations say different things: another angle in the same
    // clothing, and this angle dressed for a render that undresses it.
    expect(referenceViewUpstreamBinding({ angle: "back_full", wardrobe: "clothed" }))
      .not.toBe(referenceViewUpstreamBinding({ angle: "back_full", wardrobe: "bare" }));
  });
});

/**
 * **The sheet, projected in build order** — what may build now, what waits,
 * and what an approval builds.
 *
 * Three money-shaped invariants, each invisible until the bill or the picture
 * is wrong:
 *
 * 1. **Only a slot whose upstream is approved may build.** A fresh sheet builds
 *    the root alone; everything else waits. A view built before its upstream
 *    was approved is a view of an unapproved body.
 * 2. **Staleness flows down the order.** Regenerating the root makes the views
 *    built from it stale, and the undressed views built from THOSE stale with
 *    them — the implementation this kills compares each row only with its own
 *    upstream row's id and misses an upstream that is itself stale.
 * 3. **The disclosed count is the charged count.** What the Approve control
 *    shows (a what-if projection before the write) equals what the review route
 *    queues (the projection after it). Asserted directly below rather than
 *    trusted, because the two are computed at different moments.
 */
/**
 * **One request may not rebuild a view and a view built from it** (#670).
 *
 * The request replaces the upstream, so the dependent's worker finds either no
 * approved upstream (a charge for nothing) or the attempt being superseded (a
 * render that lands stale) — and approving the new upstream then charges it
 * again. The implementation this kills checks only the sheet's `waitingOn`,
 * which reads "ready" for both before the request runs, and the transitive case
 * (the root beside an undressed view two hops down) that a direct-parent check
 * misses.
 */
describe("a batch that names a view and a view built from it", () => {
  const LEFT: ReferenceView = { angle: "side_left", wardrobe: "clothed" };
  const LEFT_BARE: ReferenceView = { angle: "side_left", wardrobe: "bare" };
  const RIGHT: ReferenceView = { angle: "side_right", wardrobe: "clothed" };

  it("holds back every target built from another target, directly or through another view", () => {
    expect(referenceViewsWaitingInBatch([ROOT, LEFT])).toEqual([LEFT]);
    expect(referenceViewsWaitingInBatch([LEFT_BARE, ROOT])).toEqual([LEFT_BARE]);
    expect(referenceViewsWaitingInBatch([ROOT, LEFT, LEFT_BARE])).toEqual([LEFT, LEFT_BARE]);
  });

  it("holds back nothing when no target is built from another", () => {
    expect(referenceViewsWaitingInBatch([LEFT, RIGHT])).toEqual([]);
    expect(referenceViewsWaitingInBatch([LEFT_BARE, RIGHT])).toEqual([]);
    expect(referenceViewsWaitingInBatch(allReferenceViews().filter((view) => referenceViewUpstream(view) === null))).toEqual([]);
  });

  // Replacing a view while a view built from it renders strands that render;
  // the rule looks through every level, and never at the slot's own lease.
  it("calls a view busy for replacement when any view built from it is building", () => {
    expect(referenceViewDescendantBusy(ROOT, [LEFT_BARE])).toBe(true);
    expect(referenceViewDescendantBusy(LEFT, [LEFT_BARE])).toBe(true);
    expect(referenceViewDescendantBusy(LEFT, [RIGHT, ROOT])).toBe(false);
    expect(referenceViewDescendantBusy(LEFT, [LEFT])).toBe(false);
  });

  it("reads ancestors and descendants off the one build order", () => {
    expect(referenceViewAncestors(LEFT_BARE)).toEqual([LEFT, ROOT]);
    expect(referenceViewAncestors(ROOT)).toEqual([]);
    expect(slotSet(referenceViewDescendants(ROOT))).toEqual(
      slotSet(allReferenceViews().filter((view) => !sameReferenceView(view, ROOT))),
    );
    expect(referenceViewDescendants(LEFT)).toEqual([LEFT_BARE]);
  });
});

describe("the sheet, projected in build order", () => {
  const ACCEPTED = "portrait-a";
  const APPROVED_AT = new Date("2026-01-01T00:00:00Z");
  const BACK: ReferenceView = { angle: "back_full", wardrobe: "clothed" };
  const BACK_BARE: ReferenceView = { angle: "back_full", wardrobe: "bare" };
  const LEFT: ReferenceView = { angle: "side_left", wardrobe: "clothed" };
  const RIGHT: ReferenceView = { angle: "side_right", wardrobe: "clothed" };
  const FRONT_BARE: ReferenceView = { angle: REFERENCE_VIEW_ROOT_ANGLE, wardrobe: "bare" };
  const ADULT_PLAN = plannedReferenceViews(withBand("eighteen"));
  const CLOTHED_PLAN = plannedReferenceViews(withBand("teen"));

  /** A ready, current attempt from the accepted portrait — unreviewed unless patched. */
  const attempt = (attemptId: string, patch: Partial<ReferenceViewSlotRow> = {}): ReferenceViewSlotRow => ({
    attemptId,
    current: true,
    status: "ready",
    sourceImageId: ACCEPTED,
    imageId: `img-${attemptId}`,
    imageStatus: "ready",
    generationVersion: REFERENCE_VIEW_GENERATION_VERSION,
    reviewedAt: null,
    acceptedImageId: ACCEPTED,
    upstreamViewId: null,
    ...patch,
  });
  const approved = (attemptId: string, upstreamViewId: string | null = null): ReferenceViewSlotRow =>
    attempt(attemptId, { reviewedAt: APPROVED_AT, upstreamViewId });

  /** Every slot, with the rows given and the plan's eligibility. */
  const sheet = (
    rows: ReadonlyArray<readonly [ReferenceView, ReferenceViewSlotRow]>,
    plan: readonly ReferenceView[] = ADULT_PLAN,
  ): ReferenceViewSlotFacts[] =>
    allReferenceViews().map((view) => ({
      view,
      eligible: plan.some((entry) => sameReferenceView(entry, view)),
      row: rows.find(([slot]) => sameReferenceView(slot, view))?.[1] ?? null,
    }));
  const slot = (facts: readonly ReferenceViewSlotFacts[], view: ReferenceView) =>
    projectReferenceViewSlots(facts).find((entry) => sameReferenceView(entry, view));

  /** The same sheet with one slot's current attempt approved — the write the review route makes. */
  const withApproval = (facts: readonly ReferenceViewSlotFacts[], view: ReferenceView): ReferenceViewSlotFacts[] =>
    facts.map((entry) =>
      sameReferenceView(entry.view, view) && entry.row !== null ? { ...entry, row: { ...entry.row, reviewedAt: APPROVED_AT } } : entry,
    );

  it("builds the root alone on a fresh sheet, and every other slot waits on its own upstream", () => {
    const facts = sheet([]);
    const projected = projectReferenceViewSlots(facts);
    expect(referenceViewsReadyToBuild(projected)).toEqual([ROOT]);
    for (const entry of projected) {
      expect(entry.waitingOn, slotKeyOf(entry)).toEqual(referenceViewUpstream(entry));
    }
  });

  it("discloses on approval exactly what the review route then queues — the root's four dependents", () => {
    const facts = sheet([[ROOT, attempt("front-1")]]);
    const disclosed = referenceViewBuildsOnApproval(facts, { view: ROOT, attemptId: "front-1" });
    expect(slotSet(disclosed)).toEqual(slotSet(referenceViewDependents(ROOT)));
    const queued = referenceViewDependentsToBuild(projectReferenceViewSlots(withApproval(facts, ROOT)), ROOT);
    expect(queued).toEqual(disclosed);
  });

  it("builds no undressed view on an age-gated character's root approval", () => {
    const facts = sheet([[ROOT, attempt("front-1")]], CLOTHED_PLAN);
    const disclosed = referenceViewBuildsOnApproval(facts, { view: ROOT, attemptId: "front-1" });
    expect(slotSet(disclosed)).toEqual(slotSet([BACK, LEFT, RIGHT]));
    expect(slot(facts, FRONT_BARE)?.state).toBe("ineligible");
  });

  it("builds each dressed angle's undressed view when that angle is approved", () => {
    const facts = sheet([
      [ROOT, approved("front-1")],
      [BACK, attempt("back-1", { upstreamViewId: "front-1" })],
    ]);
    expect(slot(facts, BACK)?.state).toBe("unreviewed");
    expect(referenceViewBuildsOnApproval(facts, { view: BACK, attemptId: "back-1" })).toEqual([BACK_BARE]);
  });

  it("never rebuilds a rejected dependent on an approval", () => {
    const facts = sheet([
      [ROOT, attempt("front-1")],
      [BACK, attempt("back-1", { status: "rejected", reviewedAt: APPROVED_AT, upstreamViewId: "front-0" })],
    ]);
    const disclosed = referenceViewBuildsOnApproval(facts, { view: ROOT, attemptId: "front-1" });
    expect(slotSet(disclosed)).toEqual(slotSet([LEFT, RIGHT, FRONT_BARE]));
  });

  it("makes a regenerated root's dependents stale and waiting, down the order, and rebuilds them on its approval", () => {
    const facts = sheet([
      // The root was regenerated: a new attempt nobody has approved yet.
      [ROOT, attempt("front-2")],
      [BACK, approved("back-1", "front-1")],
      [LEFT, approved("left-1", "front-1")],
      [RIGHT, approved("right-1", "front-1")],
      [FRONT_BARE, approved("front-bare-1", "front-1")],
      [BACK_BARE, approved("back-bare-1", "back-1")],
    ]);
    for (const view of [BACK, LEFT, RIGHT, FRONT_BARE]) {
      expect(slot(facts, view), slotKeyOf(view)).toMatchObject({ state: "stale", consumable: false, waitingOn: ROOT });
    }
    // Its own upstream row is unchanged, but that row is stale — so is this.
    expect(slot(facts, BACK_BARE)).toMatchObject({ state: "stale", consumable: false, waitingOn: BACK });
    expect(referenceViewsReadyToBuild(projectReferenceViewSlots(facts))).toEqual([]);

    const disclosed = referenceViewBuildsOnApproval(facts, { view: ROOT, attemptId: "front-2" });
    expect(slotSet(disclosed)).toEqual(slotSet([BACK, LEFT, RIGHT, FRONT_BARE]));
    expect(referenceViewDependentsToBuild(projectReferenceViewSlots(withApproval(facts, ROOT)), ROOT)).toEqual(disclosed);
  });

  it("rebuilds nothing when the same root attempt is approved again after an undo", () => {
    const facts = sheet([
      [ROOT, attempt("front-1")],
      [BACK, approved("back-1", "front-1")],
      [LEFT, approved("left-1", "front-1")],
      [RIGHT, approved("right-1", "front-1")],
      [FRONT_BARE, approved("front-bare-1", "front-1")],
    ]);
    // Undone, the views built from it read stale...
    expect(slot(facts, BACK)?.state).toBe("stale");
    // ...and approving that very attempt again makes them current, so nothing is spent.
    expect(referenceViewBuildsOnApproval(facts, { view: ROOT, attemptId: "front-1" })).toEqual([]);
    expect(slot(withApproval(facts, ROOT), BACK)?.state).toBe("approved");
  });

  it("builds on an upload what an approval of a new attempt would, and leaves a view built from no upstream alone", () => {
    const facts = sheet([
      [ROOT, approved("front-1")],
      [BACK, approved("back-1", "front-1")],
      [LEFT, approved("left-1", "front-1")],
      // An uploaded or pre-order view: rendered from no upstream view.
      [RIGHT, approved("right-1", null)],
    ]);
    const disclosed = referenceViewBuildsOnApproval(facts, { view: ROOT, attemptId: null });
    expect(slotSet(disclosed)).toEqual(slotSet([BACK, LEFT, FRONT_BARE]));
  });

  it("marks a whole rendered sheet stale when the body images change, rebuilding nothing but the root", () => {
    const BODY = "img-a:clothed";
    const rendered = (row: ReferenceViewSlotRow): ReferenceViewSlotRow => ({ ...row, method: "rendered", currentBodyReferenceSet: BODY });
    const facts = sheet([
      // Every view rendered before the character's first body image.
      [ROOT, rendered(approved("front-1"))],
      [BACK, rendered(approved("back-1", "front-1"))],
      [FRONT_BARE, rendered(approved("front-bare-1", "front-1"))],
      [BACK_BARE, rendered(approved("back-bare-1", "back-1"))],
    ]);
    for (const view of [ROOT, BACK, FRONT_BARE, BACK_BARE]) {
      expect(slot(facts, view), slotKeyOf(view)).toMatchObject({ state: "stale", consumable: false });
    }
    // Nothing rebuilds by itself; the owner's build starts at the root, and the
    // rest wait on its approval as they always do.
    expect(referenceViewsReadyToBuild(projectReferenceViewSlots(facts))).toEqual([ROOT]);
  });

  // "Use this version" restores an earlier attempt as a NEW row. Compared by
  // attempt id, the views built from the original read stale against the copy
  // forever, and rebuilding them buys byte-identical renders; compared by
  // lineage, approving the copy revives them exactly as Undo then Approve does.
  it("revives the views built from an attempt when a restored copy of it is approved", () => {
    const copy = { attemptId: "front-3", originAttemptId: "front-1" };
    expect(referenceViewLineageId(copy)).toBe("front-1");
    const facts = sheet([
      [ROOT, attempt(copy.attemptId, { originAttemptId: copy.originAttemptId })],
      [BACK, approved("back-1", "front-1")],
      [LEFT, approved("left-1", "front-1")],
    ]);
    // Unreviewed, the copy approves nothing yet, so its dependents wait...
    expect(slot(facts, BACK)).toMatchObject({ state: "stale", waitingOn: ROOT });
    // ...and approving it builds only what was never built from its original.
    const disclosed = referenceViewBuildsOnApproval(facts, { view: ROOT, attemptId: referenceViewLineageId(copy) });
    expect(slotSet(disclosed)).toEqual(slotSet([RIGHT, FRONT_BARE]));
    expect(slot(withApproval(facts, ROOT), BACK)).toMatchObject({ state: "approved", consumable: true });
  });

  it("never marks a view stale by the upstream rule when it records no upstream", () => {
    const facts = sheet([
      [ROOT, attempt("front-2")],
      [BACK, approved("back-1", null)],
    ]);
    // Still usable, still the owner's — but nothing may rebuild it until the root is approved.
    expect(slot(facts, BACK)).toMatchObject({ state: "approved", consumable: true, waitingOn: ROOT });
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

describe("reference build admission wire guards", () => {
  it("preserves per-slot outcomes and defaults new fields for older responses", () => {
    expect(referenceViewQueueOutcomeSchema.parse({
      queued: true,
      reason: null,
      planned: 8,
      admitted: 1,
      targets: [{ angle: "front_full", wardrobe: "clothed", state: "queued" }],
    })).toMatchObject({ admitted: 1, targets: [{ state: "queued" }] });
    expect(referenceViewQueueOutcomeSchema.parse({ queued: false, reason: null, planned: 0 }))
      .toMatchObject({ admitted: 0, targets: [] });
  });
});

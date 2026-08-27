import {
  affordanceEvidence,
  affordanceExposureAt,
  isAffordanceChannelAvailable,
  multiplyUnits,
  toUnitInterval,
  AFFORDANCE_UNIT_ONE,
  AFFORDANCE_UNIT_ZERO,
  type AffordanceEvidence,
  type AffordancePerceptionView,
  type UnitInterval,
} from "../affordances/core";
import {
  sceneBodyZoneOf,
  type SceneBodyZone,
  type SceneFacing,
  type SceneProximityBand,
} from "../affordances/scene";
import type { AppearanceDetailTier } from "../appearance-features";
import { bodyLocationRegistry } from "../body/locations";
import { diag, type DiagnosticSink } from "../diagnostics";
import { visualStateCompositionFor, type VisualStateCompositionEntry } from "./composition";
import {
  VISUAL_STATE_DETAIL_TIER_INSUFFICIENT,
  VISUAL_STATE_INTIMATE_GATED,
  VISUAL_STATE_LOCUS_INVALID,
  VISUAL_STATE_VISIBILITY_CHANNEL_UNAVAILABLE,
  VISUAL_STATE_VISIBILITY_DECLARED,
  VISUAL_STATE_VISIBILITY_HIDDEN,
  VISUAL_STATE_VISIBILITY_INVALID,
  VISUAL_STATE_VISIBILITY_OUT_OF_FRAME,
  VISUAL_STATE_VISIBILITY_UNKNOWN,
} from "./diagnostics";
import type { VisualStateFeature } from "./feature";
import type { VisualStateSnapshot } from "./snapshot";
import type { VisualStateSuppression } from "./suppression";

/**
 * Observer/camera visibility over one snapshot.
 *
 * This module answers ONE question per feature: given who or what is looking,
 * and the explicit lighting, distance, angle, motion and framing reads the
 * caller asserts, how much of this feature can the viewpoint resolve, and at
 * which detail tier? It multiplies into the composition's
 * `effectiveVisibility` exactly as the slice-2 note promised — composition
 * says what is IN FRONT of a feature, this says what the viewing conditions
 * make of what remains.
 *
 * Three laws:
 *
 * - **Unknown and invalid cannot become positive visibility.**
 *   Every component read distinguishes `known`, `unknown` and
 *   `invalid`, and a single unusable component fails the WHOLE read closed:
 *   with the lighting unknown, nothing is claimed visible, however exposed.
 *   No production owner asserts lighting or whole-subject motion as typed data,
 *   so the narrator lane supplies them as
 *   DECLARED release defaults (`viewing.ts`) rather than as unknowns — a stated
 *   assertion the inspector and the diagnostics both name. An unmarked default
 *   remains forbidden; a marked one is the ruled first-release policy.
 * - **Blocked features are suppressions, never zero-visibility reads** — the
 *   recognition layer's own representation, so a consumer cannot accidentally
 *   rank an invisible feature.
 * - **Nothing here writes.** Observer and camera reads are the same pure
 *   arithmetic over the same snapshot; the difference this slice owns is that
 *   only an observer needs a sight channel (a camera has no senses, and its
 *   perception view carries exposure alone). Observer MEMORY is not consulted
 *   and not touched — a camera render can never update what a player noticed,
 *   because there is no write path in this module at all.
 *
 * Suppressing a feature here says "this viewpoint cannot resolve it", never
 * "drop it from the render": mandatory identity and morphology bypass optional
 * selection at the digest (spec invariant 7), which is slice 5/8 work reading
 * the feature's own priors, not this module's.
 */

// ---------------------------------------------------------------------------
// Viewpoint
// ---------------------------------------------------------------------------

/**
 * Who or what is looking. `debug` is the inspector's viewpoint: it behaves
 * exactly like a camera — every physical and consent gate still applies — and
 * exists so a diagnostic read is never mistaken for either real consumer.
 */
export type VisualViewpoint =
  | { readonly kind: "observer"; readonly observerId: string }
  | { readonly kind: "camera"; readonly cameraId: string }
  | { readonly kind: "debug" };

// ---------------------------------------------------------------------------
// Component reads
// ---------------------------------------------------------------------------

/**
 * One explicit visibility input. `unknown` means no owner could answer;
 * `invalid` means a value broke its trust boundary on the way here. Neither is
 * a band, neither defaults, and neither can produce positive visibility.
 *
 * `declared` on the known arm marks a value that came from a written-down
 * RELEASE DEFAULT rather than from an owner. It resolves exactly like any other
 * known read — the whole point of a declared default is that it is a real
 * assertion — but it is fingerprinted, evidenced, and reported separately, so a
 * trial can always tell a grounded read from a stated policy. This is the
 * mechanism the plan's "an explicit degraded first-release policy, stated and
 * tested as such" needs; the thing it forbids is an unmarked default, which is
 * precisely what this flag makes impossible to write by accident.
 */
export type VisualComponentRead<TValue> =
  | { readonly status: "known"; readonly value: TValue; readonly declared?: true }
  | { readonly status: "unknown" }
  | { readonly status: "invalid" };

/** An owner answered. */
export function visualComponentKnown<TValue>(value: TValue): VisualComponentRead<TValue> {
  return { status: "known", value };
}

/** No owner answered, and the release declares this value instead. Never silent. */
export function visualComponentDeclared<TValue>(value: TValue): VisualComponentRead<TValue> {
  return { status: "known", value, declared: true };
}

export const VISUAL_COMPONENT_UNKNOWN: VisualComponentRead<never> = { status: "unknown" };
export const VISUAL_COMPONENT_INVALID: VisualComponentRead<never> = { status: "invalid" };

/**
 * Lighting on the subject, as the viewpoint receives it. `silhouette` is
 * backlit shape-only reading: outline facts survive (tier 1), surface detail
 * does not — the trial matrix's silhouette case.
 */
export const visualLightingBands = ["bright", "dim", "dark", "silhouette"] as const;
export type VisualLightingBand = (typeof visualLightingBands)[number];

/**
 * Distance rides the scene owner's proximity vocabulary rather than a second
 * ladder of bands: an observer's distance to the subject IS a proximity fact,
 * and the audit records camera distance as derived from the same bands. A
 * camera adapter (slice 8) derives its band from shot distance.
 */
export type VisualDistanceBand = SceneProximityBand;

/**
 * Angle rides the scene owner's facing vocabulary: how the SUBJECT faces the
 * viewpoint. `away` is the back view — surface features survive at reduced
 * tier because clothing, hair and wings still read from behind, while
 * per-feature front/back placement is finer than any owner proves.
 */
export type VisualAngleBand = SceneFacing;

/** Whole-subject motion relative to the viewpoint. No production owner asserts this yet. */
export const visualMotionBands = ["still", "slow", "fast"] as const;
export type VisualMotionBand = (typeof visualMotionBands)[number];

/**
 * Frame size — which part of the figure the output can contain at all. Absent
 * framing (an observer's unframed eye) constrains nothing; a camera should
 * assert one.
 */
export const visualFramingBands = ["close_up", "portrait", "waist_up", "full_figure", "wide"] as const;
export type VisualFramingBand = (typeof visualFramingBands)[number];

// ---------------------------------------------------------------------------
// Calibration — fixture-tested defaults, not product law
// ---------------------------------------------------------------------------

const LIGHTING_FACTOR: Readonly<Record<VisualLightingBand, UnitInterval>> = {
  bright: AFFORDANCE_UNIT_ONE,
  dim: toUnitInterval(5_500),
  dark: toUnitInterval(500),
  silhouette: toUnitInterval(1_500),
};

const LIGHTING_TIER_CAP: Readonly<Record<VisualLightingBand, AppearanceDetailTier>> = {
  bright: 3,
  dim: 2,
  dark: 1,
  silhouette: 1,
};

const DISTANCE_FACTOR: Readonly<Record<VisualDistanceBand, UnitInterval>> = {
  touching: AFFORDANCE_UNIT_ONE,
  close: AFFORDANCE_UNIT_ONE,
  near: toUnitInterval(7_000),
  distant: toUnitInterval(3_000),
};

const DISTANCE_TIER_CAP: Readonly<Record<VisualDistanceBand, AppearanceDetailTier>> = {
  touching: 3,
  close: 3,
  near: 2,
  distant: 1,
};

const ANGLE_FACTOR: Readonly<Record<VisualAngleBand, UnitInterval>> = {
  toward: AFFORDANCE_UNIT_ONE,
  side_on: toUnitInterval(7_500),
  away: toUnitInterval(3_000),
};

const ANGLE_TIER_CAP: Readonly<Record<VisualAngleBand, AppearanceDetailTier>> = {
  toward: 3,
  side_on: 3,
  away: 2,
};

const MOTION_FACTOR: Readonly<Record<VisualMotionBand, UnitInterval>> = {
  still: AFFORDANCE_UNIT_ONE,
  slow: toUnitInterval(8_500),
  fast: toUnitInterval(5_000),
};

const MOTION_TIER_CAP: Readonly<Record<VisualMotionBand, AppearanceDetailTier>> = {
  still: 3,
  slow: 3,
  fast: 2,
};

const FRAMING_TIER_CAP: Readonly<Record<VisualFramingBand, AppearanceDetailTier>> = {
  close_up: 3,
  portrait: 3,
  waist_up: 2,
  full_figure: 2,
  wide: 1,
};

/**
 * Which coarse body zones a frame contains. The zones are the scene owner's
 * own five (`sceneBodyZoneOf` maps any registry location onto them — wings
 * reach `torso` through `back`, a tail reaches `pelvis`), so no second body
 * vocabulary exists. `full_figure` and `wide` contain the whole figure and
 * need no zone resolution at all.
 */
const FRAME_ZONES: Readonly<Record<VisualFramingBand, readonly SceneBodyZone[] | "all">> = {
  close_up: ["head"],
  portrait: ["head", "torso"],
  waist_up: ["head", "torso", "arms"],
  full_figure: "all",
  wide: "all",
};

/**
 * Visibility for a `hinted` exposure — the same 0.30 the recognition layer
 * calibrated (`RECOGNITION_VISIBILITY_HINTED`), restated rather than imported
 * because an import from `affordances/recognition` becomes a circular import
 * the moment slice 5 makes recognition consume this projection (the scope
 * module records the same ruling).
 */
export const VISUAL_STATE_VISIBILITY_HINTED = 3_000;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The visibility half of the spec's attention context: viewpoint, exposure,
 * and the explicit typed condition reads. Slice 5 extends this with focus,
 * action loci, boosts and the consumer discriminator when it ranks — nothing
 * here selects or scores.
 */
export interface VisualVisibilityContext {
  readonly viewpoint: VisualViewpoint;
  /**
   * Exposure per body location, and (for an observer) the sensory channels.
   *
   * Exposure belongs to the SUBJECT being looked at; channels belong to the
   * viewpoint doing the looking. In a single-subject snapshot this one view
   * answers both. Where a snapshot spans subjects, `perceptionBySubject` is
   * the per-subject exposure and this stays the viewpoint's channel view.
   */
  readonly perception: AffordancePerceptionView;
  /**
   * Exposure per subject, when the snapshot holds more than one. Supplying it
   * makes the exposure read STRICT: a subject with no view of its own resolves
   * nothing rather than borrowing another subject's coverage, because one
   * character's clothes can never answer what another character is showing.
   * Absent ⇒ every subject reads through `perception`, the single-subject case.
   */
  readonly perceptionBySubject?: ReadonlyMap<string, AffordancePerceptionView>;
  readonly lighting: VisualComponentRead<VisualLightingBand>;
  readonly distance: VisualComponentRead<VisualDistanceBand>;
  readonly angle: VisualComponentRead<VisualAngleBand>;
  readonly motion: VisualComponentRead<VisualMotionBand>;
  /** Absent ⇒ unframed. Present-but-unknown fails closed like any component. */
  readonly framing?: VisualComponentRead<VisualFramingBand>;
  /** Consent/context allowance for intimate regions. Absent means NO. */
  readonly intimateAllowed?: boolean;
  /**
   * Per-subject consent allowance, when the snapshot spans subjects. Supplying
   * it makes the gate strict the same way `perceptionBySubject` does: an
   * unlisted subject is NOT allowed, because consent is granted per person and
   * never inherited from whoever else is in frame.
   */
  readonly intimateAllowedBySubject?: ReadonlyMap<string, boolean>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** What one viewpoint can make of one feature. */
export interface VisualStateVisibilityRead {
  readonly key: string;
  /** Composed visibility × exposure × lighting × distance × angle × motion. */
  readonly visibility: UnitInterval;
  /** The highest detail tier these conditions can resolve (1–3). */
  readonly detailTier: AppearanceDetailTier;
  readonly evidence: readonly AffordanceEvidence[];
}

export interface VisualStateVisibilityBuild {
  /** Resolvable features, in the snapshot's own order. */
  readonly visible: readonly VisualStateVisibilityRead[];
  /** Everything the viewpoint cannot resolve, and why. */
  readonly suppressions: readonly VisualStateSuppression[];
}

// ---------------------------------------------------------------------------
// Component resolution
// ---------------------------------------------------------------------------

type ResolvedComponents =
  | {
      readonly ok: true;
      readonly lighting: VisualLightingBand;
      readonly distance: VisualDistanceBand;
      readonly angle: VisualAngleBand;
      readonly motion: VisualMotionBand;
      readonly framing?: VisualFramingBand;
      /** Component names whose value is a declared default, in resolution order. */
      readonly declared: readonly string[];
    }
  | { readonly ok: false; readonly component: string; readonly status: "unknown" | "invalid" };

/** The component names supplied by a declared default, in a fixed order. */
export function visualDeclaredComponents(context: VisualVisibilityContext): readonly string[] {
  const declared: string[] = [];
  if (context.lighting.status === "known" && context.lighting.declared === true) declared.push("lighting");
  if (context.distance.status === "known" && context.distance.declared === true) declared.push("distance");
  if (context.angle.status === "known" && context.angle.declared === true) declared.push("angle");
  if (context.motion.status === "known" && context.motion.declared === true) declared.push("motion");
  if (context.framing?.status === "known" && context.framing.declared === true) declared.push("framing");
  return declared;
}

function resolveComponents(context: VisualVisibilityContext): ResolvedComponents {
  const { lighting, distance, angle, motion, framing } = context;
  if (lighting.status !== "known") return { ok: false, component: "lighting", status: lighting.status };
  if (distance.status !== "known") return { ok: false, component: "distance", status: distance.status };
  if (angle.status !== "known") return { ok: false, component: "angle", status: angle.status };
  if (motion.status !== "known") return { ok: false, component: "motion", status: motion.status };
  if (framing !== undefined && framing.status !== "known") {
    return { ok: false, component: "framing", status: framing.status };
  }
  return {
    ok: true,
    lighting: lighting.value,
    distance: distance.value,
    angle: angle.value,
    motion: motion.value,
    ...(framing === undefined ? {} : { framing: framing.value }),
    declared: visualDeclaredComponents(context),
  };
}

/** The lower of two tiers — `AppearanceDetailTier` is a closed 1|2|3 union, so `<` preserves it. */
function capTier(left: AppearanceDetailTier, right: AppearanceDetailTier): AppearanceDetailTier {
  return left < right ? left : right;
}

/**
 * The exposure view that answers for this subject: its own when the caller
 * supplied a per-subject map, otherwise the single shared view. `undefined`
 * means the caller declared per-subject exposure and has none for this
 * subject — unknown, which fails closed.
 */
function perceptionForSubject(
  context: VisualVisibilityContext,
  subjectId: string,
): AffordancePerceptionView | undefined {
  if (context.perceptionBySubject === undefined) return context.perception;
  return context.perceptionBySubject.get(subjectId);
}

/** Consent for this subject: per-subject when declared, else the shared flag. Absent is NO. */
export function intimateAllowedForSubject(context: VisualVisibilityContext, subjectId: string): boolean {
  if (context.intimateAllowedBySubject === undefined) return context.intimateAllowed === true;
  return context.intimateAllowedBySubject.get(subjectId) === true;
}

/**
 * The intimate group a NON-body feature reaches, through its own accepted
 * `covers`/`occludes` edges: an open shirt front says something about the chest
 * beneath it, so a garment inherits the consent gate of what it sits on. Body
 * loci answer directly and never come here.
 */
function intimateGroupThroughEdges(
  entry: VisualStateCompositionEntry,
  featuresByKey: ReadonlyMap<string, VisualStateFeature>,
): string | undefined {
  for (const relationship of entry.relationships) {
    if (relationship.kind !== "covers" && relationship.kind !== "occludes") continue;
    const target = featuresByKey.get(relationship.targetKey);
    if (target === undefined || target.locus.kind !== "body") continue;
    const group = bodyLocationRegistry.byId(target.locus.locus.bodyLocationId)?.intimateGroup;
    if (group !== undefined) return group;
  }
  return undefined;
}

function frameContainsZone(framing: VisualFramingBand, zone: SceneBodyZone | undefined): boolean {
  const zones = FRAME_ZONES[framing];
  if (zones === "all") return true;
  // A location whose zone cannot be resolved cannot be placed inside a partial
  // frame, and unknown placement fails closed (spec invariant 3).
  return zone !== undefined && zones.includes(zone);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The composition entry for one feature: index-aligned by contract, recovered
 * by key when a hand-built snapshot broke the alignment, and `undefined` when
 * the composition does not know the feature at all — which fails closed.
 */
function compositionEntryAt(
  snapshot: VisualStateSnapshot,
  feature: VisualStateFeature,
  index: number,
): VisualStateCompositionEntry | undefined {
  const aligned = snapshot.composition.entries[index];
  if (aligned !== undefined && aligned.key === feature.key) return aligned;
  return visualStateCompositionFor(snapshot.composition, feature.key);
}

/**
 * Resolve what one viewpoint can make of every feature in a snapshot.
 *
 * Gate order per feature, mirroring the recognition candidates: identity (is
 * the locus usable?) → consent (may we look?) → channel (can an observer see
 * at all?) → exposure (is the surface covered?) → composition (is something in
 * front of it?) → framing (is it in the picture?) → conditions (how well do
 * light, distance, angle and motion resolve it?) → detail tier. Consent sits
 * above every perception branch so an intimate feature reads as GATED rather
 * than as merely unseen, and no later branch can undo it.
 *
 * Determinism is structural: features are walked in the snapshot's sorted
 * order, the condition factor is computed once from closed tables, and the
 * arithmetic is fixed-point throughout.
 */
export function resolveVisualStateVisibility(input: {
  snapshot: VisualStateSnapshot;
  context: VisualVisibilityContext;
  sink?: DiagnosticSink;
  path?: string;
}): VisualStateVisibilityBuild {
  const path = input.path ?? "visual_state.visibility";
  const { snapshot, context } = input;

  const components = resolveComponents(context);
  if (!components.ok) {
    const code =
      components.status === "unknown" ? VISUAL_STATE_VISIBILITY_UNKNOWN : VISUAL_STATE_VISIBILITY_INVALID;
    // One diagnostic for the run, one suppression per feature: the sink tells
    // a developer what degraded, the suppressions tell the inspector why every
    // feature is missing.
    input.sink?.push(
      diag("warn", code, `The ${components.component} read is ${components.status}; nothing is claimed visible`, {
        path,
        context: { component: components.component, viewpoint: context.viewpoint.kind },
      }),
    );
    return {
      visible: [],
      suppressions: snapshot.features.map((feature) => ({
        key: feature.key,
        code,
        detail: components.component,
      })),
    };
  }

  const sighted =
    context.viewpoint.kind !== "observer" || isAffordanceChannelAvailable(context.perception, "sight");
  const conditionFactor = multiplyUnits(
    multiplyUnits(LIGHTING_FACTOR[components.lighting], DISTANCE_FACTOR[components.distance]),
    ANGLE_FACTOR[components.angle],
    MOTION_FACTOR[components.motion],
  );
  let conditionTier = capTier(
    capTier(LIGHTING_TIER_CAP[components.lighting], DISTANCE_TIER_CAP[components.distance]),
    capTier(ANGLE_TIER_CAP[components.angle], MOTION_TIER_CAP[components.motion]),
  );
  if (components.framing !== undefined) {
    conditionTier = capTier(conditionTier, FRAMING_TIER_CAP[components.framing]);
  }
  const conditionsEvidence = affordanceEvidence(
    "environment",
    "visual_state.visibility",
    [
      components.lighting,
      components.distance,
      components.angle,
      components.motion,
      ...(components.framing === undefined ? [] : [components.framing]),
    ].join(":"),
  );
  const viewpointEvidence = affordanceEvidence("adapter", "visual_state.visibility", context.viewpoint.kind);
  // Declared defaults ride on EVERY read they contributed to, so a graded trial
  // row can never mistake a stated policy for an observed condition.
  const declaredEvidence =
    components.declared.length === 0
      ? undefined
      : affordanceEvidence("adapter", "visual_state.visibility.declared_default", components.declared.join(","));
  if (declaredEvidence !== undefined) {
    input.sink?.push(
      diag(
        "info",
        VISUAL_STATE_VISIBILITY_DECLARED,
        `No owner asserts ${components.declared.join(", ")}; the release default is used`,
        { path, context: { components: components.declared.join(","), viewpoint: context.viewpoint.kind } },
      ),
    );
  }

  const visible: VisualStateVisibilityRead[] = [];
  const suppressions: VisualStateSuppression[] = [];
  // Built once: the consent gate resolves a non-body feature's edges to the
  // body features they cover.
  const featuresByKey = new Map(snapshot.features.map((feature) => [feature.key, feature]));

  snapshot.features.forEach((feature, index) => {
    const suppress = (code: string, detail?: string): void => {
      suppressions.push({ key: feature.key, code, ...(detail === undefined ? {} : { detail }) });
    };

    const entry = compositionEntryAt(snapshot, feature, index);
    if (entry === undefined) {
      suppress(VISUAL_STATE_VISIBILITY_UNKNOWN, "composition");
      return;
    }

    // Consent gate — hard, and above every perception branch on purpose. It is
    // resolved for the feature's OWN subject: consent is per person.
    const intimateAllowed = intimateAllowedForSubject(context, feature.subjectId);
    let bodyLocationId: string | undefined;
    if (feature.locus.kind === "body") {
      bodyLocationId = feature.locus.locus.bodyLocationId;
      const location = bodyLocationRegistry.byId(bodyLocationId);
      if (location === undefined) {
        // Defensive: every adapter validates loci, so this is a hand-built
        // record — and an unknown location means the intimate gate cannot be
        // evaluated, which fails closed.
        suppress(VISUAL_STATE_LOCUS_INVALID, bodyLocationId);
        return;
      }
      if (location.intimateGroup !== undefined && !intimateAllowed) {
        suppress(VISUAL_STATE_INTIMATE_GATED, location.intimateGroup);
        return;
      }
    } else if (!intimateAllowed) {
      // A garment or item locus carries no body location of its own, but what
      // it covers does: without this, an intimate-region garment's arrangement
      // reached a consumer while the skin beneath it was correctly gated.
      const group = intimateGroupThroughEdges(entry, featuresByKey);
      if (group !== undefined) {
        suppress(VISUAL_STATE_INTIMATE_GATED, group);
        return;
      }
    }

    if (!sighted) {
      suppress(VISUAL_STATE_VISIBILITY_CHANNEL_UNAVAILABLE, "sight");
      return;
    }

    // Exposure gates BODY surfaces only: the perception view describes what
    // covers the body, and the garments doing the covering (item loci) or a
    // whole-body relation fact are not themselves entries in that map.
    let exposureFactor: UnitInterval = AFFORDANCE_UNIT_ONE;
    let exposureEvidence: AffordanceEvidence | undefined;
    if (bodyLocationId !== undefined) {
      const subjectPerception = perceptionForSubject(context, feature.subjectId);
      if (subjectPerception === undefined) {
        // Per-subject exposure was declared and this subject has none: nobody
        // answered what it is showing, which is unknown, not visible.
        suppress(VISUAL_STATE_VISIBILITY_UNKNOWN, `perception:${feature.subjectId}`);
        return;
      }
      const exposure = affordanceExposureAt(subjectPerception, bodyLocationId);
      switch (exposure) {
        case "hidden":
          suppress(VISUAL_STATE_VISIBILITY_HIDDEN, `exposure:${bodyLocationId}`);
          return;
        case "unknown":
          suppress(VISUAL_STATE_VISIBILITY_UNKNOWN, `exposure:${bodyLocationId}`);
          return;
        case "hinted":
          exposureFactor = toUnitInterval(VISUAL_STATE_VISIBILITY_HINTED);
          break;
        case "visible":
          break;
      }
      exposureEvidence = affordanceEvidence("coverage", bodyLocationId, exposure);
    }

    if (entry.replacedBy !== undefined) {
      suppress(VISUAL_STATE_VISIBILITY_HIDDEN, `replaced:${entry.replacedBy}`);
      return;
    }
    if (entry.effectiveVisibility === AFFORDANCE_UNIT_ZERO) {
      suppress(VISUAL_STATE_VISIBILITY_HIDDEN, "composed");
      return;
    }

    // Framing gates body loci only, for now: a garment's own frame answer
    // needs the effective-coverage read slice 3 wires in, and a subject- or
    // relation-locus fact has no single place to be outside of. Recorded as a
    // simplification, not a claim.
    if (components.framing !== undefined && bodyLocationId !== undefined) {
      const zone = sceneBodyZoneOf(bodyLocationId);
      if (!frameContainsZone(components.framing, zone)) {
        suppress(
          VISUAL_STATE_VISIBILITY_OUT_OF_FRAME,
          `${components.framing}:${zone ?? "zone_unknown"}`,
        );
        return;
      }
    }

    const visibility = multiplyUnits(entry.effectiveVisibility, exposureFactor, conditionFactor);
    if (visibility === AFFORDANCE_UNIT_ZERO) {
      suppress(VISUAL_STATE_VISIBILITY_HIDDEN, "extinguished");
      return;
    }

    if (feature.priors.minimumDetailTier > conditionTier) {
      suppress(VISUAL_STATE_DETAIL_TIER_INSUFFICIENT, String(feature.priors.minimumDetailTier));
      return;
    }

    visible.push({
      key: feature.key,
      visibility,
      detailTier: conditionTier,
      evidence: [
        viewpointEvidence,
        conditionsEvidence,
        ...(declaredEvidence === undefined ? [] : [declaredEvidence]),
        ...(exposureEvidence === undefined ? [] : [exposureEvidence]),
      ],
    });
  });

  return { visible, suppressions };
}

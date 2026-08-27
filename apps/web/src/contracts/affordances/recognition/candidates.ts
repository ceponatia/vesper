import { z } from "zod";
import { bodyLocationRegistry } from "../../body/locations";
import { diag, type DiagnosticSink } from "../../diagnostics";
import {
  bodyLocusKey,
  type AppearanceDetailTier,
  type AppearanceSourceRef,
  type AppearanceStability,
  type BodyLocusRef,
  type ProjectedFeatureTruth,
} from "../../appearance-features";
import {
  affordanceEvidence,
  affordanceExposureAt,
  isAffordanceChannelAvailable,
  toUnitInterval,
  AFFORDANCE_UNIT_ONE,
  type AffordanceEvidence,
  type AffordancePerceptionView,
  type UnitInterval,
} from "../core";

/**
 * Recognition candidates — the observer-relative read over truth-level features.
 *
 * The upstream `ProjectedFeatureTruth` says what the body IS. This module says
 * what THIS observer can currently make of it, and nothing more: three separate
 * salience dimensions (visibility, uniqueness, importance), the provenance that
 * produced them, and an anti-repeat key. It never scores, never remembers, and
 * never writes prose.
 *
 * Three laws, all inherited from the spec's anti-patterns:
 *
 * - **Unknown fails closed.** An unlisted exposure, an unknown body location, or
 *   an unasserted sight channel is not "probably fine" — it is a lane that
 *   cannot answer, and silence is the only safe answer (the core's perception
 *   convention, `core/perception.ts`).
 * - **No rarity bypass.** The intimate-region gate is checked BEFORE anything
 *   else and cannot be outvoted by uniqueness, importance, or inspection focus.
 * - **Importance adjusts at projection time.** The owner ruling (2026-07-28):
 *   the stored base importance is authoring truth; observer relationship and
 *   current attention ride `importanceBoosts` here and never rewrite the base.
 *
 * Blocked features are reported as SUPPRESSIONS, never as zero-visibility
 * candidates — the house representation (`AffordanceSuppression` in
 * `core/types.ts`), so a caller cannot accidentally rank an invisible feature.
 */

/**
 * The stable identity of one conceptual feature for one subject
 * (`subject/fingers:left:ring_finger/presence`). Branded so a repeat key, a
 * locus key, or a body-location id can never be passed where observer memory
 * expects a feature key.
 */
export const recognizableFeatureKeySchema = z.string().trim().min(1).max(256).brand<"RecognizableFeatureKey">();

export type RecognizableFeatureKey = z.infer<typeof recognizableFeatureKeySchema>;

/**
 * Construct a feature key. A blank key is an upstream projection bug, not
 * degraded data — it throws, exactly as `affordanceSubjectId` does. The runtime
 * path (`buildRecognitionCandidates`) never calls this: it parses defensively
 * and degrades a malformed key to a diagnostic plus silence.
 */
export function recognizableFeatureKey(raw: string): RecognizableFeatureKey {
  return recognizableFeatureKeySchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Suppression + diagnostic codes
// ---------------------------------------------------------------------------

/** The projection handed us a key we cannot brand. Degraded input. */
export const RECOGNITION_SUPPRESSED_MALFORMED_KEY = "recognition.feature.malformed_key";
/** Two projected records claimed the same feature key; the first one wins. */
export const RECOGNITION_SUPPRESSED_DUPLICATE_KEY = "recognition.feature.duplicate_key";
/** The locus names a body location no registry knows — the intimate gate cannot be evaluated. */
export const RECOGNITION_SUPPRESSED_UNKNOWN_LOCATION = "recognition.locus.unknown_location";
/** An intimate region without an explicit allowance. A hard gate; rarity never lifts it. */
export const RECOGNITION_SUPPRESSED_INTIMATE = "recognition.intimate.gated";
/** This observer has no sight channel this cut. */
export const RECOGNITION_SUPPRESSED_CHANNEL_UNAVAILABLE = "recognition.channel.unavailable";
/** Covered, occluded, or otherwise not currently perceptible. NOT a claim of absence. */
export const RECOGNITION_SUPPRESSED_HIDDEN = "recognition.exposure.hidden";
/** The lane could not answer for this location — fail closed. */
export const RECOGNITION_SUPPRESSED_UNKNOWN_EXPOSURE = "recognition.exposure.unknown";
/** Visible, but not at the closeness this feature kind requires. */
export const RECOGNITION_SUPPRESSED_DETAIL_TIER = "recognition.detail_tier.insufficient";
/** An observer-relationship importance boost that was not a finite number. */
export const RECOGNITION_DIAGNOSTIC_INVALID_BOOST = "recognition.importance_boost.invalid";

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Visibility for a `hinted` exposure — something is there, but the observer
 * cannot resolve it (a shape under a thin shirt, a mark at the edge of a
 * neckline). Strongly reduced rather than zero so a hinted rarity can still
 * accumulate recognition over many exchanges, but never on its own clears the
 * notice threshold at ordinary uniqueness/importance. A fixture-tested
 * calibration default, not product law.
 */
export const RECOGNITION_VISIBILITY_HINTED = 3_000;

/** Deliberate inspection reaches the closest tier — the ruling's "inspection ~0.25" branch. */
export const RECOGNITION_INSPECTION_DETAIL_TIER: AppearanceDetailTier = 3;

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * One perceptible identity detail, scored on the three separate dimensions the
 * spec insists stay separate (a pre-blended "recognizability" number cannot be
 * diagnosed, and cannot let a common-but-important scar outrank a rare
 * irrelevant mark on purpose).
 *
 * `detailTier` extends the spec's listed fields: it is the tier this observer
 * actually reached (base, or 3 under inspection), which is what the visual
 * memory records as `strongestDetailTier`. It is observer-relative exactly like
 * `visibility`, so it belongs on the observer-relative contract rather than
 * being recomputed — and guessed at — by every consumer.
 */
export interface RecognizableFeatureCandidate {
  readonly key: RecognizableFeatureKey;
  readonly subjectId: string;
  readonly locus: BodyLocusRef;
  readonly sourceRef: AppearanceSourceRef;
  readonly truthFingerprint: string;
  readonly semanticTags: readonly string[];
  readonly stability: AppearanceStability;
  readonly visibility: UnitInterval;
  readonly uniqueness: UnitInterval;
  readonly importance: UnitInterval;
  /** The detail tier this observer reached for this feature (never below the kind's minimum). */
  readonly detailTier: AppearanceDetailTier;
  readonly evidence: readonly AffordanceEvidence[];
  readonly repeatKey: string;
}

/** What one observer brings to the read. Never persisted; recomputed per cut. */
export interface RecognitionObserverContext {
  readonly perception: AffordancePerceptionView;
  /** The tier this observer reaches at ordinary scene distance (chat passes 2). */
  readonly baseDetailTier: AppearanceDetailTier;
  /** Body-location ids under deliberate inspection: tier 3 plus a lowered notice threshold. */
  readonly inspectionFocus?: ReadonlySet<string>;
  /**
   * Projection-time importance adjustment per feature key — observer
   * relationship, current attention, a promise or trauma this observer carries.
   * Signed; the result clamps into the unit range. NEVER written back to truth.
   */
  readonly importanceBoosts?: Readonly<Record<string, number>>;
  /** Consent/context allowance for intimate regions. Absent means NO. */
  readonly intimateAllowed?: boolean;
}

/** A feature that exists but must not surface. Diagnostic-visible only. */
export interface RecognitionSuppression {
  /** The raw projected key — unbranded, because a malformed key is exactly one case here. */
  readonly key: string;
  readonly code: string;
  readonly detail?: string;
}

export interface RecognitionCandidateBuild {
  readonly candidates: readonly RecognizableFeatureCandidate[];
  readonly suppressed: readonly RecognitionSuppression[];
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Provenance for the source that owns this feature's truth. */
function recognitionSourceEvidence(sourceRef: AppearanceSourceRef): AffordanceEvidence {
  switch (sourceRef.kind) {
    case "attribute":
      return affordanceEvidence("attribute", sourceRef.attributeId);
    case "located_fact":
      return affordanceEvidence("state", `appearance_fact:${sourceRef.factId}`);
    case "anatomy":
      return affordanceEvidence("state", `anatomy:${sourceRef.locusKey}`);
    case "condition":
      return affordanceEvidence("state", `condition:${sourceRef.conditionKey}`);
    case "presentation":
      return affordanceEvidence("state", `presentation:${sourceRef.itemId}`);
  }
}

/** The anti-repeat family for this feature, at this locus. */
export function recognitionRepeatKey(repeatFamily: string, locus: BodyLocusRef): string {
  return `recognition.${repeatFamily}.${bodyLocusKey(locus)}`;
}

/**
 * Project truth-level features into this observer's candidates.
 *
 * Gate order is deliberate: identity (can we name it?) → consent (may we look?)
 * → channel (can this observer see at all?) → exposure (is it covered?) →
 * closeness (can they resolve it?). Consent sits above channel and exposure so
 * an intimate feature is reported as gated rather than as merely unseen, and so
 * no later branch can undo it.
 */
export function buildRecognitionCandidates(input: {
  projected: readonly ProjectedFeatureTruth[];
  observer: RecognitionObserverContext;
  sink?: DiagnosticSink;
}): RecognitionCandidateBuild {
  const { observer } = input;
  const sighted = isAffordanceChannelAvailable(observer.perception, "sight");
  const candidates: RecognizableFeatureCandidate[] = [];
  const suppressed: RecognitionSuppression[] = [];
  const seen = new Set<string>();

  for (const truth of input.projected) {
    const parsedKey = recognizableFeatureKeySchema.safeParse(truth.key);
    if (!parsedKey.success) {
      suppressed.push({ key: truth.key, code: RECOGNITION_SUPPRESSED_MALFORMED_KEY });
      input.sink?.push(
        diag("warn", RECOGNITION_SUPPRESSED_MALFORMED_KEY, "Projected feature key is not usable", {
          context: { subjectId: truth.subjectId },
        }),
      );
      continue;
    }
    const key = parsedKey.data;
    if (seen.has(key)) {
      suppressed.push({ key, code: RECOGNITION_SUPPRESSED_DUPLICATE_KEY });
      input.sink?.push(
        diag("warn", RECOGNITION_SUPPRESSED_DUPLICATE_KEY, "Two projected features claim one key", {
          context: { key },
        }),
      );
      continue;
    }
    seen.add(key);

    const locationId = truth.locus.bodyLocationId;
    const location = bodyLocationRegistry.byId(locationId);
    if (location === undefined) {
      suppressed.push({ key, code: RECOGNITION_SUPPRESSED_UNKNOWN_LOCATION, detail: locationId });
      input.sink?.push(
        diag("warn", RECOGNITION_SUPPRESSED_UNKNOWN_LOCATION, "Feature locus names an unknown body location", {
          context: { key, locationId },
        }),
      );
      continue;
    }

    // Consent gate — hard, and above every perception branch on purpose.
    if (location.intimateGroup !== undefined && observer.intimateAllowed !== true) {
      suppressed.push({ key, code: RECOGNITION_SUPPRESSED_INTIMATE, detail: location.intimateGroup });
      continue;
    }

    if (!sighted) {
      suppressed.push({ key, code: RECOGNITION_SUPPRESSED_CHANNEL_UNAVAILABLE, detail: "sight" });
      continue;
    }

    const exposure = affordanceExposureAt(observer.perception, locationId);
    switch (exposure) {
      case "hidden":
        suppressed.push({ key, code: RECOGNITION_SUPPRESSED_HIDDEN, detail: locationId });
        continue;
      case "unknown":
        suppressed.push({ key, code: RECOGNITION_SUPPRESSED_UNKNOWN_EXPOSURE, detail: locationId });
        continue;
      case "visible":
      case "hinted":
        break;
    }

    const inspecting = observer.inspectionFocus?.has(locationId) ?? false;
    const detailTier = inspecting ? RECOGNITION_INSPECTION_DETAIL_TIER : observer.baseDetailTier;
    if (detailTier < truth.priors.minimumDetailTier) {
      suppressed.push({ key, code: RECOGNITION_SUPPRESSED_DETAIL_TIER, detail: String(truth.priors.minimumDetailTier) });
      continue;
    }

    const rawBoost = observer.importanceBoosts?.[key] ?? 0;
    const boost = Number.isFinite(rawBoost) ? Math.trunc(rawBoost) : 0;
    if (!Number.isFinite(rawBoost)) {
      input.sink?.push(
        diag("warn", RECOGNITION_DIAGNOSTIC_INVALID_BOOST, "Importance boost was not a finite number", {
          context: { key },
        }),
      );
    }

    const evidence: AffordanceEvidence[] = [
      recognitionSourceEvidence(truth.sourceRef),
      affordanceEvidence("coverage", locationId, exposure),
      affordanceEvidence("adapter", "recognition.detail_tier", String(detailTier)),
    ];
    if (boost !== 0) {
      evidence.push(affordanceEvidence("adapter", "recognition.importance_boost", String(boost)));
    }

    candidates.push({
      key,
      subjectId: truth.subjectId,
      locus: truth.locus,
      sourceRef: truth.sourceRef,
      truthFingerprint: truth.truthFingerprint,
      semanticTags: truth.semanticTags,
      stability: truth.stability,
      visibility: exposure === "visible" ? AFFORDANCE_UNIT_ONE : toUnitInterval(RECOGNITION_VISIBILITY_HINTED),
      uniqueness: toUnitInterval(truth.priors.baseUniqueness),
      importance: toUnitInterval(truth.priors.baseImportance + boost),
      detailTier,
      evidence,
      repeatKey: recognitionRepeatKey(truth.priors.repeatFamily, truth.locus),
    });
  }

  return { candidates, suppressed };
}

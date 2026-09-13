import { affordanceEvidence } from "../affordances/core";
import { diag, type DiagnosticSink } from "../diagnostics";
import { meterStateCue, type MeterDefinition } from "../meters/registry";
import {
  VISUAL_STATE_KIND_UNKNOWN,
  VISUAL_STATE_METER_EFFECT_ALREADY_STATED,
  VISUAL_STATE_VALUE_INVALID,
} from "./diagnostics";
import {
  validateVisualStateFeature,
  visualStateFeatureKey,
  visualStateFingerprint,
  type VisualStateFeature,
} from "./feature";
import {
  VISUAL_STATE_CONDITION_ACTIVE_KIND_ID,
  VISUAL_STATE_METER_VISIBLE_EFFECT_KIND_ID,
  type VisualStateMeterVisibleEffectValue,
} from "./kinds";
import type { VisualStateLocusRef } from "./locus";
import { visualStateKindRegistry } from "./registry";
import type { VisualStateSuppression } from "./suppression";

/**
 * A meter's ruled visible effect as a current-layer feature (issue #427).
 *
 * The registry (`contracts/meters/registry.ts`) is the one owner of WHICH
 * effect a band states — `visibleEffects` on a threshold, authored only on the
 * four owner-ruled deepest bands — so this adapter never invents wording. It
 * asks `meterStateCue` for the single deepest crossed band exactly as the chat
 * strip and the narrator cue split do, and mints a feature only when that band
 * declares an effect: a shallower band (tipsy, lived-in, tired), a meter with
 * no ruled band at all (stress, mood), or a value that crosses nothing all
 * fall out silently here, precisely because `meterStateCue` already returns
 * nothing for them. A raw meter number never reaches this projection's output
 * — only the registry's typed effect phrases do.
 *
 * Located at the SUBJECT, never a body part: a meter is not placed anywhere on
 * the body (unlike a wetness reading), so the honest home is the same one
 * `projectActiveConditionFeatures` uses for an active condition.
 */

export interface VisualStateMeterProjectionInput {
  readonly subjectId: string;
  /** Current meter values, 0..1. An id the registry does not know is silent. */
  readonly meters: Readonly<Record<string, number>>;
  readonly definitions?: readonly MeterDefinition[];
  /**
   * Features earlier adapters produced. Read ONLY to de-duplicate against an
   * active condition that already states the same real-world effect (issue
   * #427 finding) — a meter never composes a relationship edge onto anything
   * here, unlike `projectBodySurfaceFeatures`'s `modifies` edges.
   */
  readonly composeAgainst?: readonly VisualStateFeature[];
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

/** Features plus what this adapter chose to withhold, for the snapshot. */
export interface VisualStateMeterProjection {
  readonly features: readonly VisualStateFeature[];
  readonly suppressions: readonly VisualStateSuppression[];
}

/** Whether a meter value is a usable [0,1] reading — anything else degrades with a diagnostic. */
function isUsableMeterValue(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Meter id → the catalog condition labels (`contracts/conditions/catalog.ts`,
 * already-normalized keys) that state the SAME real-world effect the meter's
 * ruled band would add.
 *
 * Evidenced against the catalog as it stands, not a general theory of
 * overlap: only the catalog's own `unwashed` condition currently claims one
 * of the four ruled bands' effect (hygiene's `unwashed` band). No catalog
 * entry is named `drunk`, `exhausted`, or a flushed/aroused label, so those
 * three meters have no row here — the day one is added, this table gains one
 * more entry, never a broader heuristic.
 */
const METER_EFFECT_OVERLAPPING_CONDITIONS: Readonly<Record<string, readonly string[]>> = {
  hygiene: ["unwashed"],
};

/** The active condition labels this subject already carries, from `composeAgainst`. */
function activeConditionLabelsOf(subjectId: string, composeAgainst: readonly VisualStateFeature[]): Set<string> {
  const labels = new Set<string>();
  for (const feature of composeAgainst) {
    if (feature.subjectId !== subjectId) continue;
    if (feature.kindId !== VISUAL_STATE_CONDITION_ACTIVE_KIND_ID) continue;
    const value = feature.value;
    if (typeof value === "object" && value !== null && "condition" in value) {
      const condition = (value as { condition: unknown }).condition;
      if (typeof condition === "string") labels.add(condition);
    }
  }
  return labels;
}

/**
 * One subject's meters as visual-state features, in meter-id order (stable —
 * a feature's key ends in the meter id, so this is also key order).
 */
export function projectMeterFeatures(input: VisualStateMeterProjectionInput): VisualStateMeterProjection {
  const path = input.path ?? "visual_state.meter";
  const kind = visualStateKindRegistry.byId(VISUAL_STATE_METER_VISIBLE_EFFECT_KIND_ID);
  if (!kind) {
    input.sink?.push(
      diag("warn", VISUAL_STATE_KIND_UNKNOWN, `${VISUAL_STATE_METER_VISIBLE_EFFECT_KIND_ID} is not registered`, {
        path,
        context: { subjectId: input.subjectId },
      }),
    );
    return { features: [], suppressions: [] };
  }

  const activeConditionLabels = activeConditionLabelsOf(input.subjectId, input.composeAgainst ?? []);
  const meterIds = Object.keys(input.meters).sort();
  const projected: VisualStateFeature[] = [];
  const suppressions: VisualStateSuppression[] = [];
  for (const meterId of meterIds) {
    const value = input.meters[meterId];
    if (value === undefined) continue;
    if (!isUsableMeterValue(value)) {
      input.sink?.push(
        diag("warn", VISUAL_STATE_VALUE_INVALID, `${meterId} is not a usable [0,1] meter reading`, {
          path,
          context: { subjectId: input.subjectId, meterId, value },
        }),
      );
      continue;
    }

    // Unknown meter id, or no crossed band at all: `meterStateCue` already
    // answers null for both, so this adapter adds no vocabulary of its own.
    const cue = meterStateCue(meterId, value, input.definitions);
    if (cue === null) continue;
    // A crossed band with no registry-authored effects is a shallower or
    // unruled band — silent in images by design, not a gap to report.
    if (cue.visibleEffects === undefined || cue.visibleEffects.length === 0) continue;

    const locus: VisualStateLocusRef = { kind: "subject", subjectId: input.subjectId };
    const key = visualStateFeatureKey(input.subjectId, locus, `${VISUAL_STATE_METER_VISIBLE_EFFECT_KIND_ID}:${meterId}`);

    // An active condition already states this exact effect under its own
    // label (issue #427 finding) — mint nothing, so the compiled prompt never
    // restates one real-world fact twice in two vocabularies.
    const overlappingLabels = METER_EFFECT_OVERLAPPING_CONDITIONS[meterId];
    const matchedLabel = overlappingLabels?.find((label) => activeConditionLabels.has(label));
    if (matchedLabel !== undefined) {
      suppressions.push({
        key,
        code: VISUAL_STATE_METER_EFFECT_ALREADY_STATED,
        detail: `condition:${matchedLabel}`,
      });
      continue;
    }

    const bandLabel = cue.pipLabel ?? cue.band;
    const meterValue: VisualStateMeterVisibleEffectValue = {
      meter: meterId,
      band: bandLabel,
      effects: [...cue.visibleEffects],
    };
    const candidate: VisualStateFeature = {
      version: 1,
      key,
      subjectId: input.subjectId,
      kindId: VISUAL_STATE_METER_VISIBLE_EFFECT_KIND_ID,
      layer: kind.layer,
      locus,
      sourceRef: { kind: "meter", meterId, band: cue.band },
      value: meterValue,
      truthFingerprint: visualStateFingerprint(meterValue),
      semanticTags: [`meter:${meterId}`, `band:${bandLabel}`],
      stability: kind.stability,
      // No composition: a meter names no body part or garment to attach to,
      // exactly like an active condition.
      relationships: [],
      priors: kind.priors,
      evidence: [
        affordanceEvidence("adapter", "visual_state.meter", meterId),
        affordanceEvidence("state", `meter:${meterId}`),
      ],
    };
    const accepted = validateVisualStateFeature(candidate, input.sink, path);
    if (accepted !== null) projected.push(accepted);
  }
  return { features: projected, suppressions };
}

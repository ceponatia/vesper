import { affordanceEvidence } from "../affordances/core";
import { conditionKey, isConditionExpired, type ActiveCondition } from "../conditions/condition";
import { diag, type DiagnosticSink } from "../diagnostics";
import { VISUAL_STATE_KIND_UNKNOWN } from "./diagnostics";
import {
  validateVisualStateFeature,
  visualStateFeatureKey,
  visualStateFingerprint,
  type VisualStateFeature,
} from "./feature";
import {
  VISUAL_STATE_CONDITION_ACTIVE_KIND_ID,
  type VisualStateActiveConditionValue,
} from "./kinds";
import { encodeVisualStateKeySegment, type VisualStateLocusRef } from "./locus";
import { visualStateKindRegistry } from "./registry";

/**
 * Active located conditions as current-layer features.
 *
 * The "located" half is a recorded impossibility, not an oversight: the
 * condition owner carries no body locus — a condition cannot be placed — so
 * every condition projects at the SUBJECT locus, the one home that claims
 * nothing the owner cannot prove. The day the owner grows a locus, this
 * adapter moves the feature onto it; guessing a body location today would
 * invent exactly the kind of fact the plan forbids.
 *
 * The value is the condition's CANONICAL KEY (`conditionKey` — the normalized
 * label every condition-vocabulary table in the app matches on) plus its
 * severity. The label is the owner's committed identity, not narrator prose;
 * `promptHint` and the attribute overlays stay behind, because the first is
 * prose and the second is another owner's projection (resolved attributes),
 * already carried by the appearance lane.
 *
 * Expiry is the lazy time integration here: a condition whose duration has run
 * out by the cut's story minute projects nothing, exactly as the engine would
 * have expired it, and `validUntilMinutes` carries the same boundary forward
 * for the ones still active.
 */

export interface VisualStateActiveConditionProjectionInput {
  readonly subjectId: string;
  readonly conditions: readonly ActiveCondition[];
  /** The committed cut's story minute — expiry is evaluated against it. */
  readonly atMinutes: number;
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The condition key as a key-safe aspect segment: the injective escape, then
 * whitespace to `%20` (already escaped away by the first step, so the result
 * stays injective — "hung over" and "hung%20over" cannot collide).
 */
function conditionAspectSegment(key: string): string {
  return encodeVisualStateKeySegment(key).replaceAll(/\s/g, "%20");
}

/** The condition key as a semantic tag: same vocabulary, tag-legal spelling. */
function conditionTag(key: string): string {
  return key.replaceAll(/\s+/g, "_");
}

/**
 * One subject's unexpired conditions as visual-state features, in canonical-key
 * order. Two conditions sharing one canonical key (the owner allows duplicate
 * labels under distinct random ids) collapse to the first by story start —
 * they are one fact, and the snapshot would otherwise drop the second as a
 * duplicate key with a scarier diagnostic.
 */
export function projectActiveConditionFeatures(
  input: VisualStateActiveConditionProjectionInput,
): readonly VisualStateFeature[] {
  const path = input.path ?? "visual_state.condition";
  const kind = visualStateKindRegistry.byId(VISUAL_STATE_CONDITION_ACTIVE_KIND_ID);
  if (!kind) {
    input.sink?.push(
      diag("warn", VISUAL_STATE_KIND_UNKNOWN, `${VISUAL_STATE_CONDITION_ACTIVE_KIND_ID} is not registered`, {
        path,
        context: { subjectId: input.subjectId },
      }),
    );
    return [];
  }

  const active = input.conditions
    .filter((condition) => !isConditionExpired(condition, input.atMinutes))
    .sort((left, right) => {
      const byKey = compareStrings(conditionKey(left), conditionKey(right));
      if (byKey !== 0) return byKey;
      const byStart = left.startedAtMinutes - right.startedAtMinutes;
      return byStart !== 0 ? byStart : compareStrings(left.id, right.id);
    });

  const projected: VisualStateFeature[] = [];
  const seen = new Set<string>();
  for (const condition of active) {
    const key = conditionKey(condition);
    if (seen.has(key)) continue;
    seen.add(key);

    const locus: VisualStateLocusRef = { kind: "subject", subjectId: input.subjectId };
    const value: VisualStateActiveConditionValue = {
      condition: key,
      ...(condition.severity === undefined ? {} : { severity: condition.severity }),
    };
    const validUntilMinutes =
      condition.durationMinutes === undefined
        ? undefined
        : condition.startedAtMinutes + condition.durationMinutes;
    const candidate: VisualStateFeature = {
      version: 1,
      key: visualStateFeatureKey(
        input.subjectId,
        locus,
        `${VISUAL_STATE_CONDITION_ACTIVE_KIND_ID}:${conditionAspectSegment(key)}`,
      ),
      subjectId: input.subjectId,
      kindId: VISUAL_STATE_CONDITION_ACTIVE_KIND_ID,
      layer: kind.layer,
      locus,
      sourceRef: { kind: "body_condition", conditionId: condition.id },
      value,
      truthFingerprint: visualStateFingerprint(value),
      semanticTags: [
        conditionTag(key),
        ...(condition.severity === undefined ? [] : [condition.severity]),
      ],
      stability: kind.stability,
      // No composition: without a locus the owner cannot say what a condition
      // sits on, and an edge to "everything" would be an invented fact.
      relationships: [],
      priors: kind.priors,
      evidence: [
        affordanceEvidence("adapter", "visual_state.condition", key),
        affordanceEvidence("state", `condition:${condition.id}`),
      ],
      changedAtMinutes: condition.startedAtMinutes,
      ...(validUntilMinutes === undefined ? {} : { validUntilMinutes }),
    };
    const accepted = validateVisualStateFeature(candidate, input.sink, path);
    if (accepted !== null) projected.push(accepted);
  }
  return projected;
}

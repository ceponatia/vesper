import { affordanceEvidence, type AffordanceEvidence } from "../affordances/core";
import { bodyLocationRegistry, FEATURE_GROUPS, type FeatureGroup } from "../body/locations";
import { diag, type DiagnosticSink } from "../diagnostics";
import type { RealizedBody } from "../species";
import { VISUAL_STATE_FEATURE_GROUP_UNPLACED, VISUAL_STATE_KIND_UNKNOWN } from "./diagnostics";
import {
  validateVisualStateFeature,
  visualStateFeatureKey,
  visualStateFingerprint,
  type VisualStateFeature,
} from "./feature";
import {
  VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
  type VisualStateSpeciesFeatureGroupValue,
} from "./kinds";
import { visualStateKindRegistry } from "./registry";

/**
 * Species and heritage feature groups as identity features
 * (visual-state.audit.md finding 11).
 *
 * Wings, horns and a tail are the app's real answer to "intentional extra
 * anatomy", and they are NOT anatomy state: `anatomyPartStateValues` has
 * `present`, `absent`, `altered` and `prosthetic` and no `extra`, so a character
 * can never gain or lose an appendage as an event. They are static additive
 * groups composed by `realizeBody` from the species defaults, the heritage
 * overlay, and the per-character `bodyFeatures` override.
 *
 * That makes them the highest-stakes thing this projection emits. They are
 * `inherent`, mandatory for both identity and continuity, and tier 1 — visible
 * in a silhouette — precisely because an image quality prompt left to itself
 * will "correct" a winged character into a wingless one, and the plan's ruling
 * is that salience may never trade morphology away.
 *
 * This adapter reads the REALIZED body rather than the species row: a per-
 * character override is authoritative over the species default, and `realizeBody`
 * is the one place that composition already happens.
 */

export interface VisualStateSpeciesProjectionInput {
  readonly subjectId: string;
  readonly realizedBody: RealizedBody;
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Which body locations carry which feature group, resolved once from the
 * registry rather than assumed.
 *
 * The three groups happen to share their ids with their body locations today
 * (`wings` → `wings`), and hard-coding that coincidence would silently project
 * nothing the day a group grows a second location. Groups keep their registry
 * order; locations inside a group are sorted, so the output order is fixed.
 */
const FEATURE_GROUP_LOCATIONS: readonly { readonly group: FeatureGroup; readonly locationId: string }[] =
  FEATURE_GROUPS.flatMap((group) =>
    bodyLocationRegistry.all
      .filter((location) => location.featureGroup === group)
      .map((location) => location.id)
      .sort(compareStrings)
      .map((locationId) => ({ group, locationId })),
  );

function speciesEvidence(realizedBody: RealizedBody, group: FeatureGroup): AffordanceEvidence[] {
  const evidence = [
    affordanceEvidence("adapter", "visual_state.species", group),
    affordanceEvidence("state", `species:${realizedBody.speciesId}`),
  ];
  if (realizedBody.heritageId !== undefined) {
    evidence.push(affordanceEvidence("state", `heritage:${realizedBody.heritageId}`));
  }
  return evidence;
}

/**
 * One subject's realized feature groups as identity features.
 *
 * A group that is switched on but whose body location the species or body plan
 * removed produces silence plus a diagnostic: the character is declared to have
 * wings and there is nowhere on the body to put them, which is an authoring
 * contradiction the projection must report rather than resolve.
 */
export function projectSpeciesFeatureGroups(
  input: VisualStateSpeciesProjectionInput,
): readonly VisualStateFeature[] {
  const path = input.path ?? "visual_state.species";
  const kind = visualStateKindRegistry.byId(VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID);
  if (!kind) {
    input.sink?.push(
      diag("warn", VISUAL_STATE_KIND_UNKNOWN, `${VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID} is not registered`, {
        path,
        context: { subjectId: input.subjectId },
      }),
    );
    return [];
  }

  const projected: VisualStateFeature[] = [];
  for (const { group, locationId } of FEATURE_GROUP_LOCATIONS) {
    if (!input.realizedBody.hasFeature(group)) continue;
    if (!input.realizedBody.isLocationPresent(locationId)) {
      // Its own code, not `source.unavailable`: that one means "an owner exists
      // upstream and this projection has no kind for it yet". This is the
      // opposite — the kind exists and the owner answered, contradicting itself.
      input.sink?.push(
        diag("warn", VISUAL_STATE_FEATURE_GROUP_UNPLACED, `${group} is realized with no ${locationId} location`, {
          path,
          context: { subjectId: input.subjectId, group, locationId },
        }),
      );
      continue;
    }
    const value: VisualStateSpeciesFeatureGroupValue = { group };
    const locus = { kind: "body", locus: { bodyLocationId: locationId } } as const;
    const candidate: VisualStateFeature = {
      version: 1,
      key: visualStateFeatureKey(input.subjectId, locus, VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID),
      subjectId: input.subjectId,
      kindId: VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
      layer: kind.layer,
      locus,
      // Its own source arm, not an attribute one: `wings.shape` is a different
      // owner describing what the wings LOOK like, and pointing at it would send
      // a reader to a row that says nothing about whether the wings exist.
      sourceRef: { kind: "species_feature", speciesId: input.realizedBody.speciesId, featureGroup: group },
      value,
      truthFingerprint: visualStateFingerprint(value),
      semanticTags: [group, locationId, input.realizedBody.speciesId],
      stability: kind.stability,
      // A feature group asserts nothing about other features. What the wings
      // look like, and what covers them, come from other owners.
      relationships: [],
      priors: kind.priors,
      evidence: speciesEvidence(input.realizedBody, group),
    };
    const accepted = validateVisualStateFeature(candidate, input.sink, path);
    if (accepted !== null) projected.push(accepted);
  }
  return projected;
}

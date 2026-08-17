import { affordanceEvidence, type AffordanceEvidence } from "../affordances/core";
import { bodyLocationRegistry } from "../body/locations";
import { diag, type DiagnosticSink } from "../diagnostics";
import { GARMENT_CONDITION_BAND_LADDERS } from "../items/garment-condition";
import {
  BODY_SURFACE_DRY_RATE_PER_HOUR,
  bodySurfaceWetnessAt,
  bodySurfaceWetnessEntry,
  isInvalidSurfaceEntry,
  type BodySurfaceState,
} from "../state/body-surface";
import { precipitationActive, type ChatEnvironment } from "../state/chat-environment";
import { VISUAL_STATE_KIND_UNKNOWN, VISUAL_STATE_SOURCE_INVALID } from "./diagnostics";
import {
  validateVisualStateFeature,
  visualStateFeatureKey,
  visualStateFingerprint,
  type VisualStateFeature,
} from "./feature";
import {
  bodySurfaceWetnessBands,
  VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID,
  type BodySurfaceWetnessBand,
  type VisualStateBodySurfaceWetnessValue,
} from "./kinds";
import { visualStateKindRegistry } from "./registry";
import type { VisualStateRelationship } from "./relationships";
import type { VisualStateSuppression } from "./suppression";

/**
 * Body-surface state as current-layer features (visual-state.audit.md finding
 * 11 — "owned and written for the whole body but spent for hair alone"; this
 * adapter is the second reader the owner was built for).
 *
 * The read is LAZY and pure: `bodySurfaceWetnessAt` integrates the flat drying
 * law forward to the cut's story minute and persists nothing, so the same
 * committed state at the same minute is byte-equal on every replay, and a
 * projection can never dry anyone (§25.2 — queries never persist).
 *
 * Bands, never fixed point. The band comes through the GARMENT wetness ladder
 * (`GARMENT_CONDITION_BAND_LADDERS.wetness`) rather than a ladder of this
 * module's own, so wet hair and a wet shirt can never disagree about where
 * `damp` begins. No hysteresis here on purpose: hysteresis needs the band a
 * consumer last reported, which is mention state — a consumer concern the
 * projection must not read, or the same committed truth would stop producing
 * the same snapshot.
 *
 * Three answers, kept three (the owner's own law):
 *
 * - **absent or dried to `dry`** — silence. Dry is the default, not a feature.
 * - **known and non-dry** — one feature per location, banded.
 * - **quarantined (`invalid`)** — silence PLUS a suppression and a diagnostic.
 *   A corrupt entry can never read as dry, and it can never read as wet either.
 */

export interface VisualStateBodySurfaceProjectionInput {
  readonly subjectId: string;
  readonly state: BodySurfaceState;
  /** The committed cut's story minute — the lazy-integration target. */
  readonly atMinutes: number;
  /**
   * The scene environment, when the caller has one. Standing outdoor
   * precipitation HOLDS wetness (the owner's law 5): the level is read as
   * committed and the validity window is absent, because "when will this dry"
   * has no honest answer while it is still raining.
   */
  readonly environment?: ChatEnvironment;
  /**
   * Features earlier adapters produced. `modifies` edges are emitted only
   * against these — wetness at the hair modifies the hairstyle worn there and
   * the identity facts beneath it, and an adapter that cannot see its target
   * asserts nothing.
   */
  readonly composeAgainst?: readonly VisualStateFeature[];
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

/** Features plus what the source itself could not answer, for the snapshot. */
export interface VisualStateBodySurfaceProjection {
  readonly features: readonly VisualStateFeature[];
  readonly suppressions: readonly VisualStateSuppression[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The shared wetness ladder read for this adapter: the band a level falls in,
 * or `null` for the `dry` rung (silence). Walking the garment ladder directly —
 * rather than copying its floors — is what pins the two vocabularies together.
 */
export function visualStateBodyWetnessBand(level: number): BodySurfaceWetnessBand | null {
  let band: string = "dry";
  for (const [floor, label] of GARMENT_CONDITION_BAND_LADDERS.wetness) {
    if (level >= floor) band = label;
  }
  return (bodySurfaceWetnessBands as readonly string[]).includes(band)
    ? (band as BodySurfaceWetnessBand)
    : null;
}

/** The fixed-point floor of a band on the shared wetness ladder. */
function wetnessBandFloor(band: BodySurfaceWetnessBand): number {
  return GARMENT_CONDITION_BAND_LADDERS.wetness.find(([, label]) => label === band)?.[0] ?? 0;
}

/**
 * The first story minute at which the current band no longer holds, under the
 * owner's flat drying law — the feature's validity window.
 *
 * Exact integer arithmetic against `linearDriftStep`'s own floor-division: the
 * band stops holding at the smallest `m` with
 * `floor(rate · 60m / 3600) ≥ level − floor + 1`, which is
 * `ceil(60 · (level − floor + 1) / rate)` minutes after the read. No logs, no
 * floats, no approximation to drift from the kernel.
 */
function wetnessValidUntil(level: number, band: BodySurfaceWetnessBand, atMinutes: number): number {
  const floor = wetnessBandFloor(band);
  return atMinutes + Math.ceil((60 * (level - floor + 1)) / BODY_SURFACE_DRY_RATE_PER_HOUR);
}

/**
 * The features this location's wetness sits on top of: identity and
 * presentation facts of the same subject within the location's own subtree.
 * Wet hair modifies the hairstyle worn there and the hair colour beneath it;
 * it says nothing about the shoulders the water dripped from.
 */
function modifiedKeys(
  subjectId: string,
  locationId: string,
  composeAgainst: readonly VisualStateFeature[],
): string[] {
  const covered = new Set(bodyLocationRegistry.expand(locationId));
  const keys: string[] = [];
  for (const target of composeAgainst) {
    if (target.subjectId !== subjectId) continue;
    if (target.layer !== "identity" && target.layer !== "presentation") continue;
    if (target.locus.kind !== "body") continue;
    if (!covered.has(target.locus.locus.bodyLocationId)) continue;
    keys.push(target.key);
  }
  return keys.sort(compareStrings);
}

/**
 * One subject's standing surface wetness as visual-state features.
 *
 * Locations project in sorted id order, so the output does not depend on the
 * order writes happened to land in the stored record. An unknown location id
 * (the owner deliberately stores loose keys so a future location never breaks
 * a row) is dropped by the shared feature validator with its own diagnostics.
 */
export function projectBodySurfaceFeatures(
  input: VisualStateBodySurfaceProjectionInput,
): VisualStateBodySurfaceProjection {
  const path = input.path ?? "visual_state.body_surface";
  const composeAgainst = input.composeAgainst ?? [];
  const suppressions: VisualStateSuppression[] = [];
  const features: VisualStateFeature[] = [];

  const kind = visualStateKindRegistry.byId(VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID);
  if (!kind) {
    input.sink?.push(
      diag("warn", VISUAL_STATE_KIND_UNKNOWN, `${VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID} is not registered`, {
        path,
        context: { subjectId: input.subjectId },
      }),
    );
    return { features, suppressions };
  }

  const suspendDrying = input.environment !== undefined && precipitationActive(input.environment);

  for (const locationId of Object.keys(input.state.wetness).sort(compareStrings)) {
    const locus = { kind: "body", locus: { bodyLocationId: locationId } } as const;
    const key = visualStateFeatureKey(input.subjectId, locus, VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID);

    const read = bodySurfaceWetnessAt(input.state, locationId, input.atMinutes, { suspendDrying });
    if (read.status === "invalid") {
      // The owner quarantined this entry: the wetness data is GONE, and neither
      // "dry" nor "wet" may be invented for it. Silence, on the record.
      suppressions.push({ key, code: VISUAL_STATE_SOURCE_INVALID, detail: "body_surface" });
      input.sink?.push(
        diag("warn", VISUAL_STATE_SOURCE_INVALID, `Body-surface entry at ${locationId} is quarantined`, {
          path,
          context: { subjectId: input.subjectId, locationId },
        }),
      );
      continue;
    }

    const band = visualStateBodyWetnessBand(read.level);
    if (band === null) continue;

    const entry = bodySurfaceWetnessEntry(input.state, locationId);
    const cause = entry !== undefined && !isInvalidSurfaceEntry(entry) ? entry.cause : undefined;
    const changedAtMinutes =
      entry !== undefined && !isInvalidSurfaceEntry(entry) ? entry.updatedAtMinutes : undefined;

    const value: VisualStateBodySurfaceWetnessValue = { band };
    const relationships: VisualStateRelationship[] = modifiedKeys(
      input.subjectId,
      locationId,
      composeAgainst,
    ).map((targetKey) => ({ kind: "modifies", targetKey }));

    const evidence: AffordanceEvidence[] = [
      affordanceEvidence("adapter", "visual_state.body_surface", locationId),
      affordanceEvidence("state", `body_surface:${input.subjectId}:${locationId}`),
    ];
    if (cause !== undefined) evidence.push(affordanceEvidence("event", `cause:${cause}`));
    if (suspendDrying) {
      evidence.push(affordanceEvidence("environment", "precipitation", input.environment?.precipitation));
    }

    const candidate: VisualStateFeature = {
      version: 1,
      key,
      subjectId: input.subjectId,
      kindId: VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID,
      layer: kind.layer,
      locus,
      sourceRef: { kind: "body_surface", subjectId: input.subjectId, locationId },
      value,
      truthFingerprint: visualStateFingerprint(value),
      semanticTags: [band, ...(cause === undefined ? [] : [cause])],
      stability: kind.stability,
      relationships,
      priors: kind.priors,
      evidence,
      ...(changedAtMinutes === undefined ? {} : { changedAtMinutes }),
      // Held wetness has no honest expiry: while rain is landing, "when will
      // this dry" is unanswerable, and an invented window would age it anyway.
      ...(suspendDrying ? {} : { validUntilMinutes: wetnessValidUntil(read.level, band, input.atMinutes) }),
    };
    const accepted = validateVisualStateFeature(candidate, input.sink, path);
    if (accepted !== null) features.push(accepted);
  }

  return { features, suppressions };
}

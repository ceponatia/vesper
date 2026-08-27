import type { AffordanceObservation, AffordanceSuppression } from "./types";

/**
 * Observer perception — the filter between physical truth and what one observer
 * may be told.
 *
 * Two structural rulings, both inherited from the garment cue block
 * (`items/garment-observation.ts`, which drops `hidden` parts before ranking):
 *
 * - **Resolution is observer-independent.** A phenomenon never consults
 *   perception; contact behind an opaque hood still RESOLVES, it just never
 *   surfaces. That keeps physical state consistent across observers and keeps
 *   the "possible ≠ observed" boundary in one place.
 * - **Unknown fails closed.** An absent exposure entry is not "probably fine";
 *   it is a lane that cannot answer, and the audit is explicit that shared
 *   perception "may represent unsupported channels as unavailable, never
 *   permissive". Same for channels: a lane that does not positively assert
 *   sight gets silence, not the benefit of the doubt.
 */

/** What an observer can make of a body location. */
export const affordanceExposures = ["visible", "hinted", "hidden", "unknown"] as const;
export type AffordanceExposure = (typeof affordanceExposures)[number];

/**
 * Sensory channels. `sight` is the one every affordance observation needs —
 * these reads are the plan's *visual* observations — but the record shape lets a
 * lane mark the others unavailable now and carry non-visual reads later without
 * a shape change.
 */
export const affordanceChannels = ["sight", "sound", "touch", "smell"] as const;
export type AffordanceChannel = (typeof affordanceChannels)[number];

export type AffordanceChannelAvailability = "available" | "unavailable";

export interface AffordancePerceptionView {
  /** Body-location id → exposure. A missing key reads `unknown` and fails closed. */
  readonly exposure: Readonly<Record<string, AffordanceExposure>>;
  /** Channel → availability. A missing key reads unavailable and fails closed. */
  readonly channels: Readonly<Partial<Record<AffordanceChannel, AffordanceChannelAvailability>>>;
}

/** Suppression codes this filter writes onto the `suppressed` resolutions. */
export const AFFORDANCE_PERCEPTION_HIDDEN = "affordance.perception.hidden";
export const AFFORDANCE_PERCEPTION_UNKNOWN = "affordance.perception.unknown";
export const AFFORDANCE_PERCEPTION_CHANNEL_UNAVAILABLE = "affordance.perception.channel_unavailable";

/** Nothing is known about this observer — the fail-closed default and degraded value. */
export function emptyAffordancePerceptionView(): AffordancePerceptionView {
  return { exposure: {}, channels: {} };
}

export function affordancePerceptionView(input: {
  exposure?: Readonly<Record<string, AffordanceExposure>>;
  channels?: Readonly<Partial<Record<AffordanceChannel, AffordanceChannelAvailability>>>;
}): AffordancePerceptionView {
  return { exposure: input.exposure ?? {}, channels: input.channels ?? {} };
}

/** Exposure at a body location; unlisted locations are `unknown`. */
export function affordanceExposureAt(view: AffordancePerceptionView, locationId: string): AffordanceExposure {
  return view.exposure[locationId] ?? "unknown";
}

/** A channel is usable only when the lane positively says so. */
export function isAffordanceChannelAvailable(view: AffordancePerceptionView, channel: AffordanceChannel): boolean {
  return view.channels[channel] === "available";
}

/** Why (if at all) this exposure blocks a read. */
function exposureBlock(exposure: AffordanceExposure): string | null {
  switch (exposure) {
    case "visible":
    case "hinted":
      return null;
    case "hidden":
      return AFFORDANCE_PERCEPTION_HIDDEN;
    case "unknown":
      return AFFORDANCE_PERCEPTION_UNKNOWN;
  }
}

export interface AffordancePerceptionSplit {
  /** Observations this observer may be offered, in input order. */
  readonly observations: readonly AffordanceObservation[];
  /** Physically true, perception-blocked — diagnostic-visible only. */
  readonly suppressed: readonly AffordanceSuppression[];
}

/**
 * Split resolved observations by what this observer can perceive.
 *
 * An observation needs BOTH ends: its source location and, when it names one,
 * its target. Hair adhering to a neck under a closed hood is suppressed by
 * either end being covered — which is the difference between "the contact did
 * not happen" (a physical claim this layer must not make) and "you cannot see
 * it" (the only claim perception is entitled to).
 */
export function filterAffordanceObservations(input: {
  observations: readonly AffordanceObservation[];
  perception: AffordancePerceptionView;
}): AffordancePerceptionSplit {
  const observations: AffordanceObservation[] = [];
  const suppressed: AffordanceSuppression[] = [];
  const sighted = isAffordanceChannelAvailable(input.perception, "sight");

  for (const observation of input.observations) {
    if (!sighted) {
      suppressed.push({
        kind: "suppressed",
        phenomenonId: observation.id,
        code: AFFORDANCE_PERCEPTION_CHANNEL_UNAVAILABLE,
        detail: "sight",
      });
      continue;
    }
    const ends: readonly string[] =
      observation.targetLocationId === undefined
        ? [observation.sourceLocationId]
        : [observation.sourceLocationId, observation.targetLocationId];
    const blocked = ends
      .map((locationId) => ({ locationId, code: exposureBlock(affordanceExposureAt(input.perception, locationId)) }))
      .find((end): end is { locationId: string; code: string } => end.code !== null);
    if (blocked !== undefined) {
      suppressed.push({
        kind: "suppressed",
        phenomenonId: observation.id,
        code: blocked.code,
        detail: blocked.locationId,
      });
      continue;
    }
    observations.push(observation);
  }
  return { observations, suppressed };
}

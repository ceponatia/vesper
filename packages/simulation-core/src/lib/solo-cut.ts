import type { PhysicalLocus, Journey } from "../contracts/space";
import type { ActivityInstance } from "../contracts/activities";
import type { Commitment } from "../contracts/commitments";
import { humanizeActivity } from "./humanize";

/**
 * Solo-cut shaping (world-ui.plan.md slice 0, ruling 21) — PURE. When a turn
 * runs without a co-present primary, the render is **dual-block**: (a) a
 * second-person player-side block reacting to what the player does in their own
 * zone, and (b) a third-person AWAY VIGNETTE of the primary living their
 * routine. This module turns the raw simulation projections (loci, journeys,
 * activities, commitments, held items) into the structured, id-free context the
 * two blocks need, and a deterministic fallback prose the narrator degrades to
 * (docs/resilience.md — a solo turn NEVER dead-ends).
 *
 * No IO, no env, no db (src/lib purity): the caller loads the projections and
 * passes typed pieces in; every zone/actor label arrives resolved through the
 * caller's display-label seam so no raw id ever reaches this shaping (charter
 * law — display labels, never raw identifiers).
 */

/** Activity phases that read as "happening right now" for narration (§16.2 activity phases). */
const LIVE_ACTIVITY_PHASES = new Set<string>(["active", "preparing"]);

export interface SoloActorPresence {
  /** Display name (never an id). */
  name: string;
  /** A humanized verb phrase for what they are doing, when known. */
  activity?: string;
}

export interface SoloPlayerSide {
  /** The player's zone display noun ("home", "town square"); "" while in transit. */
  zoneLabel: string;
  /** True when the player is themselves on the move between zones. */
  inTransit: boolean;
  /** Destination display noun when in transit. */
  transitToLabel?: string;
  /** Seconds until the player's earliest arrival when in transit. */
  arrivesInSeconds?: number;
  /** Other actors physically here with the player (the primary is never listed — the vignette owns them). */
  coPresent: readonly SoloActorPresence[];
  /** Item display names the player is holding. */
  heldItems: readonly string[];
}

export interface SoloVignette {
  primaryName: string;
  /** The primary's zone display noun; "" while in transit / unknown. */
  zoneLabel: string;
  inTransit: boolean;
  transitToLabel?: string;
  /** A humanized verb phrase for the primary's active activity, when any. */
  activity?: string;
  /**
   * The engine-supplied routine MUSTs (ruling 21) — TRUE, FIXED facts the
   * narrator colors within but can never contradict, already rendered as
   * id-free English sentences (location, activity, due commitments).
   */
  routineMusts: readonly string[];
}

export interface SoloCutContext {
  playerName: string;
  primaryName: string;
  playerSide: SoloPlayerSide;
  /** Absent when the vignette context could not be built — block (a) renders alone (ruling 21 degradation). */
  vignette?: SoloVignette;
}

/** "at home" reads better than "at the home"; everything else takes the article. */
export function placeAtPhrase(zoneLabel: string): string {
  if (!zoneLabel) return "somewhere nearby";
  return zoneLabel === "home" ? "at home" : `at the ${zoneLabel}`;
}

/** A commitment deadline as relative story time (never a clock second). */
function deadlinePhrase(deltaSeconds: number): string {
  if (deltaSeconds <= 0) return "already due";
  if (deltaSeconds < 20 * 60) return "within minutes";
  if (deltaSeconds < 90 * 60) return "within about an hour";
  if (deltaSeconds < 6 * 3_600) return "in a few hours";
  if (deltaSeconds < 24 * 3_600) return "later today";
  return "in the days ahead";
}

/** Grammatical join of display names: "A", "A and B", "A, B, and C". */
function joinNames(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Commitment statuses that still bind the actor (a live obligation to respect). */
export const OPEN_COMMITMENT_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "noticed",
  "accepted",
  "in_progress",
]);

interface LocusResolution {
  zoneLabel: string;
  inTransit: boolean;
  transitToLabel?: string;
  arrivesInSeconds?: number;
}

/** Resolve one actor's locus into display fields (the journey supplies the destination + ETA in transit). */
function resolveLocus(
  locus: PhysicalLocus | undefined,
  journeys: readonly Journey[],
  zoneLabelOf: (zoneId: string) => string,
  atStorySecond: number,
): LocusResolution {
  if (!locus) return { zoneLabel: "", inTransit: false };
  if (locus.kind === "at") return { zoneLabel: zoneLabelOf(locus.zoneId), inTransit: false };
  const journey = journeys.find((candidate) => candidate.id === locus.journeyId);
  return {
    zoneLabel: "",
    inTransit: true,
    ...(journey ? { transitToLabel: zoneLabelOf(journey.destinationZoneId) } : {}),
    arrivesInSeconds: Math.max(0, (journey?.earliestArrivalAt ?? locus.earliestExitAt) - atStorySecond),
  };
}

/** The one live activity an actor is engaged in (humanized), if any. */
function liveActivityFor(actorId: string, activities: readonly ActivityInstance[]): string | undefined {
  const activity = activities.find(
    (candidate) => candidate.actorIds.some((id) => id === actorId) && LIVE_ACTIVITY_PHASES.has(candidate.phase),
  );
  return activity ? humanizeActivity(activity.actionDefinitionId) : undefined;
}

export interface BuildSoloPlayerSideInput {
  playerActorId: string;
  primaryActorId: string;
  loci: readonly PhysicalLocus[];
  journeys: readonly Journey[];
  activities: readonly ActivityInstance[];
  heldItems: readonly string[];
  zoneLabelOf: (zoneId: string) => string;
  actorNameOf: (actorId: string) => string;
  atStorySecond: number;
}

/** Block (a): the player's own zone, who is here with them, and what they hold. */
export function buildSoloPlayerSide(input: BuildSoloPlayerSideInput): SoloPlayerSide {
  const playerLocus = input.loci.find((locus) => locus.actorId === input.playerActorId);
  const resolved = resolveLocus(playerLocus, input.journeys, input.zoneLabelOf, input.atStorySecond);

  const coPresent: SoloActorPresence[] =
    playerLocus && playerLocus.kind === "at"
      ? input.loci
          .filter(
            (locus) =>
              locus.kind === "at" &&
              locus.zoneId === playerLocus.zoneId &&
              locus.actorId !== input.playerActorId &&
              locus.actorId !== input.primaryActorId,
          )
          .map((locus) => {
            const activity = liveActivityFor(locus.actorId, input.activities);
            return { name: input.actorNameOf(locus.actorId), ...(activity ? { activity } : {}) };
          })
      : [];

  return {
    zoneLabel: resolved.zoneLabel,
    inTransit: resolved.inTransit,
    ...(resolved.transitToLabel === undefined ? {} : { transitToLabel: resolved.transitToLabel }),
    ...(resolved.arrivesInSeconds === undefined ? {} : { arrivesInSeconds: resolved.arrivesInSeconds }),
    coPresent,
    heldItems: input.heldItems,
  };
}

export interface BuildSoloVignetteInput {
  primaryActorId: string;
  primaryName: string;
  loci: readonly PhysicalLocus[];
  journeys: readonly Journey[];
  activities: readonly ActivityInstance[];
  commitments: readonly Commitment[];
  zoneLabelOf: (zoneId: string) => string;
  atStorySecond: number;
}

/** Block (b): the primary living their routine elsewhere — with the engine's routine MUSTs. */
export function buildSoloVignette(input: BuildSoloVignetteInput): SoloVignette {
  const primaryLocus = input.loci.find((locus) => locus.actorId === input.primaryActorId);
  const resolved = resolveLocus(primaryLocus, input.journeys, input.zoneLabelOf, input.atStorySecond);
  const activity = liveActivityFor(input.primaryActorId, input.activities);

  const routineMusts: string[] = [];
  if (resolved.inTransit) {
    routineMusts.push(
      resolved.transitToLabel
        ? `${input.primaryName} is on the way to the ${resolved.transitToLabel} and cannot be anywhere else.`
        : `${input.primaryName} is travelling between places right now.`,
    );
  } else {
    routineMusts.push(`${input.primaryName} is ${placeAtPhrase(resolved.zoneLabel)} and stays there this turn.`);
  }
  if (activity) routineMusts.push(`${input.primaryName} is ${activity}.`);

  for (const commitment of input.commitments) {
    if (commitment.actorId !== input.primaryActorId) continue;
    if (!OPEN_COMMITMENT_STATUSES.has(commitment.status)) continue;
    const delta = commitment.window.latestArrival - input.atStorySecond;
    if (commitment.destinationZoneId) {
      routineMusts.push(
        `${input.primaryName} is due ${placeAtPhrase(input.zoneLabelOf(commitment.destinationZoneId))} ${deadlinePhrase(delta)} (a ${commitment.kind}).`,
      );
    } else {
      routineMusts.push(`${input.primaryName} has a ${commitment.kind} to keep ${deadlinePhrase(delta)}.`);
    }
  }

  return {
    primaryName: input.primaryName,
    zoneLabel: resolved.zoneLabel,
    inTransit: resolved.inTransit,
    ...(resolved.transitToLabel === undefined ? {} : { transitToLabel: resolved.transitToLabel }),
    ...(activity ? { activity } : {}),
    routineMusts,
  };
}

/**
 * The deterministic minimal narration a solo turn degrades to when the model
 * render fails entirely (docs/resilience.md, §18.5 "render a deterministic
 * minimal transition"). Always non-empty, always id-free, always dual-block so
 * the fallback keeps the ruling-21 shape.
 */
export function buildSoloFallbackProse(context: SoloCutContext): string {
  const { playerSide, primaryName } = context;
  const blockA = playerSide.inTransit
    ? `You are still on your way${playerSide.transitToLabel ? ` to the ${playerSide.transitToLabel}` : ""}, the world going by around you.`
    : `You take a moment ${placeAtPhrase(playerSide.zoneLabel)} and look around.` +
      (playerSide.coPresent.length > 0
        ? ` ${joinNames(playerSide.coPresent.map((actor) => actor.name))} ${playerSide.coPresent.length === 1 ? "is" : "are"} nearby.`
        : " It is quiet.") +
      (playerSide.heldItems.length > 0 ? ` You still have ${joinNames(playerSide.heldItems)} with you.` : "");

  const vignette = context.vignette;
  const blockB = vignette
    ? `Elsewhere, ${primaryName} ${
        vignette.inTransit
          ? `is on the move${vignette.transitToLabel ? ` toward the ${vignette.transitToLabel}` : ""}`
          : `goes about the day ${placeAtPhrase(vignette.zoneLabel)}`
      }${vignette.activity ? `, ${vignette.activity}` : ""}.`
    : `Elsewhere, ${primaryName} is somewhere in the middle of their own day.`;

  return `${blockA}\n\n${blockB}`;
}

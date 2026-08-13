import type { SimulationBranchEvent } from "../contracts/branching";
import {
  cohortAdjustedEventSchema,
  cohortCreatedEventSchema,
  cohortsProjectionSchema,
  simulationCohortSchema,
  type AdjustCohortCommand,
  type AdjustCohortRejectionCode,
  type CohortAdjustedEvent,
  type CohortCreatedEvent,
  type CohortPresenceWindow,
  type CohortsProjection,
  type CreateCohortCommand,
  type CreateCohortRejectionCode,
  type SimulationCohort,
} from "../contracts/cohorts";
import { composeSimulationId } from "../contracts/identity";

/**
 * E6.3 — the pure cohort kernel (engine.spec §27.1, §27.6): creation and
 * conserved adjustment resolvers, the analytic presence read (zero rows,
 * zero triggers — population at a zone is a pure function of authored
 * windows and the clock), and the replay fold. No IO, no clock, no model.
 */

export const cohortDerivationVersionForEvents = "cohort-v1" as const;

// ---------------------------------------------------------------------------
// Analytic presence (§27.6) — read-time only, never scheduled
// ---------------------------------------------------------------------------

/** Half-open [start, end) minute-of-day membership, wrapping midnight. */
function minuteInsidePresenceWindow(minuteOfDay: number, window: CohortPresenceWindow): boolean {
  if (window.startMinuteOfDay <= window.endMinuteOfDay) {
    return minuteOfDay >= window.startMinuteOfDay && minuteOfDay < window.endMinuteOfDay;
  }
  return minuteOfDay >= window.startMinuteOfDay || minuteOfDay < window.endMinuteOfDay;
}

/**
 * The window covering this second, or undefined (the cohort is dispersed).
 * Overlaps resolve deterministically to the earliest (start, end, zone)
 * triple — the meal-window precedent.
 */
export function cohortWindowCovering(
  windows: readonly CohortPresenceWindow[],
  atStorySecond: number,
): CohortPresenceWindow | undefined {
  const minuteOfDay = Math.floor(atStorySecond / 60) % 1_440;
  return [...windows]
    .sort(
      (left, right) =>
        left.startMinuteOfDay - right.startMinuteOfDay ||
        left.endMinuteOfDay - right.endMinuteOfDay ||
        (left.zoneId < right.zoneId ? -1 : left.zoneId > right.zoneId ? 1 : 0),
    )
    .find((window) => minuteInsidePresenceWindow(minuteOfDay, window));
}

export interface CohortPresence {
  zoneId: string;
  /** floor(population × share / 10 000) — an integer count, never a fraction. */
  presentCount: number;
}

/**
 * Where (and how much of) the cohort is present right now — a pure read.
 * Undefined means dispersed; a zero count at a zone is a real read ("the
 * square is empty tonight"), not an absence.
 */
export function cohortPresenceAt(
  cohort: SimulationCohort,
  atStorySecond: number,
): CohortPresence | undefined {
  const covering = cohortWindowCovering(cohort.presenceWindows, atStorySecond);
  if (!covering) return undefined;
  return {
    zoneId: covering.zoneId,
    presentCount: Math.floor((cohort.population * covering.shareFixedPoint) / 10_000),
  };
}

/**
 * E6.4 (§27.2 step 5, §27.7): whether the aggregate's own presence read admits
 * a person at `zoneId` right now — the no-contradiction law made deterministic.
 * Inside a covering window, only the windowed zone's `presentCount` and the
 * dispersed remainder are drawable; a zone the read declares empty cannot
 * yield a person. Dispersed cohorts admit materialization anywhere.
 */
export function cohortCanMaterializeAt(
  cohort: SimulationCohort,
  zoneId: string,
  atStorySecond: number,
): boolean {
  if (cohort.population < 1) return false;
  const presence = cohortPresenceAt(cohort, atStorySecond);
  if (!presence) return true;
  if (presence.zoneId === zoneId) return presence.presentCount >= 1;
  return cohort.population - presence.presentCount >= 1;
}

/** The total aggregate headcount present at one zone across every cohort. */
export function zonePresenceAt(
  cohorts: readonly SimulationCohort[],
  zoneId: string,
  atStorySecond: number,
): number {
  let total = 0;
  for (const cohort of cohorts) {
    const presence = cohortPresenceAt(cohort, atStorySecond);
    if (presence && presence.zoneId === zoneId) total += presence.presentCount;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Shared resolver plumbing (mirrors lod.ts)
// ---------------------------------------------------------------------------

interface CohortRejection<TCode extends string> {
  ok: false;
  code: TCode;
  publicReason: string;
}

function rejection<TCode extends string>(code: TCode, publicReason: string): CohortRejection<TCode> {
  return { ok: false, code, publicReason };
}

function isPrivilegedPrincipal(kind: string): boolean {
  return kind === "storyteller" || kind === "system";
}

export interface CohortBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

// ---------------------------------------------------------------------------
// create_cohort resolution
// ---------------------------------------------------------------------------

export interface CreateCohortResolutionView extends CohortBranchMeta {
  alreadyExists: boolean;
  /** Fail-closed §13.1 integrity: every presence-window zone must exist. */
  zoneExists(zoneId: string): boolean;
}

export type CreateCohortResolution =
  | CohortRejection<Extract<CreateCohortRejectionCode, "branch_mismatch" | "unauthorized_principal" | "cohort_already_exists" | "zone_not_found">>
  | { ok: true; cohort: SimulationCohort; event: CohortCreatedEvent };

export function resolveCreateCohortFromView(
  view: CreateCohortResolutionView,
  command: CreateCohortCommand,
): CreateCohortResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller peoples the background.");
  }
  if (view.alreadyExists) return rejection("cohort_already_exists", "That cohort already exists.");
  for (const window of command.payload.cohort.presenceWindows) {
    if (!view.zoneExists(window.zoneId)) {
      return rejection("zone_not_found", "That cohort gathers somewhere that does not exist.");
    }
  }

  const cohort = simulationCohortSchema.parse(command.payload.cohort);
  const event: CohortCreatedEvent = cohortCreatedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "cohort-created"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: cohortDerivationVersionForEvents,
    commandId: command.id,
    correlationId: command.correlationId,
    recordedAtWallClock: command.submittedAtWallClock,
    type: "cohort_created",
    actorIds: [],
    entityIds: [cohort.id],
    payload: { cohort },
  });
  return { ok: true, cohort, event };
}

// ---------------------------------------------------------------------------
// adjust_cohort resolution — conservation is a hard precondition
// ---------------------------------------------------------------------------

export interface AdjustCohortResolutionView extends CohortBranchMeta {
  current: SimulationCohort | undefined;
}

export type AdjustCohortResolution =
  | CohortRejection<Extract<AdjustCohortRejectionCode, "branch_mismatch" | "unauthorized_principal" | "cohort_not_found" | "insufficient_population">>
  | { ok: true; cohort: SimulationCohort; event: CohortAdjustedEvent };

export function resolveAdjustCohortFromView(
  view: AdjustCohortResolutionView,
  command: AdjustCohortCommand,
): AdjustCohortResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller peoples the background.");
  }
  const current = view.current;
  if (!current) return rejection("cohort_not_found", "That cohort is unavailable.");
  const populationAfter = current.population + command.payload.deltaCount;
  if (populationAfter < 0) {
    return rejection("insufficient_population", "There are not that many people to lose.");
  }

  const cohort = simulationCohortSchema.parse({ ...current, population: populationAfter });
  const event: CohortAdjustedEvent = cohortAdjustedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "cohort-adjusted"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: cohortDerivationVersionForEvents,
    commandId: command.id,
    correlationId: command.correlationId,
    recordedAtWallClock: command.submittedAtWallClock,
    type: "cohort_adjusted",
    actorIds: [],
    entityIds: [current.id],
    payload: {
      cohortId: current.id,
      deltaCount: command.payload.deltaCount,
      reason: command.payload.reason,
      populationBefore: current.population,
      populationAfter,
    },
  });
  return { ok: true, cohort, event };
}

// ---------------------------------------------------------------------------
// Replay fold (mirrors `applyActorLodEvent` / `replayActorLodHistory`)
// ---------------------------------------------------------------------------

function sortCohortsProjection(projection: CohortsProjection): CohortsProjection {
  return {
    ...projection,
    cohorts: [...projection.cohorts].sort((left, right) => (left.id < right.id ? -1 : 1)),
  };
}

export function applyCohortEvent(
  projection: CohortsProjection,
  event: SimulationBranchEvent,
): CohortsProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  if (event.type === "cohort_created") {
    return sortCohortsProjection({ ...bumped, cohorts: [...projection.cohorts, event.payload.cohort] });
  }
  if (event.type === "cohort_adjusted") {
    const cohorts = projection.cohorts.map((cohort) =>
      cohort.id === event.payload.cohortId
        ? simulationCohortSchema.parse({ ...cohort, population: event.payload.populationAfter })
        : cohort,
    );
    return sortCohortsProjection({ ...bumped, cohorts });
  }
  // Every other family advances the boundary without touching cohorts.
  return bumped;
}

export interface CohortsReplayInput {
  /** Cohort state is fully evented past its origin (empty) seed. */
  seed: CohortsProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its cohorts projection. */
export function replayCohortHistory(input: CohortsReplayInput): CohortsProjection {
  const seed = sortCohortsProjection(cohortsProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Cohort replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyCohortEvent(projection, event);
    lastSequence = event.sequence;
  }
  return cohortsProjectionSchema.parse({ ...projection, version: seed.version + commandIds.size });
}

/** The empty branch-origin seed — cohorts are never branch-seeded. */
export function emptyCohortsSeed(branchId: string, originStorySecond: number): CohortsProjection {
  return cohortsProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    cohorts: [],
  });
}

import {
  actorLodAssignedEventSchema,
  actorLodDefaultsByVersion,
  actorLodDerivationVersion,
  actorLodReadSchema,
  actorLodRegistryVersion,
  actorLodsProjectionSchema,
  actorLodStateSchema,
  composeSimulationId,
  isSimulationLodDemotion,
  type ActorLodAssignedEvent,
  type ActorLodRead,
  type ActorLodRegistryVersion,
  type ActorLodsProjection,
  type ActorLodState,
  type AssignActorLodCommand,
  type AssignActorLodRejectionCode,
  type SimulationBranchEvent,
} from "@/contracts/simulation";

/**
 * E6.1 — the pure actor-LOD kernel (engine.spec §27–§28): the effective read
 * (assigned row or registry defaults), the assignment resolver with the §27.3
 * demotion guards, and the replay fold. No IO, no clock, no model.
 */

// ---------------------------------------------------------------------------
// Effective read
// ---------------------------------------------------------------------------

/** An unassigned actor reads the registry defaults — the table stays sparse. */
export function effectiveActorLod(
  current: ActorLodState | undefined,
  registryVersion: ActorLodRegistryVersion = actorLodRegistryVersion,
): ActorLodRead {
  if (current) {
    return actorLodReadSchema.parse({
      simulationLod: current.simulationLod,
      inferenceLod: current.inferenceLod,
      source: "assigned",
      registryVersion: current.registryVersion,
    });
  }
  const defaults = actorLodDefaultsByVersion[registryVersion];
  return actorLodReadSchema.parse({
    simulationLod: defaults.simulationLod,
    inferenceLod: defaults.inferenceLod,
    source: "default",
    registryVersion,
  });
}

// ---------------------------------------------------------------------------
// assign_actor_lod resolution (FromView style — mirrors households.ts)
// ---------------------------------------------------------------------------

interface ActorLodRejection {
  ok: false;
  code: Extract<
    AssignActorLodRejectionCode,
    | "branch_mismatch"
    | "unauthorized_principal"
    | "actor_not_found"
    | "no_op"
    | "demotion_blocked_active_claims"
    | "demotion_blocked_open_pressure"
    | "demotion_blocked_open_engagement"
  >;
  publicReason: string;
}

function rejection(code: ActorLodRejection["code"], publicReason: string): ActorLodRejection {
  return { ok: false, code, publicReason };
}

function isPrivilegedPrincipal(kind: string): boolean {
  return kind === "storyteller" || kind === "system";
}

/**
 * The §27.3 demotion-guard view, loaded by the store inside the command
 * transaction. Counts, not booleans, so a rejection's public reason can stay
 * truthful without re-querying.
 */
export interface AssignActorLodGuardCounts {
  /** The actor's activity instances in a claim-holding phase (§16.3). */
  claimHoldingActivityCount: number;
  /** The actor's unresolved temporal pressures (§15.2) — commitments near a boundary. */
  openPressureCount: number;
  /** Claim-holding engagements (§18.2) the actor participates in. */
  openEngagementCount: number;
}

export interface AssignActorLodResolutionView {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
  actorExists: boolean;
  current: ActorLodState | undefined;
  guards: AssignActorLodGuardCounts;
}

export type AssignActorLodResolution =
  | ActorLodRejection
  | { ok: true; event: ActorLodAssignedEvent; state: ActorLodState };

/**
 * Guards run in fixed order (claims → pressure → engagement) and only when the
 * simulation axis moves toward less resolution. The inference axis never
 * guards, and neither does a simulation promotion — for a named actor whose
 * full state already exists, raising resolution is bookkeeping (real
 * aggregate promotion is E6.4, §27.2).
 */
export function resolveAssignActorLodFromView(
  view: AssignActorLodResolutionView,
  command: AssignActorLodCommand,
): AssignActorLodResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can set detail levels.");
  }
  if (!view.actorExists) return rejection("actor_not_found", "That actor is unavailable.");

  const effective = effectiveActorLod(view.current);
  if (
    effective.simulationLod === command.payload.simulationLod &&
    effective.inferenceLod === command.payload.inferenceLod
  ) {
    return rejection("no_op", "That actor already has those detail levels.");
  }
  if (isSimulationLodDemotion(effective.simulationLod, command.payload.simulationLod)) {
    if (view.guards.claimHoldingActivityCount > 0) {
      return rejection("demotion_blocked_active_claims", "That actor is in the middle of something.");
    }
    if (view.guards.openPressureCount > 0) {
      return rejection("demotion_blocked_open_pressure", "That actor has an obligation coming due.");
    }
    if (view.guards.openEngagementCount > 0) {
      return rejection("demotion_blocked_open_engagement", "That actor is in a live scene.");
    }
  }

  const state = actorLodStateSchema.parse({
    actorId: command.payload.actorId,
    simulationLod: command.payload.simulationLod,
    inferenceLod: command.payload.inferenceLod,
    registryVersion: effective.registryVersion,
    assignedAtStorySecond: view.storySecond,
  });
  const event = actorLodAssignedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "actor-lod-assigned"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: actorLodDerivationVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    recordedAtWallClock: command.submittedAtWallClock,
    type: "actor_lod_assigned",
    actorIds: [command.payload.actorId],
    entityIds: [command.payload.actorId],
    payload: {
      actorId: command.payload.actorId,
      simulationLod: command.payload.simulationLod,
      inferenceLod: command.payload.inferenceLod,
      previousSimulationLod: effective.simulationLod,
      previousInferenceLod: effective.inferenceLod,
      previousWasDefault: effective.source === "default",
      registryVersion: effective.registryVersion,
    },
  });
  return { ok: true, event, state };
}

// ---------------------------------------------------------------------------
// Replay fold (mirrors `applyHouseholdEvent` / `replayHouseholdsHistory`)
// ---------------------------------------------------------------------------

function sortActorLodsProjection(projection: ActorLodsProjection): ActorLodsProjection {
  return {
    ...projection,
    lods: [...projection.lods].sort((left, right) => (left.actorId < right.actorId ? -1 : 1)),
  };
}

export function applyActorLodEvent(
  projection: ActorLodsProjection,
  event: SimulationBranchEvent,
): ActorLodsProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  // Every non-LOD family advances the boundary without touching this projection.
  if (event.type !== "actor_lod_assigned") return bumped;
  const state = actorLodStateSchema.parse({
    actorId: event.payload.actorId,
    simulationLod: event.payload.simulationLod,
    inferenceLod: event.payload.inferenceLod,
    registryVersion: event.payload.registryVersion,
    assignedAtStorySecond: event.storySecond,
  });
  const existingIndex = projection.lods.findIndex((candidate) => candidate.actorId === state.actorId);
  const lods =
    existingIndex === -1
      ? [...projection.lods, state]
      : projection.lods.map((candidate, index) => (index === existingIndex ? state : candidate));
  return sortActorLodsProjection({ ...bumped, lods });
}

export interface ActorLodsReplayInput {
  /** The LOD ledger is fully evented past its origin (empty) seed. */
  seed: ActorLodsProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its actor-LOD projection. */
export function replayActorLodHistory(input: ActorLodsReplayInput): ActorLodsProjection {
  const seed = sortActorLodsProjection(actorLodsProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Actor-LOD replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyActorLodEvent(projection, event);
    lastSequence = event.sequence;
  }
  return actorLodsProjectionSchema.parse({ ...projection, version: seed.version + commandIds.size });
}

/** The empty branch-origin seed — nothing in this domain is ever branch-seeded. */
export function emptyActorLodsSeed(branchId: string, originStorySecond: number): ActorLodsProjection {
  return actorLodsProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    lods: [],
  });
}

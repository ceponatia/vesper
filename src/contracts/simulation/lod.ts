import { z } from "zod";
import { inferenceLodSchema } from "./deliberation";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
} from "./envelopes";
import { commandIdSchema, storySecondSchema, worldCharacterIdSchema } from "./identity";

/**
 * E6.1 — the per-actor dual-LOD ledger (engine.spec §27–§28). Simulation LOD
 * (how much deterministic work the engine performs for an actor) and inference
 * LOD (how much model attention an actor may receive) are independent axes on
 * one branch-scoped, fully-evented row per actor. LOD is a performance choice,
 * not permission to violate invariants (§27.1) — an unassigned actor reads the
 * versioned registry defaults, which reproduce pre-Gate-6 behavior exactly.
 */

export const actorLodDerivationVersion = "actor-lod-v1" as const;

// ---------------------------------------------------------------------------
// Simulation LOD vocabulary (§27.1) — closed, ordered, versioned
// ---------------------------------------------------------------------------

export const simulationLods = ["exact", "event", "aggregate", "dormant"] as const;
export const simulationLodSchema = z.enum(simulationLods);
export type SimulationLod = z.infer<typeof simulationLodSchema>;

/** Resolution rank, most detail first — `simulationLods` index order IS the ranking. */
export function compareSimulationLods(a: SimulationLod, b: SimulationLod): number {
  return simulationLods.indexOf(a) - simulationLods.indexOf(b);
}

/** A demotion moves toward less resolution (§27.3) and must pass the guards. */
export function isSimulationLodDemotion(from: SimulationLod, to: SimulationLod): boolean {
  return compareSimulationLods(to, from) > 0;
}

// ---------------------------------------------------------------------------
// Registry defaults — world-type versioned values (ruling 14/15 precedent)
// ---------------------------------------------------------------------------

export const actorLodRegistryVersion = "actor-lod-v1" as const;
export const actorLodRegistryVersions = [actorLodRegistryVersion] as const;
export const actorLodRegistryVersionSchema = z.enum(actorLodRegistryVersions);
export type ActorLodRegistryVersion = z.infer<typeof actorLodRegistryVersionSchema>;

export const actorLodDefaultsSchema = z
  .object({
    simulationLod: simulationLodSchema,
    inferenceLod: inferenceLodSchema,
  })
  .strict();
export type ActorLodDefaults = z.infer<typeof actorLodDefaultsSchema>;

/**
 * v1 defaults: every named actor simulates exact and may reach the
 * deliberator — exactly what both pre-Gate-6 §19.3 call sites hardcoded, so
 * shipping the ledger changes no outcome until someone assigns a row. Tuning
 * these is a data edit under a bumped registry version, never a migration.
 */
export const actorLodDefaultsV1: ActorLodDefaults = actorLodDefaultsSchema.parse({
  simulationLod: "exact",
  inferenceLod: "deliberator",
});
export const actorLodDefaultsByVersion: Record<ActorLodRegistryVersion, ActorLodDefaults> = {
  [actorLodRegistryVersion]: actorLodDefaultsV1,
};

// ---------------------------------------------------------------------------
// Ledger state + effective read
// ---------------------------------------------------------------------------

export const actorLodStateSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    simulationLod: simulationLodSchema,
    inferenceLod: inferenceLodSchema,
    registryVersion: actorLodRegistryVersionSchema,
    assignedAtStorySecond: storySecondSchema,
  })
  .strict();
export type ActorLodState = z.infer<typeof actorLodStateSchema>;

/** The effective read: an assigned row, or the pure registry defaults. */
export const actorLodReadSchema = z
  .object({
    simulationLod: simulationLodSchema,
    inferenceLod: inferenceLodSchema,
    source: z.enum(["assigned", "default"]),
    registryVersion: actorLodRegistryVersionSchema,
  })
  .strict();
export type ActorLodRead = z.infer<typeof actorLodReadSchema>;

// ---------------------------------------------------------------------------
// Projection (mirrors `householdsProjectionSchema`)
// ---------------------------------------------------------------------------

export const actorLodsProjectionSchema = z
  .object({
    branchId: z.string().min(1),
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storySecond: storySecondSchema,
    lods: z.array(actorLodStateSchema),
  })
  .strict();
export type ActorLodsProjection = z.infer<typeof actorLodsProjectionSchema>;

// ---------------------------------------------------------------------------
// assign_actor_lod — privileged dial (storyteller/system), audited via event
// ---------------------------------------------------------------------------

const assignActorLodPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    simulationLod: simulationLodSchema,
    inferenceLod: inferenceLodSchema,
  })
  .strict();

export const assignActorLodCommandSchema = createCommandEnvelopeSchema(
  "assign_actor_lod",
  1,
  assignActorLodPayloadSchema,
);

/**
 * The §27.3 demotion guards, checked in this fixed order — the first blocker
 * names the rejection. Inference-axis changes never guard (a model-budget
 * dial), and a simulation-axis promotion never guards either: for a named
 * actor whose full state already exists, raising resolution is bookkeeping —
 * real promotion-with-sampling from an aggregate is E6.4 (§27.2).
 */
export const assignActorLodRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "actor_not_found",
  "no_op",
  "demotion_blocked_active_claims",
  "demotion_blocked_open_pressure",
  "demotion_blocked_open_engagement",
] as const;
export const assignActorLodRejectionCodeSchema = z.enum(assignActorLodRejectionCodes);
export const assignActorLodCommandResultSchema = createCommandResultSchema(
  assignActorLodRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// actor_lod_assigned — the one E6.1 event; LOD state is fully evented
// ---------------------------------------------------------------------------

const actorLodAssignedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    simulationLod: simulationLodSchema,
    inferenceLod: inferenceLodSchema,
    /** The effective values this assignment replaced — audit, no reads needed. */
    previousSimulationLod: simulationLodSchema,
    previousInferenceLod: inferenceLodSchema,
    /** True when the previous values were the registry defaults (no prior row). */
    previousWasDefault: z.boolean(),
    registryVersion: actorLodRegistryVersionSchema,
  })
  .strict();

export const actorLodAssignedEventSchema = createEventEnvelopeSchema(
  "actor_lod_assigned",
  1,
  actorLodAssignedPayloadSchema,
).extend({ commandId: commandIdSchema });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssignActorLodCommand = z.infer<typeof assignActorLodCommandSchema>;
export type AssignActorLodCommandInput = z.input<typeof assignActorLodCommandSchema>;
export type AssignActorLodRejectionCode = z.infer<typeof assignActorLodRejectionCodeSchema>;
export type AssignActorLodCommandResult = z.infer<typeof assignActorLodCommandResultSchema>;
export type ActorLodAssignedEvent = z.infer<typeof actorLodAssignedEventSchema>;

import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { CreateCommitmentCommandInput } from "@vesper/simulation-core/contracts/commitments";
import type { MaterialBranchSeedInput } from "@vesper/simulation-core/contracts/materials";
import type { authoredLoreSeedSchema } from "@vesper/simulation-core/contracts/memory";
import type { SimCalendarStart } from "@/lib/simulation/clock";
import { sortedUnique } from "@vesper/simulation-core/hash";
import {
  db,
  simActionDefinitions,
  simBodyRhythms,
  simBranches,
  simWorlds,
  simZones,
  type Db,
} from "@/server/db";
import { seedDurableActionDefinitions, type ActionDefinitionSeed } from "./activity-store";
import {
  seedDurableBodyRhythms,
  submitDurableInitializeActorBody,
  type BodyRhythmSeed,
} from "./body-store";
import { submitDurableCreateCommitment } from "./commitment-store";
import { submitDurableAssignActorLod } from "./lod-store";
import { seedDurableMaterialBranch } from "./material-store";
import { seedAuthoredLoreDocuments } from "./memory-index-store";
import { seedDurableSpaceTopology, type SpaceTopologySeed } from "./space-store";

/**
 * The successor front door (engine.rollout.plan.md, owner ask 2026-07-22) —
 * one small FRESH world per successor chat, provisioned through the same
 * durable seeders the rollout world and the admin provisioning route use.
 * Isolation is the point: every chat gets its own branch, cast, and clock, so
 * no two chats ever contend for one standing scene (the R3 live-session
 * lesson).
 *
 * SEED CONTENTS (starter-world-seeds.plan.md / B8 — the engine machinery was
 * built but unseeded, so a new world collapsed to "she is at home and stays
 * there"). A fresh world now opens on: a home, a town square a five-minute
 * walk away, and a market two hundred and forty seconds past the square; the
 * player and the chat's character at home, one background neighbor at the
 * square (so witnessed arrivals exist); a keepsake in the player's pocket (so
 * item transfer exists) and a covered breakfast bowl in the primary's hands
 * (so `eat_meal` has something eligible inside her authored noon window); two
 * zone-gated actions; two commitments on the primary — a firm early-afternoon
 * obligation at the market and a soft evening promise to the neighbor at the
 * square — so the vignette carries real MUSTs and `decideDepartures` has
 * departures to decide; and a handful of authored-lore memory documents, so a
 * turn-1 recall returns something instead of silence.
 *
 * RE-RUNNABLE since successor-world-lifecycle.plan.md slice 3: the caller
 * supplies a `stamp` derived from its idempotency key
 * (`deriveProvisioningStamp`) instead of this module minting `newId()`, so
 * every id below is stable across retries — and each seed stage is skipped when
 * its rows are already present. Calling this twice with the same stamp
 * COMPLETES a half-built world rather than raising a duplicate key or building
 * a second one; calling it on a finished world is a handful of cheap existence
 * probes that return the same identities.
 *
 * Stage-level guards (rather than per-row upserts inside the shared seeders)
 * are correct because every seeder is internally transactional: a stage's rows
 * are all present or all absent, never half. The command stages need no guard
 * at all — their envelopes carry stamp-derived idempotency keys, so the command
 * runner replays the recorded `accepted` result — and neither does the lore
 * stage, which upserts on `(branchId, docId)`.
 */

export const STARTER_WORLD_TYPE_ID = "starter-world-v1";
export const STARTER_RULESET_VERSION = "starter-rules-v1";
/** Day 1 · 8:00am — mornings read naturally for a first scene. */
export const STARTER_ORIGIN_STORY_SECOND = 8 * 3_600;
/** R5 calendar (ruling 17): fresh worlds open Monday, June 1, 2026 — editable per world. */
export const STARTER_CALENDAR_START: SimCalendarStart = { year: 2026, month: 6, day: 1 };
export const STARTER_REST_ACTION_SUFFIX = "action-rest";
/** B8: the market-gated second action, so activity choice is not a single chip. */
export const STARTER_BROWSE_ACTION_SUFFIX = "action-browse";

/** B8: day 1 · 2:00pm — the firm market obligation's latest arrival. */
export const STARTER_MARKET_COMMITMENT_ARRIVAL_SECOND = 14 * 3_600;
/** B8: day 1 · 7:30pm — the soft evening promise's latest arrival. */
export const STARTER_EVENING_COMMITMENT_ARRIVAL_SECOND = 19 * 3_600 + 1_800;

export interface StarterWorldResult {
  worldId: string;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  neighborActorId: string;
  keepsakeItemId: string;
}

export interface StarterWorldSeedInput {
  /** Key-derived world identity — the same stamp must produce the same world. */
  stamp: string;
  playerName: string;
  primaryName: string;
  /**
   * R5 slice 5: the primary's authored outfit, ported into world truth as
   * WORN items at birth — the outfit chip then reads the sim, not legacy
   * chat state. Slot keys are made unique by the caller's ordering.
   */
  primaryGarments?: readonly { name: string; slotKey: string }[];
}

/** One seeded obligation: the envelope name is folded into its stamp-derived keys. */
export interface StarterCommitmentSeed {
  name: string;
  payload: CreateCommitmentCommandInput["payload"];
}

/**
 * The §24.2 lore seed in its PRE-BRAND shape — `AuthoredLoreSeed` (the parsed
 * type) carries branded actor ids, and seed data is plain strings until a
 * seeder parses it, exactly like every other `*Seed` type in this file.
 */
export type StarterLoreSeed = z.input<typeof authoredLoreSeedSchema>;

/**
 * Everything a starter world is made of, as PURE DATA (B8). Splitting the
 * authored content out of `provisionStarterWorld` keeps the seed reviewable
 * and testable without a database: the pure suite parses these payloads
 * through the same contracts the durable seeders parse, and runs the §19.1
 * routine kernel over the seeded meal facts to prove `eat_meal` is legal in
 * the seeded window. No IO, no clock, no randomness — the same stamp and
 * names always produce the same world.
 */
export interface StarterWorldSeedPlan {
  worldId: string;
  branchId: string;
  /** The normalized display names (a player whose name collides becomes "Traveler"). */
  playerName: string;
  primaryName: string;
  locationId: string;
  actors: { player: string; primary: string; neighbor: string };
  zones: { home: string; square: string; market: string };
  keepsakeItemId: string;
  mealItemId: string;
  material: MaterialBranchSeedInput;
  topology: SpaceTopologySeed;
  rhythms: BodyRhythmSeed;
  actions: ActionDefinitionSeed;
  commitments: readonly StarterCommitmentSeed[];
  lore: readonly StarterLoreSeed[];
}

/**
 * Build one starter world's seed data. Names label prose — they must differ.
 */
export function starterWorldSeedPlan(input: StarterWorldSeedInput): StarterWorldSeedPlan {
  const { stamp } = input;
  const worldId = `stw-${stamp}`;
  const branchId = `stw-${stamp}-branch`;
  const primaryName = input.primaryName.trim() || "Companion";
  let playerName = input.playerName.trim() || "Traveler";
  if (playerName.toLowerCase() === primaryName.toLowerCase()) playerName = "Traveler";

  const actors = {
    player: `stw-${stamp}-player`,
    primary: `stw-${stamp}-primary`,
    neighbor: `stw-${stamp}-neighbor`,
  };
  const zones = {
    home: `stw-${stamp}-zone-home`,
    square: `stw-${stamp}-zone-square`,
    market: `stw-${stamp}-zone-market`,
  };
  const locationId = `stw-${stamp}-loc-town`;
  const keepsakeItemId = `stw-${stamp}-item-keepsake`;
  const mealItemId = `stw-${stamp}-item-meal`;

  const material: MaterialBranchSeedInput = {
    worldId,
    worldTypeId: STARTER_WORLD_TYPE_ID,
    worldSeed: `stw-seed-${stamp}`,
    branchId,
    rulesetVersion: STARTER_RULESET_VERSION,
    originStorySecond: STARTER_ORIGIN_STORY_SECOND,
    actors: [
      { id: actors.player, name: playerName },
      { id: actors.primary, name: primaryName },
      { id: actors.neighbor, name: "Sable" },
    ],
    items: [
      {
        id: keepsakeItemId,
        name: "a small keepsake",
        ownerActorId: null,
        locus: { kind: "held", actorId: actors.player },
      },
      {
        // B8: the world's one edible thing. `eat_meal` is a candidate at every
        // routine boundary but was ALWAYS illegal (`no_eligible_item`) because
        // nothing in a fresh world carried a `meal`-source consumption effect
        // — see `selectRoutineMealItem` (@/lib/simulation/routine), whose §26.5
        // filter needs an extant, unreserved, unowned-or-own item with such an
        // effect, rooted at the actor or in her zone.
        //
        // It is seeded HELD by the primary rather than resting in the home
        // zone: `seedDurableMaterialBranch` writes items before
        // `seedDurableSpaceTopology` creates the zones, so a `zone` locus has
        // no FK target at seed time (that seeder's own doc spells out the
        // three-step ordering a zone-resting seed item would need). Actor-
        // rooted is also the more robust choice — the §26.5 selection prefers
        // it, and it stays eligible if the noon window ever catches her out on
        // an errand or mid-journey.
        id: mealItemId,
        name: "a covered bowl of breakfast porridge",
        materialKindKey: "meal",
        ownerActorId: null,
        consumptionEffects: [
          { meterKey: "energy", sourceKind: "meal", operation: { kind: "add", deltaFixedPoint: 1_500 } },
        ],
        locus: { kind: "held", actorId: actors.primary },
      },
      ...(input.primaryGarments ?? []).map((garment, index) => ({
        id: `stw-${stamp}-garment-${index}`,
        name: garment.name.slice(0, 200),
        ownerActorId: actors.primary,
        locus: { kind: "worn" as const, actorId: actors.primary, slotKey: garment.slotKey },
      })),
    ],
  };

  const topology: SpaceTopologySeed = {
    branchId,
    locations: [{ id: locationId, worldId, kind: "town", defaultAccessPolicy: "public" }],
    zones: [
      { id: zones.home, locationId, kind: "home", privacyPolicy: "public" },
      { id: zones.square, locationId, kind: "plaza", privacyPolicy: "public" },
      // B8: a third zone, so movement is a choice rather than a single edge.
      { id: zones.market, locationId, kind: "market", privacyPolicy: "public" },
    ],
    links: [
      {
        id: `stw-${stamp}-link-home-square`,
        fromZoneId: zones.home,
        toZoneId: zones.square,
        modes: ["walk"],
        minimumDurationSeconds: 300,
        accessPolicy: "public",
        state: "open",
      },
      {
        // Deliberately NOT a second edge off home: the market hangs off the
        // square, so a route home → market is two hops and §15.2 derives a
        // real departure lead from it instead of a flat five minutes.
        id: `stw-${stamp}-link-square-market`,
        fromZoneId: zones.square,
        toZoneId: zones.market,
        modes: ["walk"],
        minimumDurationSeconds: 240,
        accessPolicy: "public",
        state: "open",
      },
    ],
    loci: [
      { kind: "at", actorId: actors.player, locationId, zoneId: zones.home, since: STARTER_ORIGIN_STORY_SECOND },
      { kind: "at", actorId: actors.primary, locationId, zoneId: zones.home, since: STARTER_ORIGIN_STORY_SECOND },
      { kind: "at", actorId: actors.neighbor, locationId, zoneId: zones.square, since: STARTER_ORIGIN_STORY_SECOND },
    ],
  };

  const rhythms: BodyRhythmSeed = {
    branchId,
    rows: [
      { actorId: actors.primary, kind: "sleep", startMinuteOfDay: 1_380, endMinuteOfDay: 420 },
      { actorId: actors.primary, kind: "meal", startMinuteOfDay: 720, endMinuteOfDay: 780 },
      { actorId: actors.neighbor, kind: "sleep", startMinuteOfDay: 1_380, endMinuteOfDay: 420 },
    ],
  };

  const actions: ActionDefinitionSeed = {
    branchId,
    definitions: [
      {
        id: `stw-${stamp}-${STARTER_REST_ACTION_SUFFIX}`,
        version: 1,
        label: "Rest",
        controllerKinds: ["player", "npc_policy"],
        duration: { kind: "fixed", seconds: 600 },
        preconditions: [{ kind: "at_zone_kind", zoneKind: "home" }],
        requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
        interruptibility: "pausable",
        noticeability: "obvious",
      },
      {
        // B8: a second action gated on a DIFFERENT zone kind and claiming only
        // attention (never the body), so the affordance row changes as you
        // move and the two actions are not interchangeable.
        id: `stw-${stamp}-${STARTER_BROWSE_ACTION_SUFFIX}`,
        version: 1,
        label: "Browse the stalls",
        controllerKinds: ["player", "npc_policy"],
        duration: { kind: "fixed", seconds: 900 },
        preconditions: [{ kind: "at_zone_kind", zoneKind: "market" }],
        requiredClaims: [{ kind: "attention", weight: "full" }],
        interruptibility: "free",
        noticeability: "obvious",
      },
    ],
  };

  // B8 commitments (§15.1–15.2). Both are AUTHORED knowledge — setup the actor
  // is deemed to know — and both name a destination away from home, so the
  // §15.2 derivation produces a real `latestDeparture` and the E3.4 arbiter has
  // something to depart for without any player authoring. The firm one's notice
  // lands at 13:06, safely after the 12:00–13:00 meal window closes, so the
  // day's two obligations never fight over the same boundary.
  const commitments: readonly StarterCommitmentSeed[] = [
    {
      name: "commitment-market",
      payload: {
        actorId: actors.primary,
        kind: "appointment",
        destinationZoneId: zones.market,
        window: {
          earliestArrival: 13 * 3_600 + 1_800,
          targetArrival: 13 * 3_600 + 2_400,
          latestArrival: STARTER_MARKET_COMMITMENT_ARRIVAL_SECOND,
        },
        expectedDurationSeconds: 5_400,
        priority: 60,
        flexibility: "firm",
        preparationSeconds: 600,
        reliabilityBufferSeconds: 300,
        noticeLeadSeconds: 1_800,
        knowledgeSource: { kind: "authored" },
      },
    },
    {
      name: "commitment-evening",
      payload: {
        actorId: actors.primary,
        kind: "promise",
        destinationZoneId: zones.square,
        promisedToActorId: actors.neighbor,
        window: {
          earliestArrival: 18 * 3_600,
          targetArrival: 19 * 3_600,
          latestArrival: STARTER_EVENING_COMMITMENT_ARRIVAL_SECOND,
        },
        expectedDurationSeconds: 3_600,
        priority: 20,
        flexibility: "soft",
        preparationSeconds: 300,
        reliabilityBufferSeconds: 0,
        noticeLeadSeconds: 3_600,
        knowledgeSource: { kind: "authored" },
      },
    },
  ];

  // B8 authored lore (§24.2): seeded documents, not events, so recall on the
  // very first turn returns backstory instead of nothing. Public entries are
  // eligible to everyone; the two `actors` entries name their viewpoints
  // explicitly (the schema refuses a public doc with eligible actors and an
  // actor-scoped doc without them).
  const lore: readonly StarterLoreSeed[] = [
    {
      loreId: `stw-${stamp}-lore-town`,
      text: `${primaryName}'s home sits a five-minute walk from the town square, and the market stalls are a few minutes further on past it. It is a small town: everyone's day passes through the square at least once.`,
      visibility: "public",
      eligibleActorIds: [],
      aboutEntityIds: sortedUnique([zones.home, zones.square, zones.market]),
      validFromSecond: 0,
    },
    {
      loreId: `stw-${stamp}-lore-keepsake`,
      text: `The small keepsake ${playerName} carries was a parting gift, pressed into their hand on the morning they left the last place they called home. It is worth nothing and they would not sell it.`,
      visibility: "actors",
      eligibleActorIds: sortedUnique([actors.player, actors.primary]),
      aboutEntityIds: sortedUnique([keepsakeItemId, actors.player, actors.primary]),
      validFromSecond: 0,
    },
    {
      loreId: `stw-${stamp}-lore-primary-past`,
      text: `${primaryName} grew up two streets from the square and took over the family's afternoon at the market when her mother could no longer stand a whole day at the stall. She has kept the hours ever since, and she is never late.`,
      visibility: "actors",
      eligibleActorIds: [actors.primary],
      aboutEntityIds: [actors.primary],
      validFromSecond: 0,
    },
    {
      loreId: `stw-${stamp}-lore-neighbor`,
      text: `Sable keeps the corner stall at the market and hears whatever the square is saying long before it reaches anyone's door. She and ${primaryName} have traded the evening's news for years.`,
      visibility: "public",
      eligibleActorIds: [],
      aboutEntityIds: sortedUnique([actors.neighbor, actors.primary, zones.market]),
      validFromSecond: 0,
    },
  ];

  return {
    worldId,
    branchId,
    playerName,
    primaryName,
    locationId,
    actors,
    zones,
    keepsakeItemId,
    mealItemId,
    material,
    topology,
    rhythms,
    actions,
    commitments,
    lore,
  };
}

/**
 * Has this seed stage already committed? Each shared seeder writes its rows in
 * ONE transaction, so a single present row proves the whole stage landed —
 * which is what makes a stage-level skip safe without touching the seeders
 * themselves (they are shared with the rollout world and the admin route).
 */
async function stageAlreadySeeded(rows: Promise<unknown[]>): Promise<boolean> {
  return (await rows).length > 0;
}

/**
 * Provision one starter world, or finish provisioning a half-built one.
 *
 * `stamp` is the world's DERIVED identity (see the module doc): the caller
 * passes `deriveProvisioningStamp(ownerId, requestId)` so a retry resumes.
 */
export async function provisionStarterWorld(
  input: StarterWorldSeedInput,
  database: Db = db(),
): Promise<StarterWorldResult> {
  const { stamp } = input;
  const plan = starterWorldSeedPlan(input);
  const { branchId, worldId, actors } = plan;

  // Stage 1 — world + branch + cast + items. The branch row is created by this
  // seeder's own transaction, so its presence is the stage's completion proof.
  const materialSeeded = await stageAlreadySeeded(
    database.select({ id: simBranches.id }).from(simBranches).where(eq(simBranches.id, branchId)).limit(1),
  );
  if (!materialSeeded) {
    await seedDurableMaterialBranch(plan.material, { database });
  }

  // Stage 2 — topology. `seedDurableSpaceTopology` refuses a branch whose head
  // has moved, and the command stages below are the only thing that moves it, so
  // a resume that still needs this stage always finds the branch at sequence 0.
  const spaceSeeded = await stageAlreadySeeded(
    database.select({ id: simZones.zoneId }).from(simZones).where(eq(simZones.branchId, branchId)).limit(1),
  );
  if (!spaceSeeded) {
    await seedDurableSpaceTopology(plan.topology, { database });
  }

  // Stage 3 — rhythms.
  const rhythmsSeeded = await stageAlreadySeeded(
    database
      .select({ id: simBodyRhythms.actorId })
      .from(simBodyRhythms)
      .where(eq(simBodyRhythms.branchId, branchId))
      .limit(1),
  );
  if (!rhythmsSeeded) {
    await seedDurableBodyRhythms(plan.rhythms, { database });
  }

  // Stage 4 — the action catalog.
  const actionsSeeded = await stageAlreadySeeded(
    database
      .select({ id: simActionDefinitions.actionDefinitionId })
      .from(simActionDefinitions)
      .where(eq(simActionDefinitions.branchId, branchId))
      .limit(1),
  );
  if (!actionsSeeded) {
    await seedDurableActionDefinitions(plan.actions, { database });
  }

  // Stage 5 — authored lore (B8). No existence guard: `seedAuthoredLoreDocuments`
  // upserts on `(branchId, docId)` and the lore ids are stamp-derived, so a
  // resume rewrites the same rows rather than duplicating or colliding.
  await seedAuthoredLoreDocuments({ branchId, seeds: plan.lore }, { database });

  // Stage 6 — the durable commands (bodies, the neighbor's LOD, the primary's
  // obligations). No existence guard needed: their
  // `idempotencyKey` is stamp-derived, so `runSimulationCommand` replays the
  // recorded `accepted` result for one already committed (which is exactly the
  // dedupe the old `newId()` stamp made unreachable).
  const admit = { database, admitAtLockedVersion: true };
  const envelope = (name: string, payload: Record<string, unknown>) => ({
    id: `stw-${stamp}-cmd-${name}`,
    branchId,
    expectedVersion: 0,
    idempotencyKey: `stw-${stamp}-${name}`,
    principal: { kind: "system" as const, principalId: "starter-world-seeder", controlledActorIds: [] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `stw-seed-${stamp}`,
    schemaVersion: 1,
    ...payload,
  });
  for (const [name, actorId] of [
    ["init-player", actors.player],
    ["init-primary", actors.primary],
    ["init-neighbor", actors.neighbor],
  ] as const) {
    const result = await submitDurableInitializeActorBody(
      envelope(name, { type: "initialize_actor_body", payload: { actorId, registryVersion: "body-v1", baselineOverrides: {} } }),
      admit,
    );
    if (result.status !== "accepted") {
      throw new Error(`starter world seed step "${name}" was not accepted: ${JSON.stringify(result)}`);
    }
  }
  const lod = await submitDurableAssignActorLod(
    envelope("lod-neighbor", {
      type: "assign_actor_lod",
      payload: { actorId: actors.neighbor, simulationLod: "event", inferenceLod: "no_model" },
    }),
    admit,
  );
  if (lod.status !== "accepted") {
    throw new Error(`starter world seed step "lod-neighbor" was not accepted: ${JSON.stringify(lod)}`);
  }
  // The primary's obligations. These run LAST of the command stages because
  // §15.2 derives each one's departure lead from the seeded route, so both the
  // topology and the cast must already exist.
  for (const commitment of plan.commitments) {
    const created = await submitDurableCreateCommitment(
      envelope(commitment.name, { type: "create_commitment", payload: commitment.payload }),
      admit,
    );
    if (created.status !== "accepted") {
      throw new Error(
        `starter world seed step "${commitment.name}" was not accepted: ${JSON.stringify(created)}`,
      );
    }
  }
  // The calendar anchor (R5 time domain): presentation config on the world
  // row, set after the causal seeding — it labels history, never writes it.
  // Naturally idempotent (an UPDATE to a constant), so a resume just re-writes it.
  await database.update(simWorlds).set({ calendarStart: STARTER_CALENDAR_START }).where(eq(simWorlds.id, worldId));

  return {
    worldId,
    branchId,
    playerActorId: actors.player,
    primaryActorId: actors.primary,
    neighborActorId: actors.neighbor,
    keepsakeItemId: plan.keepsakeItemId,
  };
}

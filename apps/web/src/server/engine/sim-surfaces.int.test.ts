import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { METER_FIXED_POINT_ONE } from "@vesper/simulation-core/contracts/bodies";
import { successorGarmentBlueprint, successorWornSlotKey } from "@/contracts";
import { newId } from "@/lib/ids";
import { characterChats, db, simBodyMeters, simBranches, users } from "@/server/db";
import {
  ROLLOUT_ACTORS,
  ROLLOUT_BRANCH_ID,
  readSimChatGarments,
  readSimChatMeters,
  readSimChatOutfit,
  readSimChatPresence,
  readSimChatWorld,
  seedRolloutTestWorld,
  SIM_GARMENT_MAPPING_UNRESOLVED,
  submitDurableApplyGarmentOperation,
} from "@/server/engine";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  npcPrincipal,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";

// `readSimChatMeters` must INTEGRATE each
// meter to the branch clock on read (via the shared `buildMeterView` seam),
// not echo the last stored write. Needs Postgres; self-skips without it. The
// degradation guards are proven db-free in sim-surfaces.degradation.test.ts.
//
// The probe/pool handling comes from `simulationSuiteHarness`. That is a
// behavioral FIX here: this file's hand-rolled probe had diverged to a plain
// self-skip with no strict/CI rethrow at all, so an unreachable database
// reported a silently green suite even under `pnpm test:int:strict`.
// `legacyPlayerMode: false` is the historical harness option name — the rollout
// seed runs on a system principal and nothing here submits that player fixture,
// so the opt-in flag stays irrelevant to this suite. The fixed rollout world is
// deliberately NOT tracked for teardown: this suite restores the shared clock
// instead of deleting the world, which lets the other rollout-world suites reuse it.

const harness = await simulationSuiteHarness({
  suite: "sim-surfaces.int.test",
  table: "character_chats",
  legacyPlayerMode: false,
});
const ready = harness.ready;

describe.runIf(ready)("readSimChatMeters integrates to the branch clock (slice 2)", () => {
  const ids = { user: "", chat: "" };
  let originalStorySecond = 0;

  beforeAll(async () => {
    await seedRolloutTestWorld();
    const [branch] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    if (!branch) throw new Error("rollout branch missing after seed");
    originalStorySecond = branch.storySecond;

    const [user] = await db()
      .insert(users)
      .values({ email: `sim-surfaces-${Date.now()}@test.local`, name: "Sim Surfaces Int" })
      .returning();
    if (!user) throw new Error("failed to create test user");
    ids.user = user.id;

    // A routed chat mapping the player to Mara and the primary to Ana — exactly
    // what `readSimChatMeters`'s authority guard needs, inserted directly (the
    // seam reads only the authority columns, not the audited flip path).
    const [chat] = await db()
      .insert(characterChats)
      .values({
        ownerId: user.id,
        engineAuthority: "successor_narrative_view",
        simBranchId: ROLLOUT_BRANCH_ID,
        simPlayerActorId: ROLLOUT_ACTORS.mara,
        simPrimaryActorId: ROLLOUT_ACTORS.ana,
      })
      .returning();
    if (!chat) throw new Error("failed to create routed chat");
    ids.chat = chat.id;
  });

  afterAll(async () => {
    if (!ready) return;
    // Restore the shared clock so a later int file reusing the rollout world
    // sees it as freshly seeded.
    await db()
      .update(simBranches)
      .set({ storySecond: originalStorySecond })
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    if (ids.chat) await db().delete(characterChats).where(eq(characterChats.id, ids.chat));
    if (ids.user) await db().delete(users).where(eq(users.id, ids.user));
  });

  it("reads a drifted meter at its INTEGRATED value, not its stored write", async () => {
    // Ana's hygiene is a linear-drain meter with no wash rhythm, so it drifts
    // purely (no self-care jumps) between writes — the cleanest drift to pin.
    const [row] = await db()
      .select({ value: simBodyMeters.valueFixedPoint, lastAt: simBodyMeters.lastIntegratedAt })
      .from(simBodyMeters)
      .where(
        and(
          eq(simBodyMeters.branchId, ROLLOUT_BRANCH_ID),
          eq(simBodyMeters.actorId, ROLLOUT_ACTORS.ana),
          eq(simBodyMeters.meterKey, "hygiene"),
        ),
      );
    if (!row) throw new Error("ana hygiene meter missing");
    const storedFixed = row.value;
    const writtenAt = row.lastAt;

    // Clock pinned to the write instant → integrate-on-read returns the stored
    // value unchanged (no happy-path regression; parity with the old read).
    await db().update(simBranches).set({ storySecond: writtenAt }).where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    const atWrite = await readSimChatMeters(ids.chat);
    expect(atWrite?.hygiene).toBeCloseTo(storedFixed / METER_FIXED_POINT_ONE, 6);

    // Advance the clock two story-hours with NO material write: the row is now
    // stale, so the OLD (stored) read would still echo `storedFixed`.
    // Integrate-on-read must instead drain hygiene by 150/h · 2h = 300 units.
    const driftedAt = writtenAt + 7_200;
    await db().update(simBranches).set({ storySecond: driftedAt }).where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    const now = await readSimChatMeters(ids.chat);
    const expectedFixed = Math.max(0, storedFixed - 300);
    expect(now?.hygiene).toBeCloseTo(expectedFixed / METER_FIXED_POINT_ONE, 6);
    expect(now?.hygiene).toBeLessThan(atWrite?.hygiene ?? 0);
  });

  it("keeps well-formed routed panels non-null through the slice-1 guard wrap", async () => {
    await db()
      .update(simBranches)
      .set({ storySecond: originalStorySecond })
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    // Presence and meters read for a healthy routed chat — the resilience wrap
    // must not turn a good read into a hidden panel.
    expect(await readSimChatPresence(ids.chat)).not.toBeNull();
    expect(await readSimChatMeters(ids.chat)).not.toBeNull();
    // Known-empty is an explicit world-truth phrase, not an empty string that
    // truthy transport can silently collapse into "wardrobe unavailable".
    expect(await readSimChatOutfit(ids.chat)).toBe("no clothing");
    // Cast rows carry stable actor identity for keyed UI rows and future
    // actor-targeted commands; the id is transport data, never display copy.
    const world = await readSimChatWorld(ids.chat);
    expect(world?.cast.find((member) => member.isPrimary)?.actorId).toBe(ROLLOUT_ACTORS.ana);
  });
});

// --- readSimChatGarments — the shared clothing digest (#297) ----------------
//
// Each case seeds its OWN isolated world/branch (never the shared rollout
// world above, which several other suites assume stays "no clothing" for
// Ana) and its own routed `characterChats` row. World cleanup rides the
// file's single harness (`trackWorld`); the chat/user rows this block creates
// are swept in its own `afterAll`.

const GARMENT_SEED_SECOND = 40_000;

interface GarmentCase {
  worldId: string;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  locationId: string;
  zoneId: string;
  shirtId: string;
}

function makeGarmentCase(): GarmentCase {
  const worldId = newId();
  const branchId = newId();
  return {
    worldId,
    branchId,
    playerActorId: newId(),
    primaryActorId: newId(),
    locationId: `${worldId}-loc-home`,
    zoneId: `${branchId}-zone-room`,
    shirtId: newId(),
  };
}

function garmentShirtBlueprint(): Record<string, unknown> {
  return successorGarmentBlueprint({
    id: "def-shirt",
    name: "linen shirt",
    category: "top",
    coverage: ["chest", "shoulders", "upper_arms"],
  });
}

describe.runIf(ready)("readSimChatGarments — the shared clothing digest (#297)", () => {
  const chatIds: string[] = [];
  const userIds: string[] = [];

  afterAll(async () => {
    if (!ready) return;
    for (const chatId of chatIds.splice(0)) {
      await db().delete(characterChats).where(eq(characterChats.id, chatId));
    }
    for (const userId of userIds.splice(0)) {
      await db().delete(users).where(eq(users.id, userId));
    }
  });

  /** Seed an isolated branch wearing `items`, plus a routed chat pointing at it. */
  async function seedGarmentChat(
    ids: GarmentCase,
    items: Parameters<typeof seedSimBranch>[0]["items"],
  ): Promise<string> {
    harness.trackWorld(ids.worldId);
    await seedSimBranch({
      worldId: ids.worldId,
      branchId: ids.branchId,
      worldTypeId: "e297-garment-digest-tests",
      rulesetVersion: "e297-garment-digest-v1",
      originStorySecond: GARMENT_SEED_SECOND,
      actors: [
        { id: ids.playerActorId, name: "Brian" },
        { id: ids.primaryActorId, name: "Nora" },
      ],
      items,
      locations: [{ id: ids.locationId, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" }],
      zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "room", privacyPolicy: "private" }],
      links: [],
      placements: [
        { actorId: ids.playerActorId, locationId: ids.locationId, zoneId: ids.zoneId },
        { actorId: ids.primaryActorId, locationId: ids.locationId, zoneId: ids.zoneId },
      ],
    });
    const [user] = await db()
      .insert(users)
      .values({ email: `sim-garments-${ids.worldId}-${Date.now()}@test.local`, name: "Sim Garments Int" })
      .returning();
    if (!user) throw new Error("failed to create test user");
    userIds.push(user.id);
    const [chat] = await db()
      .insert(characterChats)
      .values({
        ownerId: user.id,
        engineAuthority: "successor_narrative_view",
        simBranchId: ids.branchId,
        simPlayerActorId: ids.playerActorId,
        simPrimaryActorId: ids.primaryActorId,
      })
      .returning();
    if (!chat) throw new Error("failed to create routed chat");
    chatIds.push(chat.id);
    return chat.id;
  }

  it("renders a closure change into the structured digest after a set_closure command", async () => {
    const ids = makeGarmentCase();
    const chatId = await seedGarmentChat(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        garmentBlueprint: garmentShirtBlueprint(),
        locus: { kind: "worn", actorId: ids.primaryActorId, slotKey: successorWornSlotKey("top", 0) },
      },
    ]);

    expectAccepted(
      await submitDurableApplyGarmentOperation(
        simCommand({
          branchId: ids.branchId,
          name: "unfasten the shirt",
          type: "apply_garment_operation",
          principal: npcPrincipal(ids.primaryActorId),
          payload: {
            actorId: ids.primaryActorId,
            itemId: ids.shirtId,
            operation: {
              kind: "set_closure",
              garmentId: ids.shirtId,
              partId: "front_panel",
              state: { kind: "fastener_series", openFastenerIndexes: [0, 1] },
            },
          },
        }),
        ADMIT_AT_LOCKED_VERSION,
      ),
      "unfasten the shirt",
    );

    const result = await readSimChatGarments(chatId);
    if (result?.status !== "structured") throw new Error(`expected a structured read, got ${JSON.stringify(result)}`);
    expect(result.reliable).toBe(true);
    // The digest is what narration reads instead of the outfit line — it must
    // carry the closure change, not just the garment's name.
    expect(result.digest).toContain("Wardrobe right now (authoritative");
    expect(result.digest).toContain("open");
    expect(result.readouts).toHaveLength(1);
  });

  it("reads a known-empty worn set as 'empty', never null and never the outfit line's bare phrase", async () => {
    const ids = makeGarmentCase();
    const chatId = await seedGarmentChat(ids, [
      { id: ids.shirtId, name: "linen shirt", locus: { kind: "held", actorId: ids.primaryActorId } },
    ]);
    expect(await readSimChatGarments(chatId)).toEqual({ status: "empty" });
  });

  it("falls back to the name list, with the mapping-unresolved diagnostic, when no worn item resolves a reliable blueprint", async () => {
    const ids = makeGarmentCase();
    const chatId = await seedGarmentChat(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        // No `garmentBlueprint`: the pre-#295 seed shape, with the earlier
        // `<body-location>-<n>` slot vocabulary.
        locus: { kind: "worn", actorId: ids.primaryActorId, slotKey: "chest-0" },
      },
    ]);
    expect(await readSimChatGarments(chatId)).toEqual({
      status: "fallback",
      reason: SIM_GARMENT_MAPPING_UNRESOLVED,
      names: "linen shirt",
    });
  });

  it("keeps a mixed-reliability wardrobe structured but fully covered, never bare from a missing blueprint", async () => {
    const ids = makeGarmentCase();
    const necklaceId = newId();
    const chatId = await seedGarmentChat(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        garmentBlueprint: garmentShirtBlueprint(),
        locus: { kind: "worn", actorId: ids.primaryActorId, slotKey: successorWornSlotKey("top", 0) },
      },
      {
        id: necklaceId,
        name: "gold necklace",
        // No blueprint — unreliable on its own, but the shirt IS reliable, so
        // the wardrobe is MIXED rather than wholly unresolved.
        locus: { kind: "worn", actorId: ids.primaryActorId, slotKey: "neck-0" },
      },
    ]);

    const result = await readSimChatGarments(chatId);
    if (result?.status !== "structured") throw new Error(`expected a structured read, got ${JSON.stringify(result)}`);
    expect(result.reliable).toBe(false);
    expect(result.readouts).toHaveLength(2);
    // A partially-degraded wardrobe must never expose a region a broken row
    // merely failed to cover — exposure degrades to fully covered outright.
    expect(result.exposure).toEqual({ torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" });
  });
});

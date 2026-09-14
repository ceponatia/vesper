import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { successorGarmentBlueprint, successorWornSlotKey } from "@/contracts";
import { newId } from "@/lib/ids";
import { characterChats, db, users } from "@/server/db";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  npcPrincipal,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";
import { readSimChatGarments, SIM_GARMENT_MAPPING_UNRESOLVED } from "../sim-surfaces";
import { submitDurableApplyGarmentOperation } from "./garment-store";

/**
 * #297 — `readSimChatGarments`, the shared clothing digest the successor
 * narrator renders INSTEAD of the outfit line.
 *
 * **The defect this file kills: a wardrobe read that under-reports clothing.**
 * Every failure mode of this read lands in a prompt as a character wearing
 * less than the fiction ever said — a worn item that resolves no blueprint
 * silently dropping out of the digest, a partially-unreadable wardrobe
 * rendering its unreadable half as bare skin, or a known-empty worn set
 * arriving as `null` and reading downstream as "wardrobe unavailable" rather
 * than "no clothing". So each case pins what the read says when it CANNOT
 * resolve structure: an explicit `empty`, an explicit `fallback` carrying the
 * `sim_garment.mapping_unresolved` reason plus the plain name list, or a
 * structured read whose exposure degrades to fully covered.
 *
 * **Why it lives under `simulation/`.** These cases were written inside
 * `../sim-surfaces.int.test.ts`, which belongs to the `app-int` project that
 * ordinary CI never selects: `pnpm test:engine` (the `engine integration` job)
 * takes `apps/web/src/server/engine/simulation` as a whole directory and no
 * named `apps/web/src/server/engine/*.int.test.ts` beyond `sim-narrator`. A
 * database-backed proof that no job runs proves nothing, so the cases moved to
 * where the job looks. `readSimChatGarments` is imported from `../sim-surfaces`
 * directly; nothing imports a test file, so that edge cannot close a cycle.
 *
 * The db-free degradation guards for the surrounding sim-surface reads stay in
 * `../sim-surfaces.degradation.test.ts`; each case here seeds its OWN isolated
 * world, never the shared rollout world (several suites assume Ana stays "no
 * clothing" there).
 */
const harness = await simulationSuiteHarness({
  suite: "sim-chat-garments.int.test",
  table: "character_chats",
  legacyPlayerMode: false,
});
const ready = harness.ready;

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
          name: "unfasten-the-shirt",
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

  it("derives exposure from the RESOLVED coverage — a dressed torso covered, the rest bare", async () => {
    const ids = makeGarmentCase();
    const chatId = await seedGarmentChat(ids, [
      {
        id: ids.shirtId,
        name: "linen shirt",
        garmentBlueprint: garmentShirtBlueprint(),
        locus: { kind: "worn", actorId: ids.primaryActorId, slotKey: successorWornSlotKey("top", 0) },
      },
    ]);

    const result = await readSimChatGarments(chatId);
    if (result?.status !== "structured") throw new Error(`expected a structured read, got ${JSON.stringify(result)}`);
    expect(result.reliable).toBe(true);
    // The shirt's coverage is chest/shoulders/upper_arms, so `chest` lands in
    // the `torso` region and nothing reaches groin, hips, buttocks, thighs or
    // feet. This is the arm that carries the whole reliable path —
    // `garmentExposureInput` → `garmentEffectiveCoverage(...).covers` →
    // `exposedRegions` — and it is what makes the degraded case below mean
    // something: an implementation that simply returned `FULLY_COVERED` for
    // every read would satisfy the mixed-wardrobe assertion and fail here.
    expect(result.exposure).toEqual({ torso: "covered", pelvis: "bare", legs: "bare", feet: "bare" });
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

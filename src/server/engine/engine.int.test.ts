import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  characters,
  db,
  episodes,
  events,
  facts,
  itemInstances,
  items,
  locations,
  loreChunks,
  participantRelationships,
  sessionLinks,
  sessionLocations,
  sessionParticipants,
  sessions,
  turnMessages,
  turns,
  users,
  worldCast,
  worldItems,
  worldLinks,
  worldLocations,
  worlds,
} from "../db";
import { loadSessionBundle } from "./bundle";
import { applyTurnResults } from "./merge";
import { createSessionFromWorld, restartSession } from "./spawn";
import { sessionJobStatus, submitTurn, type TurnStreamEvent } from "./pipeline";

/**
 * Full demo-mode turn against the real database (docs/turn-engine.md
 * §Invariants): spawn a world fixture inline, play a turn end-to-end through
 * the SSE generator + in-process job runner, and verify the CAS guard.
 */

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sessions limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // stderr directly: vitest swallows console.* emitted during collection
    process.stderr.write(`[engine.int.test] skipping integration suite — database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();

let ownerId: string;
let worldId: string;

async function drain(gen: AsyncGenerator<TurnStreamEvent>): Promise<TurnStreamEvent[]> {
  const events: TurnStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

async function waitForReady(sessionId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db().select({ status: sessions.status }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (row?.status === "ready") return;
    if (Date.now() > deadline) throw new Error(`session ${sessionId} never returned to ready (status: ${row?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

afterAll(async () => {
  if (ready && ownerId) {
    await db().delete(sessions).where(eq(sessions.ownerId, ownerId));
    await db().delete(worlds).where(eq(worlds.ownerId, ownerId));
    await db().delete(characters).where(eq(characters.ownerId, ownerId));
    await db().delete(locations).where(eq(locations.ownerId, ownerId));
    await db().delete(items).where(eq(items.ownerId, ownerId));
    await db().delete(users).where(eq(users.id, ownerId));
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

describe.skipIf(!ready)("engine integration (demo mode)", () => {
  beforeAll(async () => {
    const [user] = await db()
      .insert(users)
      .values({ email: `engine-int-${Date.now()}@test.local`, name: "Brian" })
      .returning({ id: users.id });
    if (!user) throw new Error("user insert failed");
    ownerId = user.id;

    const [kitchen] = await db()
      .insert(locations)
      .values({ ownerId, name: "Kitchen", description: "A warm farmhouse kitchen.", ambient: { scent: "bread" } })
      .returning({ id: locations.id });
    const [garden] = await db()
      .insert(locations)
      .values({ ownerId, name: "Garden", description: "An overgrown herb garden." })
      .returning({ id: locations.id });
    if (!kitchen || !garden) throw new Error("location insert failed");

    const [sundress] = await db()
      .insert(items)
      .values({
        ownerId,
        kind: "clothing",
        name: "sundress",
        description: "A pale yellow sundress.",
        definition: { coverage: ["torso"], layer: 1, opacity: "opaque" },
      })
      .returning({ id: items.id });
    const [lantern] = await db()
      .insert(items)
      .values({ ownerId, kind: "object", name: "lantern", description: "A brass lantern." })
      .returning({ id: items.id });
    if (!sundress || !lantern) throw new Error("item insert failed");

    const [maya] = await db()
      .insert(characters)
      .values({
        ownerId,
        name: "Maya",
        profile: { bio: "Maya grew up coastal and fears deep water.", defaultOutfit: [sundress.id] },
      })
      .returning({ id: characters.id });
    if (!maya) throw new Error("character insert failed");

    const [world] = await db()
      .insert(worlds)
      .values({
        ownerId,
        name: "Engine Test World",
        lore: { synopsis: "A quiet inn.", plotAnchors: [{ id: "anchor-1", title: "The missing brother", priority: "active" }] },
      })
      .returning({ id: worlds.id });
    if (!world) throw new Error("world insert failed");
    worldId = world.id;

    const [wlKitchen] = await db()
      .insert(worldLocations)
      .values({ worldId, locationId: kitchen.id })
      .returning({ id: worldLocations.id });
    const [wlGarden] = await db()
      .insert(worldLocations)
      .values({ worldId, locationId: garden.id, overrides: { name: "Walled Garden" } })
      .returning({ id: worldLocations.id });
    if (!wlKitchen || !wlGarden) throw new Error("world location insert failed");
    await db().insert(worldLinks).values({ worldId, fromWorldLocationId: wlKitchen.id, toWorldLocationId: wlGarden.id, label: "back door" });
    await db().insert(worldCast).values({ worldId, characterId: maya.id, role: "companion", startWorldLocationId: wlKitchen.id });
    await db().insert(worldItems).values({ worldId, itemId: lantern.id, worldLocationId: wlKitchen.id });
  });

  it("materializes a session from the world definition", async () => {
    const sink = new DiagnosticCollector();
    const created = await createSessionFromWorld({ worldId, userId: ownerId, title: "Spawn check", embodied: true, sink });
    expect(created).not.toBeNull();
    if (!created) return;

    const locs = await db().select().from(sessionLocations).where(eq(sessionLocations.sessionId, created.sessionId));
    expect(locs).toHaveLength(2);
    expect(locs.map((l) => l.name).sort()).toEqual(["Kitchen", "Walled Garden"]); // override applied

    const links = await db().select().from(sessionLinks).where(eq(sessionLinks.sessionId, created.sessionId));
    expect(links).toHaveLength(1);
    expect(links[0]?.label).toBe("back door");

    const participants = await db()
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, created.sessionId))
      .orderBy(asc(sessionParticipants.createdAt));
    expect(participants).toHaveLength(2);
    const mayaP = participants.find((p) => p.displayName === "Maya");
    const player = participants.find((p) => p.isUser);
    expect(mayaP?.role).toBe("companion");
    expect(player?.displayName).toBe("Brian");

    const instances = await db().select().from(itemInstances).where(eq(itemInstances.sessionId, created.sessionId));
    const worn = instances.find((i) => i.name === "sundress");
    const loose = instances.find((i) => i.name === "lantern");
    expect(worn?.holderParticipantId).toBe(mayaP?.id);
    expect(worn?.worn).toBe(true);
    expect(loose?.locationId).toBe(locs.find((l) => l.name === "Kitchen")?.id);

    const [sessionRow] = await db().select().from(sessions).where(eq(sessions.id, created.sessionId)).limit(1);
    const runtime = sessionRow?.runtime as { storyThreads?: Array<{ id: string; status: string; source: string }> };
    expect(runtime.storyThreads).toEqual([expect.objectContaining({ id: "anchor-1", status: "open", source: "anchor" })]);
  });

  it("walks a director-staged NPC to its destination and fires the pending message on arrival", async () => {
    const created = await createSessionFromWorld({ worldId, userId: ownerId, title: "Staged beat", embodied: true });
    if (!created) throw new Error("spawn failed");
    const sessionId = created.sessionId;

    const parts = await db().select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, sessionId));
    const maya = parts.find((p) => p.displayName === "Maya");
    const locs = await db().select().from(sessionLocations).where(eq(sessionLocations.sessionId, sessionId));
    const garden = locs.find((l) => l.name === "Walled Garden");
    if (!maya || !garden) throw new Error("fixture lookup failed");

    // Inject a director-staged intent onto the runtime JSONB (the movement
    // system's input; here we seed it directly to exercise the full pipeline).
    // Walled Garden is one adjacent hop from the Kitchen, so she arrives + the
    // text fires in this single turn.
    const [before] = await db().select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const seeded = {
      ...(before?.runtime as Record<string, unknown>),
      stagedIntents: [
        {
          id: "si-int",
          participantId: maya.id,
          destinationLocationId: garden.id,
          reason: "heading out to the garden",
          onArrival: { comms: { kind: "text", gist: "I'm out in the garden — come find me?", urgency: "normal" } },
          status: "active",
          openedAtTurn: 0,
          expiresInTurns: 6,
        },
      ],
    };
    await db().update(sessions).set({ runtime: seeded }).where(eq(sessions.id, sessionId));

    await drain(submitTurn({ sessionId, userId: ownerId, body: { input: "I tidy the kitchen.", author: "player" } }));
    await waitForReady(sessionId);

    const [after] = await db().select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const rt = after?.runtime as { stagedIntents: unknown[]; pendingComms: Array<{ fromParticipantId: string; gist: string }> };
    const [mayaAfter] = await db().select().from(sessionParticipants).where(eq(sessionParticipants.id, maya.id)).limit(1);

    expect(mayaAfter?.locationId).toBe(garden.id); // walked the one hop, off-screen
    expect(rt.stagedIntents).toEqual([]); // resolved + pruned on arrival
    expect(rt.pendingComms).toEqual([
      expect.objectContaining({ fromParticipantId: maya.id, gist: "I'm out in the garden — come find me?" }),
    ]);
  });

  it("plays a full demo turn: stream, merge, episode, clock, session ready", async () => {
    const created = await createSessionFromWorld({ worldId, userId: ownerId, title: "Full turn", embodied: true });
    if (!created) throw new Error("spawn failed");
    const sessionId = created.sessionId;

    const events = await drain(
      submitTurn({ sessionId, userId: ownerId, body: { input: "I head to the Walled Garden with Maya.", author: "player" } }),
    );
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("start");
    expect(kinds).toContain("chunk");
    expect(kinds).toContain("status");
    expect(kinds.at(-1)).toBe("done");
    expect(kinds).not.toContain("error");
    // The demo narrative carries a [Maya]-tagged line — the segmenter must surface it.
    expect(events.some((e) => e.event === "chunk" && e.data["speaker"] === "Maya")).toBe(true);

    await waitForReady(sessionId);

    const [turn] = await db().select().from(turns).where(eq(turns.sessionId, sessionId)).limit(1);
    expect(turn?.status).toBe("ready");
    expect(turn?.number).toBe(1);
    expect(turn?.narration?.length ?? 0).toBeGreaterThan(0);
    expect(turn?.minutes).toBe(20); // demo heuristic for "head to"

    // Pre-narrator intake is persisted on the turn. In demo mode it degrades to
    // the regex fallback brief, which still resolves the movement phrase.
    const intentBrief = turn?.intentBrief as { enterLocation?: string };
    expect(intentBrief).toBeTruthy();
    expect((intentBrief.enterLocation ?? "").toLowerCase()).toContain("garden");

    const messages = await db().select().from(turnMessages).where(eq(turnMessages.turnId, turn?.id ?? "")).orderBy(asc(turnMessages.seq));
    expect(messages[0]?.role).toBe("player");
    expect(messages.length).toBeGreaterThan(1);

    const episodeRows = await db().select().from(episodes).where(eq(episodes.sessionId, sessionId));
    expect(episodeRows).toHaveLength(1);
    expect(episodeRows[0]?.turnNumber).toBe(1);
    expect(episodeRows[0]?.embedder).toBe("pseudo");

    const [sessionRow] = await db().select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(sessionRow?.status).toBe("ready");
    expect(sessionRow?.clockMinutes).toBe(20); // clock advanced by the merge
    const brief = sessionRow?.brief as { sceneSummary?: string };
    expect(brief.sceneSummary ?? "").toContain("Demo scene");

    // Demo keyword movement: the player walked into the adjacent garden.
    const [player] = await db()
      .select()
      .from(sessionParticipants)
      .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.isUser, true)))
      .limit(1);
    const [gardenLoc] = await db()
      .select()
      .from(sessionLocations)
      .where(and(eq(sessionLocations.sessionId, sessionId), eq(sessionLocations.name, "Walled Garden")))
      .limit(1);
    expect(player?.locationId).toBe(gardenLoc?.id);

    const status = await sessionJobStatus(sessionId);
    expect(status?.status).toBe("ready");
  });

  it("two concurrent submits: exactly one proceeds, the other gets session_busy", async () => {
    const created = await createSessionFromWorld({ worldId, userId: ownerId, title: "CAS check", embodied: true });
    if (!created) throw new Error("spawn failed");
    const sessionId = created.sessionId;

    const g1 = submitTurn({ sessionId, userId: ownerId, body: { input: "I say hello.", author: "player" } });
    const g2 = submitTurn({ sessionId, userId: ownerId, body: { input: "I say goodbye.", author: "player" } });
    const [first1, first2] = await Promise.all([g1.next(), g2.next()]);

    const firstEvents = [first1.value, first2.value].filter((v): v is TurnStreamEvent => v !== undefined);
    const busy = firstEvents.filter((e) => e.event === "error" && e.data["code"] === "session_busy");
    const started = firstEvents.filter((e) => e.event === "start");
    expect(busy).toHaveLength(1);
    expect(started).toHaveLength(1);

    await Promise.all([drain(g1), drain(g2)]);
    await waitForReady(sessionId);

    const turnRows = await db().select().from(turns).where(eq(turns.sessionId, sessionId));
    expect(turnRows).toHaveLength(1);
    expect(turnRows[0]?.status).toBe("ready");
  });

  it("applyTurnResults logs an affinity_stage event row on stage transitions only", async () => {
    const created = await createSessionFromWorld({ worldId, userId: ownerId, title: "Affinity stage", embodied: true });
    if (!created) throw new Error("spawn failed");
    const sessionId = created.sessionId;

    const participants = await db().select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, sessionId));
    const maya = participants.find((p) => p.displayName === "Maya");
    const player = participants.find((p) => p.isUser);
    if (!maya || !player) throw new Error("participants missing");

    // Park Maya's feeling edge one point under the acquaintance boundary (15).
    await db().insert(participantRelationships).values({
      sessionId,
      fromParticipantId: maya.id,
      toParticipantId: player.id,
      kind: "feeling",
      value: 13,
      stage: "stranger",
    });

    const apply = async (turnNumber: number, delta: number) => {
      const input = "I tell Maya about the lighthouse.";
      const [turnRow] = await db()
        .insert(turns)
        .values({ sessionId, number: turnNumber, author: "player", input, narration: "She listens.", status: "processing" })
        .returning({ id: turns.id });
      if (!turnRow) throw new Error("turn insert failed");
      const sink = new DiagnosticCollector();
      const bundle = await loadSessionBundle(sessionId, sink);
      if (!bundle) throw new Error("bundle load failed");
      await applyTurnResults({
        bundle,
        turn: { id: turnRow.id, number: turnNumber, author: "player", input, narration: "She listens." },
        results: {
          simulant: {
            minutesAdvanced: 5,
            movements: [],
            itemEvents: [],
            meterAdjustments: [],
            conditionEvents: [],
            attributeChanges: [],
            activityUpdates: [],
            affinityAdjustments: [{ fromName: "Maya", towardName: "Brian", delta, reason: "shared confidence" }],
            commsEvents: [],
          },
          archivist: null,
          continuity: null,
          director: null,
        },
        sink,
      });
      return turnRow.id;
    };

    const turnId = await apply(1, 5); // 13 → 18: stranger → acquaintance
    const [edge] = await db()
      .select()
      .from(participantRelationships)
      .where(and(eq(participantRelationships.sessionId, sessionId), eq(participantRelationships.kind, "feeling")));
    expect(edge?.value).toBe(18);
    expect(edge?.stage).toBe("acquaintance");

    const stageEvents = await db()
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "affinity_stage")));
    expect(stageEvents).toHaveLength(1);
    expect(stageEvents[0]?.payload).toMatchObject({
      fromParticipantId: maya.id,
      toParticipantId: player.id,
      kind: "feeling",
      from: "stranger",
      to: "acquaintance",
      value: 18,
      reason: "shared confidence",
      turnId,
    });

    await apply(2, 1); // 18 → 19: same stage — no new event row
    const after = await db()
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "affinity_stage")));
    expect(after).toHaveLength(1);
  });

  it("stamps witnessed_by on facts and the episode from co-location with the player", async () => {
    const created = await createSessionFromWorld({ worldId, userId: ownerId, title: "Witness stamp", embodied: true });
    if (!created) throw new Error("spawn failed");
    const sessionId = created.sessionId;

    const participants = await db().select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, sessionId));
    const maya = participants.find((p) => p.displayName === "Maya");
    const player = participants.find((p) => p.isUser);
    if (!maya || !player) throw new Error("participants missing");

    // Move Maya out of the player's room: she must not witness this turn.
    const [garden] = await db()
      .select()
      .from(sessionLocations)
      .where(and(eq(sessionLocations.sessionId, sessionId), eq(sessionLocations.name, "Walled Garden")))
      .limit(1);
    if (!garden) throw new Error("garden missing");
    await db().update(sessionParticipants).set({ locationId: garden.id }).where(eq(sessionParticipants.id, maya.id));

    const input = "I check the cellar door again.";
    const [turnRow] = await db()
      .insert(turns)
      .values({ sessionId, number: 1, author: "player", input, narration: "The latch holds.", status: "processing" })
      .returning({ id: turns.id });
    if (!turnRow) throw new Error("turn insert failed");
    const sink = new DiagnosticCollector();
    const bundle = await loadSessionBundle(sessionId, sink);
    if (!bundle) throw new Error("bundle load failed");
    await applyTurnResults({
      bundle,
      turn: { id: turnRow.id, number: 1, author: "player", input, narration: "The latch holds." },
      results: {
        simulant: null,
        archivist: {
          episodeSummary: "Brian inspected the cellar door alone.",
          facts: [
            {
              kind: "knowledge",
              subjectName: "Brian",
              subjectKind: "player",
              text: "Brian distrusts the cellar door.",
              tags: [],
              confidence: 0.9,
            },
          ],
          supersedeHints: [],
        },
        continuity: null,
        director: null,
      },
      sink,
    });

    const factRows = await db().select().from(facts).where(eq(facts.sessionId, sessionId));
    expect(factRows).toHaveLength(1);
    expect(factRows[0]?.witnessedBy).toEqual([player.id]); // co-located set: the player only

    const episodeRows = await db().select().from(episodes).where(eq(episodes.sessionId, sessionId));
    expect(episodeRows).toHaveLength(1);
    expect(episodeRows[0]?.witnessedBy).toEqual([player.id]);
  });

  it("zero-config world: a demo turn reproduces pre-phase-1 clock and affinity behavior exactly", async () => {
    // The fixture world sets none of the multi-character phase-1 fields (no
    // travelMinutes, scale/area, tiers, authored relationships) — the
    // no-regression gate promised by multi-character-phase-1-plan §Testing.
    const created = await createSessionFromWorld({ worldId, userId: ownerId, title: "Zero config", embodied: true });
    if (!created) throw new Error("spawn failed");
    const sessionId = created.sessionId;

    const streamed = await drain(
      submitTurn({ sessionId, userId: ownerId, body: { input: "I look around quietly.", author: "player" } }),
    );
    expect(streamed.map((e) => e.event)).not.toContain("error");
    await waitForReady(sessionId);

    // Clock: the demo estimate path (5m fallback heuristic) wins — no travel,
    // no registered action component.
    const [turn] = await db().select().from(turns).where(eq(turns.sessionId, sessionId)).limit(1);
    expect(turn?.status).toBe("ready");
    expect(turn?.minutes).toBe(5);
    const agentResults = turn?.agentResults as { clock?: { minutes: number; cause: string } };
    expect(agentResults.clock).toEqual({ minutes: 5, cause: "scene" });

    const [sessionRow] = await db().select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(sessionRow?.clockMinutes).toBe(5);

    // Affinity machinery untouched: no edges, no stage or decay event rows.
    expect(
      await db().select().from(participantRelationships).where(eq(participantRelationships.sessionId, sessionId)),
    ).toHaveLength(0);
    const eventRows = await db().select().from(events).where(eq(events.sessionId, sessionId));
    expect(eventRows.filter((e) => e.type === "affinity_stage" || e.type === "affinity_decay_clamped")).toHaveLength(0);
  });

  it("seeds participant_relationships from authored cast relationships at spawn", async () => {
    const [rook] = await db()
      .insert(characters)
      .values({ ownerId, name: "Rook", profile: { bio: "An old friend of the player from the harbor days." } })
      .returning({ id: characters.id });
    const [sable] = await db()
      .insert(characters)
      .values({ ownerId, name: "Sable", profile: { bio: "A reclusive tidewatcher." } })
      .returning({ id: characters.id });
    const [jetty] = await db()
      .insert(locations)
      .values({ ownerId, name: "Jetty", description: "Salt-bleached planks." })
      .returning({ id: locations.id });
    if (!rook || !sable || !jetty) throw new Error("fixture insert failed");
    const [relWorld] = await db().insert(worlds).values({ ownerId, name: "Relationship World" }).returning({ id: worlds.id });
    if (!relWorld) throw new Error("world insert failed");
    const [wlJetty] = await db()
      .insert(worldLocations)
      .values({ worldId: relWorld.id, locationId: jetty.id })
      .returning({ id: worldLocations.id });
    if (!wlJetty) throw new Error("world location insert failed");
    await db().insert(worldCast).values([
      {
        worldId: relWorld.id,
        characterId: rook.id,
        role: "npc",
        startWorldLocationId: wlJetty.id,
        relationships: [
          { toward: "Sable", stage: "close" },
          { toward: "player", stage: "friendly" },
          { toward: "Ghost", stage: "devoted" }, // unresolved on purpose
        ],
      },
      {
        worldId: relWorld.id,
        characterId: sable.id,
        role: "npc",
        startWorldLocationId: wlJetty.id,
        // explicit reverse direction (lowercase to exercise case-insensitive resolution)
        relationships: [{ toward: "rook", stage: "wary" }],
      },
    ]);

    const sink = new DiagnosticCollector();
    const created = await createSessionFromWorld({ worldId: relWorld.id, userId: ownerId, title: "Rel spawn", embodied: true, sink });
    expect(created).not.toBeNull();
    if (!created) return;

    const participants = await db().select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, created.sessionId));
    const rookP = participants.find((p) => p.displayName === "Rook");
    const sableP = participants.find((p) => p.displayName === "Sable");
    const player = participants.find((p) => p.isUser);
    if (!rookP || !sableP || !player) throw new Error("participants missing");

    const rows = await db().select().from(participantRelationships).where(eq(participantRelationships.sessionId, created.sessionId));
    expect(rows).toHaveLength(4);
    const edge = (fromId: string, toId: string, kind: string) =>
      rows.find((r) => r.fromParticipantId === fromId && r.toParticipantId === toId && r.kind === kind);

    // Authored Rook→Sable at the close midpoint; the explicit Sable→Rook wary
    // edge wins over the implied reverse.
    expect(edge(rookP.id, sableP.id, "feeling")).toMatchObject({ value: 72, stage: "close" });
    expect(edge(sableP.id, rookP.id, "feeling")).toMatchObject({ value: -48, stage: "wary" });

    // Player edges: feeling at the friendly midpoint, perceived mirrored (the
    // bio names a mutual-knowledge bond: "an old friend of the player").
    expect(edge(rookP.id, player.id, "feeling")).toMatchObject({ value: 41, stage: "friendly" });
    expect(edge(rookP.id, player.id, "perceived")).toMatchObject({ value: 41, stage: "friendly" });

    // The unresolved "Ghost" entry degraded: diagnostic recorded, no row, spawn succeeded.
    expect(sink.items.some((d) => d.code === "spawn.relationship.unresolved_toward")).toBe(true);
  });

  it("resolves {{player}} at bundle load: embodied name, observer fallback, identifiers untouched", async () => {
    const [scribe] = await db()
      .insert(characters)
      .values({ ownerId, name: "Scribe", profile: { bio: "Chronicles {{player}}'s deeds." } })
      .returning({ id: characters.id });
    const [hall] = await db()
      .insert(locations)
      .values({ ownerId, name: "{{player}} Hall", description: "Built where {{player}} was born." })
      .returning({ id: locations.id });
    if (!scribe || !hall) throw new Error("fixture insert failed");
    const [tokenWorld] = await db()
      .insert(worlds)
      .values({
        ownerId,
        name: "Token World",
        description: "A story about {{player}}.",
        style: { directives: ["Follow {{ Player }} closely."] },
        lore: { synopsis: "{{PLAYER}} arrives at dusk." },
      })
      .returning({ id: worlds.id });
    if (!tokenWorld) throw new Error("world insert failed");
    const [wlHall] = await db()
      .insert(worldLocations)
      .values({ worldId: tokenWorld.id, locationId: hall.id })
      .returning({ id: worldLocations.id });
    if (!wlHall) throw new Error("world location insert failed");
    await db().insert(worldCast).values({ worldId: tokenWorld.id, characterId: scribe.id, role: "npc", startWorldLocationId: wlHall.id });
    await db().insert(loreChunks).values({ worldId: tokenWorld.id, title: "The arrival", body: "Town gossip says {{player}} will return.", tier: "always" });

    const embodied = await createSessionFromWorld({ worldId: tokenWorld.id, userId: ownerId, title: "Token embodied", embodied: true });
    if (!embodied) throw new Error("spawn failed");
    const bundle = await loadSessionBundle(embodied.sessionId);
    if (!bundle) throw new Error("bundle load failed");

    // The user fixture is named Brian — the embodied player's display name.
    expect(bundle.world.description).toBe("A story about Brian.");
    expect(bundle.lore.synopsis).toBe("Brian arrives at dusk.");
    expect(bundle.style.directives).toEqual(["Follow Brian closely."]);
    expect(bundle.loreChunks[0]?.body).toBe("Town gossip says Brian will return.");
    expect(bundle.participants.find((p) => !p.isUser)?.snapshot.bio).toBe("Chronicles Brian's deeds.");
    expect(bundle.locations[0]?.description).toBe("Built where Brian was born.");
    expect(bundle.locations[0]?.name).toBe("{{player}} Hall"); // names are grounding identifiers — never substituted

    // Observer sessions spawn no is_user row: the token fills with the fixed phrase.
    const observer = await createSessionFromWorld({ worldId: tokenWorld.id, userId: ownerId, title: "Token observer", embodied: false });
    if (!observer) throw new Error("spawn failed");
    const observerBundle = await loadSessionBundle(observer.sessionId);
    if (!observerBundle) throw new Error("bundle load failed");
    expect(observerBundle.participants.some((p) => p.isUser)).toBe(false);
    expect(observerBundle.world.description).toBe("A story about the protagonist.");
    expect(observerBundle.participants.find((p) => !p.isUser)?.snapshot.bio).toBe("Chronicles the protagonist's deeds.");
  });

  it("warns past the major-tier soft cap at spawn without blocking or trimming", async () => {
    const [hall] = await db()
      .insert(locations)
      .values({ ownerId, name: "Great Hall", description: "Echoing stone." })
      .returning({ id: locations.id });
    if (!hall) throw new Error("location insert failed");
    const [capWorld] = await db().insert(worlds).values({ ownerId, name: "Crowded World" }).returning({ id: worlds.id });
    if (!capWorld) throw new Error("world insert failed");
    const [wlHall] = await db()
      .insert(worldLocations)
      .values({ worldId: capWorld.id, locationId: hall.id })
      .returning({ id: worldLocations.id });
    if (!wlHall) throw new Error("world location insert failed");

    // 6 authored majors + 1 default-tier companion (spawn bumps it to major) = 7 > cap 6.
    const castMembers: Array<{ name: string; role: "companion" | "npc"; tier: "major" | "minor" }> = [
      ...Array.from({ length: 6 }, (_, i) => ({ name: `Major ${i + 1}`, role: "npc" as const, tier: "major" as const })),
      { name: "Sidekick", role: "companion", tier: "minor" },
    ];
    for (const member of castMembers) {
      const [row] = await db().insert(characters).values({ ownerId, name: member.name }).returning({ id: characters.id });
      if (!row) throw new Error("character insert failed");
      await db().insert(worldCast).values({
        worldId: capWorld.id,
        characterId: row.id,
        role: member.role,
        tier: member.tier,
        startWorldLocationId: wlHall.id,
      });
    }

    const sink = new DiagnosticCollector();
    const created = await createSessionFromWorld({ worldId: capWorld.id, userId: ownerId, title: "Cap check", embodied: true, sink });
    expect(created).not.toBeNull();
    if (!created) return;

    // Warn, never block: the session spawned with the full cast (7 + player).
    const participants = await db().select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, created.sessionId));
    expect(participants).toHaveLength(8);
    expect(participants.filter((p) => !p.isUser && p.tier === "major")).toHaveLength(7);

    const capDiag = sink.items.find((d) => d.code === "spawn.cast.major_soft_cap");
    expect(capDiag?.severity).toBe("warn");
    expect(capDiag?.context).toMatchObject({ majorCount: 7, cap: 6 });
  });

  it("promotes an in-cast player character: one participant, placed items and outfit intact", async () => {
    const [coat] = await db()
      .insert(items)
      .values({ ownerId, kind: "clothing", name: "oilskin coat", description: "A salt-stiff coat.", definition: { coverage: ["torso"], layer: 2, opacity: "opaque" } })
      .returning({ id: items.id });
    const [scarf] = await db()
      .insert(items)
      .values({ ownerId, kind: "clothing", name: "red scarf", description: "A red wool scarf.", definition: { coverage: ["neck"], layer: 1, opacity: "opaque" } })
      .returning({ id: items.id });
    const [satchel] = await db()
      .insert(items)
      .values({ ownerId, kind: "object", name: "satchel", description: "A worn leather satchel." })
      .returning({ id: items.id });
    if (!coat || !scarf || !satchel) throw new Error("item insert failed");

    const [devin] = await db()
      .insert(characters)
      .values({ ownerId, name: "Devin", profile: { bio: "A harbor pilot.", defaultOutfit: [coat.id] } })
      .returning({ id: characters.id });
    const [mara] = await db()
      .insert(characters)
      .values({ ownerId, name: "Mara", profile: { bio: "Runs the chandlery." } })
      .returning({ id: characters.id });
    const [cove] = await db()
      .insert(locations)
      .values({ ownerId, name: "Cove", description: "A sheltered cove." })
      .returning({ id: locations.id });
    const [den] = await db()
      .insert(locations)
      .values({ ownerId, name: "Den", description: "A low-beamed den." })
      .returning({ id: locations.id });
    if (!devin || !mara || !cove || !den) throw new Error("fixture insert failed");

    const [pcWorld] = await db().insert(worlds).values({ ownerId, name: "Played Cast World" }).returning({ id: worlds.id });
    if (!pcWorld) throw new Error("world insert failed");
    const [wlCove] = await db()
      .insert(worldLocations)
      .values({ worldId: pcWorld.id, locationId: cove.id })
      .returning({ id: worldLocations.id });
    const [wlDen] = await db()
      .insert(worldLocations)
      .values({ worldId: pcWorld.id, locationId: den.id })
      .returning({ id: worldLocations.id });
    if (!wlCove || !wlDen) throw new Error("world location insert failed");
    // Generic player start set to the cove; Devin's own placement (the den) must win.
    await db().update(worlds).set({ playerStartWorldLocationId: wlCove.id }).where(eq(worlds.id, pcWorld.id));

    const [devinCast] = await db()
      .insert(worldCast)
      .values({
        worldId: pcWorld.id,
        characterId: devin.id,
        role: "npc",
        startWorldLocationId: wlDen.id,
        relationships: [{ toward: "Mara", stage: "close" }],
      })
      .returning({ id: worldCast.id });
    await db().insert(worldCast).values({
      worldId: pcWorld.id,
      characterId: mara.id,
      role: "npc",
      startWorldLocationId: wlCove.id,
      relationships: [{ toward: "Devin", stage: "friendly" }],
    });
    if (!devinCast) throw new Error("cast insert failed");
    await db().insert(worldItems).values([
      { worldId: pcWorld.id, itemId: scarf.id, castId: devinCast.id, worn: true },
      { worldId: pcWorld.id, itemId: satchel.id, castId: devinCast.id },
    ]);

    const created = await createSessionFromWorld({
      worldId: pcWorld.id,
      userId: ownerId,
      title: "Played cast",
      embodied: true,
      playerCharacterId: devin.id,
    });
    if (!created) throw new Error("spawn failed");

    // One participant per character — no "Devin 2" duplicate.
    const participants = await db().select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, created.sessionId));
    expect(participants).toHaveLength(2);
    const devinP = participants.find((p) => p.displayName === "Devin");
    const maraP = participants.find((p) => p.displayName === "Mara");
    if (!devinP || !maraP) throw new Error("participants missing");
    expect(devinP).toMatchObject({ isUser: true, role: "player", tier: "major", characterId: devin.id });

    // The authored cast placement (den) beats the generic player start (cove).
    const locs = await db().select().from(sessionLocations).where(eq(sessionLocations.sessionId, created.sessionId));
    expect(devinP.locationId).toBe(locs.find((l) => l.name === "Den")?.id);

    // World-placed items land on the player; the default outfit seeds exactly once.
    const instances = await db().select().from(itemInstances).where(eq(itemInstances.sessionId, created.sessionId));
    const held = instances.filter((i) => i.holderParticipantId === devinP.id);
    expect(held.map((i) => [i.name, i.worn]).sort()).toEqual([
      ["oilskin coat", true],
      ["red scarf", true],
      ["satchel", false],
    ]);
    expect(instances.filter((i) => i.name === "oilskin coat")).toHaveLength(1);

    // Decision 41 end-to-end: the played member owns no edges; Mara's explicit
    // friendly edge toward "Devin" resolves to the player and wins over the
    // close implication from Devin's own authored entry.
    const rows = await db().select().from(participantRelationships).where(eq(participantRelationships.sessionId, created.sessionId));
    expect(rows.filter((r) => r.fromParticipantId === devinP.id)).toHaveLength(0);
    const maraEdges = rows.filter((r) => r.fromParticipantId === maraP.id && r.toParticipantId === devinP.id);
    expect(maraEdges.map((r) => [r.kind, r.value]).sort()).toEqual([
      ["feeling", 41],
      ["perceived", 41],
    ]);
  });

  it("seeds a non-cast player character's default outfit", async () => {
    const [slicker] = await db()
      .insert(items)
      .values({ ownerId, kind: "clothing", name: "yellow slicker", description: "A bright rain slicker.", definition: { coverage: ["torso"], layer: 2, opacity: "opaque" } })
      .returning({ id: items.id });
    if (!slicker) throw new Error("item insert failed");
    const [pip] = await db()
      .insert(characters)
      .values({ ownerId, name: "Pip", profile: { bio: "A wandering courier.", defaultOutfit: [slicker.id] } })
      .returning({ id: characters.id });
    const [shore] = await db()
      .insert(locations)
      .values({ ownerId, name: "Shore", description: "A windswept shore." })
      .returning({ id: locations.id });
    if (!pip || !shore) throw new Error("fixture insert failed");
    const [soloWorld] = await db().insert(worlds).values({ ownerId, name: "Solo World" }).returning({ id: worlds.id });
    if (!soloWorld) throw new Error("world insert failed");
    await db().insert(worldLocations).values({ worldId: soloWorld.id, locationId: shore.id });

    const created = await createSessionFromWorld({
      worldId: soloWorld.id,
      userId: ownerId,
      title: "Solo outfit",
      embodied: true,
      playerCharacterId: pip.id,
    });
    if (!created) throw new Error("spawn failed");

    const participants = await db().select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, created.sessionId));
    expect(participants).toHaveLength(1);
    const player = participants[0];
    expect(player).toMatchObject({ isUser: true, displayName: "Pip", characterId: pip.id });

    const instances = await db().select().from(itemInstances).where(eq(itemInstances.sessionId, created.sessionId));
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ name: "yellow slicker", holderParticipantId: player?.id, worn: true });
  });

  it("restartSession wipes play state and re-materializes from the world", async () => {
    const created = await createSessionFromWorld({ worldId, userId: ownerId, title: "Restart", embodied: true });
    if (!created) throw new Error("spawn failed");
    const sessionId = created.sessionId;

    await drain(submitTurn({ sessionId, userId: ownerId, body: { input: "I head to the Walled Garden.", author: "player" } }));
    await waitForReady(sessionId);

    const restarted = await restartSession(sessionId);
    expect(restarted).toBe(true);

    const [sessionRow] = await db().select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect(sessionRow?.status).toBe("ready");
    expect(sessionRow?.clockMinutes).toBe(0);
    expect(await db().select().from(turns).where(eq(turns.sessionId, sessionId))).toHaveLength(0);
    expect(await db().select().from(episodes).where(eq(episodes.sessionId, sessionId))).toHaveLength(0);

    const participants = await db().select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, sessionId));
    expect(participants).toHaveLength(2);
    const player = participants.find((p) => p.isUser);
    const kitchenRow = await db()
      .select()
      .from(sessionLocations)
      .where(and(eq(sessionLocations.sessionId, sessionId), eq(sessionLocations.name, "Kitchen")));
    expect(player?.locationId).toBe(kitchenRow[0]?.id); // back at the start location
  });
});

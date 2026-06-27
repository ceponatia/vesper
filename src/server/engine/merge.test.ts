import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { emptyItemDefinition, emptyItemInstanceState, type ItemDefinition } from "@/contracts/items/item";
import { emptyBrief, type NextTurnBrief } from "@/contracts/state/brief";
import { emptyParticipantState } from "@/contracts/state/participant-state";
import { emptySceneGenState } from "@/contracts/state/scene-gen";
import { emptySessionRuntime, stagedIntentSchema, type StagedIntent, type StoryThread } from "@/contracts/state/session-runtime";
import type { AgentResults, DirectorResult, SimulantResult } from "@/contracts/turns/agent-results";
import { emptyCharacterProfile, emptyWorldLore, emptyWorldStyle } from "@/contracts/world/profile";
import type { BundleItem, BundleParticipant, BundlePlace, SessionBundle } from "./bundle";
import {
  FALLBACK_MINUTES_ADVANCED,
  MAX_MINUTES_ADVANCED,
  MIN_MINUTES_ADVANCED,
  REST_CLAMP_MINUTES,
  THREAD_COOLING_TURNS,
  THREAD_DEVELOPMENTS_CAP,
} from "./constants";
import type { SceneLinkInput } from "./scene";
import { type MergeTurn, type WorkingItem, type WorkingParticipant, planTurnEffects, stagedLocationAnchor } from "./merge";
import { findParticipant, isAdjacent, resolveItemByName, resolveSessionLocation } from "./merge/grounding";
import { planCardBreachReactions } from "./merge/phases/affinity";
import { buildNextBrief, reconcileBrief } from "./merge/phases/brief";
import { applyConditionEvents, expireConditions } from "./merge/phases/conditions";
import { syntheticEpisodeSummary } from "./merge/phases/facts";
import { assertPlacementExclusive, planItemEvent } from "./merge/phases/items";
import { advanceClock, applyMeterAdjustments, clampMinutes } from "./merge/phases/meters";
import { scheduleEntryAt, scheduleMoveStaging } from "./merge/phases/schedule";
import { applyThreadSignals, coolThreads, dedupeThreadProposals } from "./merge/phases/threads";
import { meterDefinitions } from "@/contracts/meters/registry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function place(id: string, name: string): BundlePlace {
  return { id, name, description: `${name} description`, ambient: {}, locationId: null, emergent: false };
}

function participant(
  id: string,
  displayName: string,
  locationId: string | null,
  opts: { isUser?: boolean; role?: "player" | "companion" | "npc"; aliases?: string[] } = {},
): BundleParticipant {
  const snapshot = emptyCharacterProfile();
  if (opts.aliases) snapshot.aliases = opts.aliases;
  return {
    id,
    displayName,
    isUser: opts.isUser ?? false,
    role: opts.role ?? (opts.isUser ? "player" : "npc"),
    tier: "minor",
    locationId,
    characterId: null,
    avatarImageId: null,
    snapshot,
    state: emptyParticipantState(),
  };
}

function itemDef(name: string, kind: ItemDefinition["kind"] = "object"): ItemDefinition {
  return { ...emptyItemDefinition(), kind, name, coverage: kind === "clothing" ? ["torso"] : [] };
}

function item(
  id: string,
  name: string,
  placement: Partial<Pick<BundleItem, "holderParticipantId" | "worn" | "locationId" | "containerInstanceId">>,
  kind: ItemDefinition["kind"] = "object",
): BundleItem & WorkingItem {
  return {
    id,
    name,
    itemId: null,
    definition: itemDef(name, kind),
    holderParticipantId: placement.holderParticipantId ?? null,
    worn: placement.worn ?? false,
    locationId: placement.locationId ?? null,
    containerInstanceId: placement.containerInstanceId ?? null,
    positionNote: null,
    state: emptyItemInstanceState(),
  };
}

function makeBundle(overrides: Partial<SessionBundle> = {}): SessionBundle {
  const locations = [place("loc-kitchen", "Kitchen"), place("loc-garden", "Garden"), place("loc-attic", "Attic")];
  const participants = [
    participant("p-player", "Brian", "loc-kitchen", { isUser: true, role: "player" }),
    participant("p-maya", "Maya Brennan", "loc-kitchen", { role: "companion", aliases: ["May"] }),
    participant("p-rhett", "Rhett", "loc-garden", { role: "npc" }),
  ];
  const items = [
    item("i-sundress", "sundress", { holderParticipantId: "p-maya", worn: true }, "clothing"),
    item("i-lantern", "lantern", { locationId: "loc-kitchen" }),
    item("i-basket", "basket", { locationId: "loc-kitchen" }, "container"),
    item("i-letter", "letter", { containerInstanceId: "i-basket" }),
  ];
  return {
    relationships: [],
    session: {
      id: "s-1",
      ownerId: "u-1",
      worldId: "w-1",
      title: "Test",
      embodied: true,
      status: "processing",
      clockMinutes: 0,
    },
    world: { id: "w-1", ownerId: "u-1", name: "Testworld", description: "", narrativeModel: "", agentModel: "" },
    participants,
    locations,
    // Kitchen ↔ Garden adjacent; Attic unreachable.
    links: [{ fromId: "loc-kitchen", toId: "loc-garden", label: null }],
    items,
    loreChunks: [],
    style: emptyWorldStyle(),
    lore: emptyWorldLore(),
    runtime: emptySessionRuntime(),
    brief: emptyBrief(),
    scene: emptySceneGenState(),
    clockMinutes: 0,
    ...overrides,
  };
}

function makeTurn(overrides: Partial<MergeTurn> = {}): MergeTurn {
  return {
    id: "t-1",
    number: 5,
    author: "player",
    input: "I look around.",
    narration: "The kitchen holds its small sounds while you take stock of the morning.",
    ...overrides,
  };
}

function simulant(overrides: Partial<SimulantResult> = {}): SimulantResult {
  return {
    minutesAdvanced: 10,
    movements: [],
    itemEvents: [],
    meterAdjustments: [],
    conditionEvents: [],
    attributeChanges: [],
    affinityAdjustments: [],
    activityUpdates: [],
    commsEvents: [],
    ...overrides,
  };
}

function results(overrides: Partial<AgentResults> = {}): AgentResults {
  return { simulant: null, archivist: null, continuity: null, director: null, ...overrides };
}

function director(overrides: Partial<DirectorResult> = {}): DirectorResult {
  return {
    sceneSummary: "Scene summary.",
    storySoFar: "Story so far.",
    characterNotes: [],
    directives: [],
    memoryQueries: ["tea"],
    exposure: { appearance: "ambient", scent: "none", touch: "none", taste: "none" },
    threadSignals: { touch: [], develop: [], propose: [], resolve: [] },
    stageMovement: { stage: [], cancel: [] },
    ...overrides,
  };
}

async function plan(bundleOverrides: Partial<SessionBundle>, agentResults: AgentResults, turnOverrides: Partial<MergeTurn> = {}) {
  const sink = new DiagnosticCollector();
  const bundle = makeBundle(bundleOverrides);
  const merged = await planTurnEffects({ bundle, turn: makeTurn(turnOverrides), results: agentResults, sink });
  return { plan: merged, sink, bundle };
}

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((d) => d.code);
}

// ---------------------------------------------------------------------------
// Clock clamping
// ---------------------------------------------------------------------------

describe("clampMinutes / advanceClock", () => {
  it("falls back to FALLBACK_MINUTES_ADVANCED on null/garbage", () => {
    expect(clampMinutes(null)).toBe(FALLBACK_MINUTES_ADVANCED);
    expect(clampMinutes(undefined)).toBe(FALLBACK_MINUTES_ADVANCED);
    expect(clampMinutes(Number.NaN)).toBe(FALLBACK_MINUTES_ADVANCED);
    expect(clampMinutes(Number.POSITIVE_INFINITY)).toBe(FALLBACK_MINUTES_ADVANCED);
  });

  it("clamps to [MIN, MAX] with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    expect(clampMinutes(0, sink)).toBe(MIN_MINUTES_ADVANCED);
    expect(clampMinutes(-50, sink)).toBe(MIN_MINUTES_ADVANCED);
    expect(clampMinutes(100_000, sink)).toBe(MAX_MINUTES_ADVANCED);
    expect(codes(sink)).toContain("merge.clock.clamped");
  });

  it("rounds and passes sane values through", () => {
    expect(clampMinutes(7.4)).toBe(7);
    expect(clampMinutes(480)).toBe(480);
    expect(advanceClock({ clockMinutes: 100, minutesAdvanced: 25 })).toEqual({ clockMinutes: 125, minutes: 25 });
  });
});

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

describe("grounding", () => {
  const parts: WorkingParticipant[] = makeBundle().participants;

  it("matches display names case-insensitively with canonical casing", () => {
    expect(findParticipant("maya brennan", parts)?.displayName).toBe("Maya Brennan");
  });

  it("matches aliases and unique first names", () => {
    expect(findParticipant("may", parts)?.displayName).toBe("Maya Brennan");
    expect(findParticipant("Maya", parts)?.displayName).toBe("Maya Brennan");
    expect(findParticipant("nobody", parts)).toBeNull();
  });

  it("resolves session locations exactly then loosely (unique only)", () => {
    const locations = makeBundle().locations;
    expect(resolveSessionLocation("garden", locations)?.id).toBe("loc-garden");
    expect(resolveSessionLocation("the garden", locations)?.id).toBe("loc-garden");
    expect(resolveSessionLocation("nowhere", locations)).toBeNull();
  });

  it("prefers worn instances for remove and held for drop", () => {
    const items: WorkingItem[] = [
      item("a", "scarf", { locationId: "loc-kitchen" }, "clothing"),
      item("b", "scarf", { holderParticipantId: "p-maya", worn: true }, "clothing"),
    ];
    const actor = { id: "p-maya", locationId: "loc-kitchen" };
    expect(resolveItemByName("scarf", "remove", items, actor)?.id).toBe("b");
    expect(resolveItemByName("scarf", "wear", items, actor)?.id).toBe("a");
  });

  it("treats links as bidirectional for adjacency", () => {
    const links = makeBundle().links;
    expect(isAdjacent("loc-kitchen", "loc-garden", links)).toBe(true);
    expect(isAdjacent("loc-garden", "loc-kitchen", links)).toBe(true);
    expect(isAdjacent("loc-kitchen", "loc-attic", links)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

describe("movement validation", () => {
  it("applies adjacent moves", async () => {
    const { plan: p } = await plan(
      {},
      results({ simulant: simulant({ movements: [{ participantName: "Maya", toLocationName: "Garden" }] }) }),
    );
    expect(p.participants.find((x) => x.id === "p-maya")?.locationId).toBe("loc-garden");
  });

  it("drops non-adjacent moves with a diagnostic and a droppedEvents entry", async () => {
    const { plan: p, sink } = await plan(
      {},
      results({ simulant: simulant({ movements: [{ participantName: "Maya", toLocationName: "Attic" }] }) }),
    );
    expect(p.participants.find((x) => x.id === "p-maya")?.locationId).toBe("loc-kitchen");
    expect(codes(sink)).toContain("merge.movement.invalid");
    expect(p.droppedEvents.length).toBeGreaterThan(0);
    expect(p.brief.droppedEvents.length).toBeGreaterThan(0);
  });

  it("drops unknown participants and unknown locations", async () => {
    const { sink } = await plan(
      {},
      results({
        simulant: simulant({
          movements: [
            { participantName: "Ghost", toLocationName: "Garden" },
            { participantName: "Maya", toLocationName: "Moon Base" },
          ],
        }),
      }),
    );
    expect(codes(sink)).toContain("merge.participant.unresolved");
    expect(codes(sink)).toContain("merge.location.unresolved");
  });

  it("never moves the player on non-player-authored turns", async () => {
    const { plan: p, sink } = await plan(
      {},
      results({ simulant: simulant({ movements: [{ participantName: "Brian", toLocationName: "Garden" }] }) }),
      { author: "director" },
    );
    expect(p.participants.find((x) => x.id === "p-player")?.locationId).toBe("loc-kitchen");
    expect(codes(sink)).toContain("merge.movement.player_not_author");
  });
});

// ---------------------------------------------------------------------------
// Link access enforcement (phase-2-plan T8, player-side)
// ---------------------------------------------------------------------------

describe("link access enforcement", () => {
  const playerMove = () =>
    results({ simulant: simulant({ movements: [{ participantName: "Brian", toLocationName: "Garden" }] }) });
  const link = (access?: SceneLinkInput["access"], doorItemId?: string): SceneLinkInput[] => [
    { fromId: "loc-kitchen", toId: "loc-garden", label: null, access, doorItemId },
  ];

  it("locked blocks the player's move: diagnostic + brief-level note, player stays put", async () => {
    const { plan: p, sink } = await plan({ links: link({ kind: "locked", keyItemId: "key-1" }) }, playerMove());
    expect(p.participants.find((x) => x.id === "p-player")?.locationId).toBe("loc-kitchen");
    expect(codes(sink)).toContain("merge.movement.access_denied");
    expect(p.droppedEvents.some((e) => e.includes("locked"))).toBe(true);
    expect(p.brief.droppedEvents.some((e) => e.includes("locked"))).toBe(true);
  });

  it("v1 is player-side only: an NPC passes the same locked link", async () => {
    const { plan: p, sink } = await plan(
      { links: link({ kind: "locked" }) },
      results({ simulant: simulant({ movements: [{ participantName: "Maya", toLocationName: "Garden" }] }) }),
    );
    expect(p.participants.find((x) => x.id === "p-maya")?.locationId).toBe("loc-garden");
    expect(codes(sink)).not.toContain("merge.movement.access_denied");
  });

  it("timeWindow checks the turn-start minute of day, wrapping past midnight", async () => {
    // Calendar starts 08:00; the garden gate is open 18:00–02:00.
    const gate = link({ kind: "timeWindow", start: 1080, end: 120 });
    const blocked = await plan({ links: gate }, playerMove()); // clock 0 → 08:00
    expect(blocked.plan.participants.find((x) => x.id === "p-player")?.locationId).toBe("loc-kitchen");
    expect(codes(blocked.sink)).toContain("merge.movement.access_denied");

    const open = await plan({ links: gate, clockMinutes: 720 }, playerMove()); // → 20:00
    expect(open.plan.participants.find((x) => x.id === "p-player")?.locationId).toBe("loc-garden");
    expect(codes(open.sink)).not.toContain("merge.movement.access_denied");
  });

  it("a bound door instance that is closed+locked counts as locked; open or unlocked does not", async () => {
    const door = item("i-door", "oak door", { locationId: "loc-kitchen" });
    door.state.open = false;
    door.state.locked = true;
    const sealed = await plan({ links: link(undefined, "i-door"), items: [door] }, playerMove());
    expect(sealed.plan.participants.find((x) => x.id === "p-player")?.locationId).toBe("loc-kitchen");
    expect(codes(sealed.sink)).toContain("merge.movement.access_denied");

    const ajar = item("i-door", "oak door", { locationId: "loc-kitchen" });
    ajar.state.open = true;
    ajar.state.locked = true;
    const passable = await plan({ links: link(undefined, "i-door"), items: [ajar] }, playerMove());
    expect(passable.plan.participants.find((x) => x.id === "p-player")?.locationId).toBe("loc-garden");
    expect(codes(passable.sink)).not.toContain("merge.movement.access_denied");
  });

  it("private has no player effect yet", async () => {
    const { plan: p, sink } = await plan({ links: link({ kind: "private", ownerParticipantIds: ["p-maya"] }) }, playerMove());
    expect(p.participants.find((x) => x.id === "p-player")?.locationId).toBe("loc-garden");
    expect(codes(sink)).not.toContain("merge.movement.access_denied");
  });

  it("degraded default: a link with no access field behaves exactly as before", async () => {
    const { plan: p, sink } = await plan({}, playerMove());
    expect(p.participants.find((x) => x.id === "p-player")?.locationId).toBe("loc-garden");
    expect(codes(sink)).not.toContain("merge.movement.access_denied");
  });
});

// ---------------------------------------------------------------------------
// Declared rest (phase-2-plan T7)
// ---------------------------------------------------------------------------

describe("declared rest in planTurnEffects", () => {
  it("fast-forwards to the wake time, applies drift across the span, persists a rest cause", async () => {
    // Calendar starts 08:00; clock 900 → 23:00. Morning = next 05:00 → 360 min.
    const { plan: p } = await plan(
      { clockMinutes: 900 },
      results({ simulant: simulant({ minutesAdvanced: 15 }) }),
      { input: "I go to bed." },
    );
    expect(p.minutes).toBe(360);
    expect(p.minutesCause).toBe("slept until morning");
    expect(p.clockMinutes).toBe(1260);
    // Existing per-hour drift across the whole span: energy 0.9 − 0.05 × 6h.
    const maya = p.participants.find((x) => x.id === "p-maya");
    expect(maya?.state.meters["energy"]).toBeCloseTo(0.6, 10);
  });

  it("clamps a full missed day to REST_CLAMP_MINUTES with a diagnostic", async () => {
    // clock 1260 → 05:00 next day, exactly at the dawn anchor → a full 1440.
    const { plan: p, sink } = await plan(
      { clockMinutes: 1260 },
      results({ simulant: simulant({ minutesAdvanced: 15 }) }),
      { input: "I sleep until morning." },
    );
    expect(p.minutes).toBe(REST_CLAMP_MINUTES);
    expect(codes(sink)).toContain("merge.clock.rest_clamped");
  });

  it("ordinary turns are unaffected (the no-regression case)", async () => {
    const { plan: p, sink } = await plan({}, results({ simulant: simulant({ minutesAdvanced: 15 }) }), {
      input: "I look around the kitchen.",
    });
    expect(p.minutes).toBe(15);
    expect(p.minutesCause).toBe("scene");
    expect(codes(sink)).not.toContain("merge.clock.rest_clamped");
  });
});

// ---------------------------------------------------------------------------
// Item events
// ---------------------------------------------------------------------------

function placementOf(p: Awaited<ReturnType<typeof plan>>["plan"], id: string) {
  const found = p.items.find((i) => i.id === id);
  if (!found) throw new Error(`item ${id} missing`);
  return found;
}

describe("item events", () => {
  it("wear sets holder+worn and clears other placements", async () => {
    const { plan: p } = await plan(
      {},
      results({
        simulant: simulant({
          itemEvents: [
            { action: "pick_up", itemName: "lantern", byName: "Maya" },
            { action: "remove", itemName: "sundress", byName: "Maya" },
          ],
        }),
      }),
    );
    const lantern = placementOf(p, "i-lantern");
    expect(lantern.holderParticipantId).toBe("p-maya");
    expect(lantern.locationId).toBeNull();
    expect(lantern.worn).toBe(false);
    const sundress = placementOf(p, "i-sundress");
    expect(sundress.worn).toBe(false);
    expect(sundress.holderParticipantId).toBe("p-maya");
    expect(p.touchedItemIds).toContain("i-lantern");
  });

  it("rejects wearing a non-clothing item", async () => {
    const { plan: p, sink } = await plan(
      {},
      results({ simulant: simulant({ itemEvents: [{ action: "wear", itemName: "lantern", byName: "Maya" }] }) }),
    );
    expect(placementOf(p, "i-lantern").locationId).toBe("loc-kitchen");
    expect(codes(sink)).toContain("merge.item.invalid_wear");
    expect(p.droppedEvents.length).toBeGreaterThan(0);
  });

  it("drop and place land in the actor's room; store_in moves into containers", async () => {
    const { plan: p } = await plan(
      {},
      results({
        simulant: simulant({
          itemEvents: [
            { action: "pick_up", itemName: "lantern", byName: "Maya" },
            { action: "store_in", itemName: "lantern", byName: "Maya", containerName: "basket" },
            { action: "take_from", itemName: "letter", byName: "Brian", containerName: "basket" },
            { action: "drop", itemName: "letter", byName: "Brian" },
          ],
        }),
      }),
    );
    const lantern = placementOf(p, "i-lantern");
    expect(lantern.containerInstanceId).toBe("i-basket");
    expect(lantern.holderParticipantId).toBeNull();
    const letter = placementOf(p, "i-letter");
    expect(letter.locationId).toBe("loc-kitchen");
    expect(letter.containerInstanceId).toBeNull();
  });

  it("remove with a locationName drops the garment in the open at the actor's room (the floor)", async () => {
    const { plan: p } = await plan(
      {},
      results({
        simulant: simulant({
          // "kicks off her sneakers, they thud to the floor" — removed AND left on the ground.
          itemEvents: [{ action: "remove", itemName: "sundress", byName: "Maya", locationName: "the floor" }],
        }),
      }),
    );
    const sundress = placementOf(p, "i-sundress");
    expect(sundress.worn).toBe(false);
    expect(sundress.holderParticipantId).toBeNull(); // not held — on the floor
    expect(sundress.locationId).toBe("loc-kitchen"); // unresolvable "the floor" falls back to the actor's room
    expect(sundress.containerInstanceId).toBeNull();
  });

  it("remove with a containerName stows the garment in the container", async () => {
    const { plan: p } = await plan(
      {},
      results({
        simulant: simulant({
          itemEvents: [{ action: "remove", itemName: "sundress", byName: "Maya", containerName: "basket" }],
        }),
      }),
    );
    const sundress = placementOf(p, "i-sundress");
    expect(sundress.worn).toBe(false);
    expect(sundress.holderParticipantId).toBeNull();
    expect(sundress.containerInstanceId).toBe("i-basket");
    expect(sundress.locationId).toBeNull();
  });

  it("open/close only works on containers and flips state.open", async () => {
    const { plan: p, sink } = await plan(
      {},
      results({
        simulant: simulant({
          itemEvents: [
            { action: "open", itemName: "basket" },
            { action: "open", itemName: "lantern" },
          ],
        }),
      }),
    );
    expect(placementOf(p, "i-basket").state.open).toBe(true);
    expect(codes(sink)).toContain("merge.item.not_container");
  });

  it("alter appends a capped state note", async () => {
    const { plan: p } = await plan(
      {},
      results({
        simulant: simulant({
          itemEvents: [{ action: "alter", itemName: "lantern", stateNote: "dented on one side" }],
        }),
      }),
    );
    expect(placementOf(p, "i-lantern").state.notes).toContain("dented on one side");
  });

  it("drops unresolved items with diagnostics and records the dropped event", async () => {
    const { plan: p, sink } = await plan(
      {},
      results({ simulant: simulant({ itemEvents: [{ action: "pick_up", itemName: "chainsaw", byName: "Maya" }] }) }),
    );
    expect(codes(sink)).toContain("merge.item.unresolved");
    expect(p.droppedEvents.some((d) => d.includes("chainsaw"))).toBe(true);
  });

  it("refuses container cycles", () => {
    const basket = item("i-basket", "basket", { locationId: "loc-kitchen" }, "container");
    const pouch = item("i-pouch", "pouch", { containerInstanceId: "i-basket" }, "container");
    const result = planItemEvent(
      { action: "store_in", itemName: "basket", containerName: "pouch" },
      { item: basket, actor: null, location: null, container: pouch, items: [basket, pouch] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("merge.item.container_cycle");
  });

  it("every applied placement is exclusive", async () => {
    const { plan: p } = await plan(
      {},
      results({
        simulant: simulant({
          itemEvents: [
            { action: "pick_up", itemName: "lantern", byName: "Maya" },
            { action: "store_in", itemName: "letter", byName: "Brian", containerName: "basket" },
          ],
        }),
      }),
    );
    for (const i of p.items) {
      expect(
        assertPlacementExclusive({
          holderParticipantId: i.holderParticipantId,
          worn: i.worn,
          locationId: i.locationId,
          containerInstanceId: i.containerInstanceId,
        }),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Clock, meters, conditions, schedules
// ---------------------------------------------------------------------------

describe("clock and meters", () => {
  it("applies drift THEN agent deltas (corrections win over drift)", async () => {
    const bundle = makeBundle();
    const maya = bundle.participants.find((p) => p.id === "p-maya");
    if (!maya) throw new Error("fixture");
    maya.state.meters = { ...maya.state.meters, energy: 0.05 };
    const sink = new DiagnosticCollector();
    const p = await planTurnEffects({
      bundle,
      turn: makeTurn(),
      // energy drifts at -0.05/h; 120 min → -0.1 clamps 0.05 → 0; delta +0.3 after drift → 0.3.
      results: results({
        simulant: simulant({
          minutesAdvanced: 120,
          meterAdjustments: [{ participantName: "Maya", meterId: "energy", delta: 0.3 }],
        }),
      }),
      sink,
    });
    const after = p.participants.find((x) => x.id === "p-maya");
    expect(after?.state.meters["energy"]).toBeCloseTo(0.3, 5);
    expect(p.clockMinutes).toBe(120);
    expect(p.minutes).toBe(120);
  });

  it("drops unknown meter ids with a diagnostic", async () => {
    const { sink } = await plan(
      {},
      results({
        simulant: simulant({ meterAdjustments: [{ participantName: "Maya", meterId: "charisma", delta: 0.5 }] }),
      }),
    );
    expect(codes(sink)).toContain("merge.meter.unknown");
  });

  it("clamps applied deltas into the meter range", () => {
    const sink = new DiagnosticCollector();
    const meters = applyMeterAdjustments({ energy: 0.9 }, [{ meterId: "energy", delta: 5 }], meterDefinitions, sink);
    expect(meters["energy"]).toBe(1);
  });
});

describe("conditions", () => {
  it("adds conditions starting at the new clock, ends by label, expires by duration", async () => {
    const bundle = makeBundle();
    const maya = bundle.participants.find((p) => p.id === "p-maya");
    if (!maya) throw new Error("fixture");
    maya.state.conditions = [
      { id: "c-old", label: "soaked", startedAtMinutes: 0, durationMinutes: 30, attributeEffects: [] },
      { id: "c-keep", label: "bruised shin", startedAtMinutes: 0, attributeEffects: [] },
    ];
    const sink = new DiagnosticCollector();
    const p = await planTurnEffects({
      bundle,
      turn: makeTurn(),
      results: results({
        simulant: simulant({
          minutesAdvanced: 60,
          conditionEvents: [
            { op: "add", participantName: "Maya", label: "winded", durationMinutes: 20 },
            { op: "end", participantName: "Maya", label: "missing condition" },
          ],
        }),
      }),
      sink,
    });
    const after = p.participants.find((x) => x.id === "p-maya");
    const labels = after?.state.conditions.map((c) => c.label) ?? [];
    expect(labels).toContain("winded");
    expect(labels).toContain("bruised shin");
    expect(labels).not.toContain("soaked"); // expired: 0 + 30 ≤ 60
    expect(after?.state.conditions.find((c) => c.label === "winded")?.startedAtMinutes).toBe(60);
    expect(codes(sink)).toContain("merge.condition.unmatched");
  });

  it("refreshes rather than duplicates an active condition", () => {
    const next = applyConditionEvents(
      [{ id: "c1", label: "soaked", startedAtMinutes: 0, attributeEffects: [] }],
      [{ op: "add", participantName: "Maya", label: "Soaked", severity: "moderate" }],
      45,
    );
    expect(next).toHaveLength(1);
    expect(next[0]?.severity).toBe("moderate");
    expect(next[0]?.startedAtMinutes).toBe(45);
  });

  it("expireConditions keeps duration-less conditions", () => {
    const kept = expireConditions(
      [
        { id: "a", label: "scar", startedAtMinutes: 0, attributeEffects: [] },
        { id: "b", label: "wet", startedAtMinutes: 0, durationMinutes: 10, attributeEffects: [] },
      ],
      20,
    );
    expect(kept.map((c) => c.label)).toEqual(["scar"]);
  });
});

describe("attribute and activity updates", () => {
  it("applies a mutable attribute change as a narrative overlay", async () => {
    const { plan: p } = await plan(
      {},
      results({
        simulant: simulant({
          // hair.color is mutable — a dye job is a legitimate narrative change.
          attributeChanges: [{ participantName: "Maya", attributeId: "hair.color", value: "auburn" }],
          activityUpdates: [{ participantName: "Maya", activity: "cooking", posture: "leaning on the counter" }],
        }),
      }),
    );
    const maya = p.participants.find((x) => x.id === "p-maya");
    expect(maya?.state.attributeOverlays).toEqual([
      expect.objectContaining({ id: "hair.color", value: "auburn", source: "narrative" }),
    ]);
    expect(maya?.state.activity).toBe("cooking");
    expect(maya?.state.posture).toBe("leaning on the counter");
  });

  it("drops unknown attribute ids", async () => {
    const { plan: p, sink } = await plan(
      {},
      results({
        simulant: simulant({
          attributeChanges: [{ participantName: "Maya", attributeId: "nonsense.attr", value: "x" }],
        }),
      }),
    );
    expect(codes(sink)).toContain("merge.attribute.unknown");
    expect(p.participants.find((x) => x.id === "p-maya")?.state.attributeOverlays).toEqual([]);
  });

  it("replaces a prior narrative overlay for the same mutable attribute", async () => {
    const bundle = makeBundle();
    const maya = bundle.participants.find((p) => p.id === "p-maya");
    if (!maya) throw new Error("fixture");
    maya.state.attributeOverlays = [{ id: "hair.color", value: "brown", source: "narrative" }];
    const sink = new DiagnosticCollector();
    const p = await planTurnEffects({
      bundle,
      turn: makeTurn(),
      results: results({
        simulant: simulant({
          attributeChanges: [{ participantName: "Maya", attributeId: "hair.color", value: "auburn" }],
        }),
      }),
      sink,
    });
    const overlays = p.participants.find((x) => x.id === "p-maya")?.state.attributeOverlays ?? [];
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.value).toBe("auburn");
  });

  it("rejects a narrative change to an inherent attribute, with a diagnostic + correction", async () => {
    // eyes.color is inherent — prose getting vivid must not rewrite a defining trait.
    const { plan: p, sink } = await plan(
      {},
      results({
        simulant: simulant({
          attributeChanges: [{ participantName: "Maya", attributeId: "eyes.color", value: "blue" }],
        }),
      }),
    );
    const maya = p.participants.find((x) => x.id === "p-maya");
    expect(maya?.state.attributeOverlays).toEqual([]);
    expect(codes(sink)).toContain("merge.attribute.inherent_change_rejected");
    expect(p.droppedEvents.some((e) => e.toLowerCase().includes("inherent trait"))).toBe(true);
    expect(p.brief.droppedEvents.some((e) => e.toLowerCase().includes("inherent trait"))).toBe(true);
  });

  it("stays silent when an inherent change merely re-asserts the current value", async () => {
    const bundle = makeBundle();
    const maya = bundle.participants.find((p) => p.id === "p-maya");
    if (!maya) throw new Error("fixture");
    maya.snapshot.attributes = [{ id: "eyes.color", value: "green", source: "creation" }];
    const sink = new DiagnosticCollector();
    const p = await planTurnEffects({
      bundle,
      turn: makeTurn(),
      results: results({
        simulant: simulant({
          attributeChanges: [{ participantName: "Maya", attributeId: "eyes.color", value: "green" }],
        }),
      }),
      sink,
    });
    const updated = p.participants.find((x) => x.id === "p-maya");
    expect(updated?.state.attributeOverlays).toEqual([]);
    expect(codes(sink)).not.toContain("merge.attribute.inherent_change_rejected");
    expect(p.droppedEvents.some((e) => e.toLowerCase().includes("inherent trait"))).toBe(false);
  });
});

describe("schedules", () => {
  it("scheduleEntryAt handles plain and wrap-around windows", () => {
    const schedule = [
      { startMinute: 540, endMinute: 1020, locationName: "Garden", activity: "gardening" },
      { startMinute: 1380, endMinute: 360, locationName: "Attic", activity: "sleeping" },
    ];
    expect(scheduleEntryAt(schedule, 600)?.activity).toBe("gardening");
    expect(scheduleEntryAt(schedule, 1400)?.activity).toBe("sleeping");
    expect(scheduleEntryAt(schedule, 120)?.activity).toBe("sleeping");
    expect(scheduleEntryAt(schedule, 1100)).toBeNull();
  });

  it("ticks off-screen NPCs to their scheduled room but never teleports on-screen NPCs", async () => {
    const bundle = makeBundle();
    // Default calendar starts 8:00 → clock 0 + 60 min = 9:00 = minute 540.
    const rhett = bundle.participants.find((p) => p.id === "p-rhett");
    const maya = bundle.participants.find((p) => p.id === "p-maya");
    if (!rhett || !maya) throw new Error("fixture");
    rhett.snapshot.schedule = [{ startMinute: 540, endMinute: 1020, locationName: "Attic", activity: "dusting shelves" }];
    maya.snapshot.schedule = [{ startMinute: 540, endMinute: 1020, locationName: "Attic", activity: "dusting shelves" }];
    const sink = new DiagnosticCollector();
    const p = await planTurnEffects({
      bundle,
      turn: makeTurn(),
      results: results({ simulant: simulant({ minutesAdvanced: 60 }) }),
      sink,
    });
    expect(p.participants.find((x) => x.id === "p-rhett")?.locationId).toBe("loc-attic");
    expect(p.participants.find((x) => x.id === "p-rhett")?.state.activity).toBe("dusting shelves");
    // Maya shares the player's room — on-screen, never teleported by schedule.
    expect(p.participants.find((x) => x.id === "p-maya")?.locationId).toBe("loc-kitchen");
    // The tick moved Rhett between two elsewhere rooms — nothing staged (T9).
    expect(p.brief.arrivals).toEqual([]);
    expect(p.brief.departures).toEqual([]);
  });

  it("stages an arrival in the brief when a tick moves an NPC into the player's location (T9)", async () => {
    const bundle = makeBundle();
    const rhett = bundle.participants.find((p) => p.id === "p-rhett");
    if (!rhett) throw new Error("fixture");
    // Wide window so the ±15-minute jitter cannot move 09:00 outside it.
    rhett.snapshot.schedule = [{ startMinute: 480, endMinute: 1020, locationName: "Kitchen", activity: "making tea" }];
    const sink = new DiagnosticCollector();
    const p = await planTurnEffects({
      bundle,
      turn: makeTurn(),
      results: results({ simulant: simulant({ minutesAdvanced: 60 }) }),
      sink,
    });
    expect(p.participants.find((x) => x.id === "p-rhett")?.locationId).toBe("loc-kitchen");
    expect(p.brief.arrivals).toEqual(["Rhett arrived from Garden."]);
    expect(p.brief.departures).toEqual([]);
  });
});

describe("scheduleMoveStaging", () => {
  const locationNameById = new Map([
    ["loc-market", "the market"],
    ["loc-docks", "the docks"],
    ["loc-square", "the square"],
  ]);

  it("renders arrivals into and departures out of the player's location", () => {
    expect(
      scheduleMoveStaging({
        displayName: "Mara",
        fromLocationId: "loc-market",
        toLocationId: "loc-square",
        activeLocationId: "loc-square",
        locationNameById,
      }),
    ).toEqual({ arrival: "Mara arrived from the market." });
    expect(
      scheduleMoveStaging({
        displayName: "Tom",
        fromLocationId: "loc-square",
        toLocationId: "loc-docks",
        activeLocationId: "loc-square",
        locationNameById,
      }),
    ).toEqual({ departure: "Tom left toward the docks." });
  });

  it("stages nothing for moves elsewhere or without a camera location", () => {
    expect(
      scheduleMoveStaging({
        displayName: "Mara",
        fromLocationId: "loc-market",
        toLocationId: "loc-docks",
        activeLocationId: "loc-square",
        locationNameById,
      }),
    ).toEqual({});
    expect(
      scheduleMoveStaging({
        displayName: "Mara",
        fromLocationId: "loc-market",
        toLocationId: "loc-square",
        activeLocationId: null,
        locationNameById,
      }),
    ).toEqual({});
  });

  it("degrades gracefully when the origin is unplaced or unnamed", () => {
    expect(
      scheduleMoveStaging({
        displayName: "Mara",
        fromLocationId: null,
        toLocationId: "loc-square",
        activeLocationId: "loc-square",
        locationNameById,
      }),
    ).toEqual({ arrival: "Mara arrived." });
  });
});

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

function thread(overrides: Partial<StoryThread> & Pick<StoryThread, "id" | "title">): StoryThread {
  return {
    summary: "",
    kind: "investigation",
    status: "open",
    source: "emergent",
    question: "",
    closeConditions: [],
    developments: [],
    openedAtTurn: 0,
    lastTouchedTurn: 0,
    touchCount: 0,
    ...overrides,
  };
}

describe("thread lifecycle", () => {
  it("touch reopens cooling threads and refreshes recency", () => {
    const sink = new DiagnosticCollector();
    const { threads, touchedIds } = applyThreadSignals(
      [thread({ id: "th1", title: "The letter", status: "cooling" })],
      { touch: [{ id: "th1", title: "The letter", summary: "Found in the coat." }], propose: [], resolve: [] },
      9,
      sink,
    );
    expect(threads[0]?.status).toBe("open");
    expect(threads[0]?.lastTouchedTurn).toBe(9);
    expect(threads[0]?.touchCount).toBe(1);
    expect(threads[0]?.summary).toBe("Found in the coat.");
    expect(touchedIds).toEqual(["th1"]);
  });

  it("exact-title re-proposal folds into the existing thread as a development, not a duplicate", () => {
    const sink = new DiagnosticCollector();
    const { threads } = applyThreadSignals(
      [thread({ id: "th1", title: "The letter" })],
      {
        propose: [
          { title: "the LETTER", kind: "investigation", summary: "again", closeConditions: [] },
          { title: "New mystery", kind: "investigation", summary: "", closeConditions: [] },
        ],
      },
      4,
      sink,
    );
    expect(threads).toHaveLength(2);
    expect(threads[0]?.touchCount).toBe(1);
    expect(threads[0]?.summary).toBe("again");
    expect(threads[0]?.developments).toEqual([{ turn: 4, text: "again", kind: "update" }]);
    expect(threads[1]?.title).toBe("New mystery");
    expect(threads[1]?.kind).toBe("investigation");
    expect(threads[1]?.source).toBe("emergent");
  });

  it("propose seeds kind, question, closeConditions, and an opening development", () => {
    const { threads } = applyThreadSignals(
      [],
      {
        propose: [
          {
            title: "Maya's social life",
            kind: "ongoing",
            question: "Who does Maya spend time with?",
            summary: "Local gossip about Maya.",
            closeConditions: [],
          },
        ],
      },
      2,
    );
    expect(threads[0]?.kind).toBe("ongoing");
    expect(threads[0]?.question).toBe("Who does Maya spend time with?");
    expect(threads[0]?.developments).toEqual([{ turn: 2, text: "Local gossip about Maya.", kind: "update" }]);
  });

  it("develop appends an accumulated entry and revises the summary; touch logs nothing", () => {
    const base = thread({ id: "th1", title: "Investigating Thorne", developments: [{ turn: 1, text: "First oddity.", kind: "event" }] });
    const developed = applyThreadSignals(
      [base],
      { develop: [{ id: "th1", entry: "Thorne dodged a direct question.", entryKind: "statement", summary: "Suspicion grows." }] },
      5,
    ).threads[0];
    expect(developed?.summary).toBe("Suspicion grows.");
    expect(developed?.developments).toEqual([
      { turn: 1, text: "First oddity.", kind: "event" },
      { turn: 5, text: "Thorne dodged a direct question.", kind: "statement" },
    ]);

    // touch keeps the thread warm but never writes to the log.
    const touched = applyThreadSignals([base], { touch: [{ id: "th1", title: "Investigating Thorne" }] }, 6).threads[0];
    expect(touched?.lastTouchedTurn).toBe(6);
    expect(touched?.developments).toHaveLength(1);
  });

  it("develop caps the accumulated log at THREAD_DEVELOPMENTS_CAP, dropping the oldest", () => {
    const many = Array.from({ length: THREAD_DEVELOPMENTS_CAP }, (_, i) => ({ turn: i, text: `dev ${i}`, kind: "update" as const }));
    const developed = applyThreadSignals(
      [thread({ id: "th1", title: "Long arc", developments: many })],
      { develop: [{ id: "th1", entry: "newest" }] },
      99,
    ).threads[0];
    expect(developed?.developments).toHaveLength(THREAD_DEVELOPMENTS_CAP);
    expect(developed?.developments.at(-1)?.text).toBe("newest");
    expect(developed?.developments.at(0)?.text).toBe("dev 1"); // "dev 0" dropped
  });

  it("resolve closes by id; unknown references degrade to diagnostics", () => {
    const sink = new DiagnosticCollector();
    const { threads } = applyThreadSignals(
      [thread({ id: "th1", title: "The letter" })],
      { touch: [{ title: "Phantom thread" }], propose: [], resolve: ["th1", "th-missing"] },
      4,
      sink,
    );
    expect(threads[0]?.status).toBe("resolved");
    expect(codes(sink).filter((c) => c === "merge.thread.unmatched")).toHaveLength(2);
  });

  it("open threads cool after THREAD_COOLING_TURNS untouched turns", () => {
    const cooled = coolThreads(
      [thread({ id: "th1", title: "Old", lastTouchedTurn: 1 }), thread({ id: "th2", title: "Fresh", lastTouchedTurn: 8 })],
      1 + THREAD_COOLING_TURNS,
    );
    expect(cooled[0]?.status).toBe("cooling");
    expect(cooled[1]?.status).toBe("open");
  });
});

describe("dedupeThreadProposals (semantic backstop)", () => {
  // Fake embedder: texts mentioning the same subject get identical vectors
  // (cosine 1.0); unrelated subjects are orthogonal (cosine 0). Deterministic,
  // no real embedding API — the demo-mode discipline.
  const fakeEmbed = (texts: string[]): Promise<number[][]> =>
    Promise.resolve(
      texts.map((t) => (/thorne/i.test(t) ? [1, 0, 0] : /weather/i.test(t) ? [0, 1, 0] : [0, 0, 1])),
    );
  const signals = (propose: { title: string; summary: string }[]) => ({
    touch: [],
    develop: [],
    propose: propose.map((p) => ({ title: p.title, kind: "investigation" as const, summary: p.summary, closeConditions: [] })),
    resolve: [],
  });

  it("folds a near-duplicate proposal into the matching thread as a develop; keeps a distinct one", async () => {
    const sink = new DiagnosticCollector();
    const out = await dedupeThreadProposals(
      [thread({ id: "th_thorne", title: "Investigating Thorne", summary: "Thorne is acting strange." })],
      signals([
        { title: "Thorne's odd mood", summary: "Thorne brooded all evening." },
        { title: "The strange weather", summary: "Storms out of season." },
      ]),
      fakeEmbed,
      7,
      sink,
    );
    expect(out.propose.map((p) => p.title)).toEqual(["The strange weather"]); // distinct one survives
    expect(out.develop).toEqual([
      { id: "th_thorne", entry: "Thorne brooded all evening.", summary: "Thorne brooded all evening." },
    ]);
    expect(codes(sink).filter((c) => c === "merge.thread.dedup_merged")).toHaveLength(1);
  });

  it("never folds into a resolved thread (a closed thread must not resurrect)", async () => {
    const out = await dedupeThreadProposals(
      [thread({ id: "th_thorne", title: "Investigating Thorne", status: "resolved" })],
      signals([{ title: "Thorne again", summary: "Thorne resurfaced." }]),
      fakeEmbed,
      9,
    );
    expect(out.propose).toHaveLength(1); // stays a fresh proposal, not a develop
    expect(out.develop).toHaveLength(0);
  });

  it("degrades to leaving proposals untouched when embedding fails", async () => {
    const sink = new DiagnosticCollector();
    const boom = () => Promise.reject(new Error("embed down"));
    const out = await dedupeThreadProposals(
      [thread({ id: "th_thorne", title: "Investigating Thorne" })],
      signals([{ title: "Thorne's odd mood", summary: "again" }]),
      boom,
      3,
      sink,
    );
    expect(out.propose).toHaveLength(1);
    expect(codes(sink).filter((c) => c === "merge.thread.dedup_embed_failed")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

describe("buildNextBrief", () => {
  const prior: NextTurnBrief = {
    ...emptyBrief(),
    sceneSummary: "Old scene.",
    storySoFar: "Old story.",
    memoryQueries: ["old query"],
    directives: ["Old directive"],
  };

  it("director null → prior carries forward with sceneSummary refreshed", () => {
    const brief = buildNextBrief({
      prior,
      director: null,
      continuity: null,
      episodeSummary: "Fresh episode.",
      droppedEvents: [],
      thresholdHints: [],
    });
    expect(brief.sceneSummary).toBe("Fresh episode.");
    expect(brief.storySoFar).toBe("Old story.");
    expect(brief.memoryQueries).toEqual(["old query"]);
  });

  it("caps continuity corrections at 2, major violations first, prefixed Correction:", () => {
    const brief = buildNextBrief({
      prior,
      director: director(),
      continuity: {
        violations: [
          { subject: "Maya", claim: "minor slip", canonical: "canon A", severity: "minor", kind: "general" },
          { subject: "Maya", claim: "big slip", canonical: "canon B", severity: "major", kind: "general" },
        ],
        cardBreaches: [],
        driftNotes: [],
      },
      episodeSummary: "ep",
      droppedEvents: [],
      thresholdHints: [],
    });
    const corrections = brief.directives.filter((d) => d.startsWith("Correction:"));
    expect(corrections).toHaveLength(2);
    expect(corrections[0]).toContain("big slip");
  });

  it("includes dropped events, threshold hints, and director exposure", () => {
    const brief = buildNextBrief({
      prior,
      director: director({ exposure: { appearance: "close", scent: "close", touch: "none", taste: "none" }, directives: ["Slow down."] }),
      continuity: null,
      episodeSummary: "ep",
      droppedEvents: ["Maya did not actually move to Attic."],
      thresholdHints: ["Maya: Tired: slower replies.", "Rhett: hint", "extra hint beyond cap"],
    });
    expect(brief.droppedEvents).toEqual(["Maya did not actually move to Attic."]);
    expect(brief.exposure.appearance).toBe("close");
    expect(brief.directives).toContain("Slow down.");
    expect(brief.directives).toContain("Maya: Tired: slower replies.");
    expect(brief.directives).not.toContain("extra hint beyond cap");
  });

  it("carries this turn's arrivals/departures and never the prior brief's (self-expiring staging)", () => {
    const staged = buildNextBrief({
      prior: { ...prior, arrivals: ["Old arrival."], departures: ["Old departure."] },
      director: director(),
      continuity: null,
      episodeSummary: "ep",
      droppedEvents: [],
      thresholdHints: [],
      arrivals: ["Mara arrived from the market."],
      departures: ["Tom left toward the docks."],
    });
    expect(staged.arrivals).toEqual(["Mara arrived from the market."]);
    expect(staged.departures).toEqual(["Tom left toward the docks."]);

    // Director failure: prior content carries forward, stale staging does not.
    const degraded = buildNextBrief({
      prior: { ...prior, arrivals: ["Old arrival."] },
      director: null,
      continuity: null,
      episodeSummary: "ep",
      droppedEvents: [],
      thresholdHints: [],
    });
    expect(degraded.arrivals).toEqual([]);
    expect(degraded.departures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Degradation: every agent failed
// ---------------------------------------------------------------------------

describe("planCardBreachReactions (witnessed breach)", () => {
  const card = {
    id: "no-pda",
    label: "No public affection",
    description: "",
    kind: "social_rule" as const,
    triggers: ["public_display"],
    severity: 70, // shunning → intensity 8
    reactionOverrides: [],
  };
  function setup() {
    const player = participant("p-player", "Brian", "loc-kitchen", { isUser: true, role: "player" });
    const maya = participant("p-maya", "Maya", "loc-kitchen", { role: "npc" });
    maya.snapshot.tags = ["prudish"];
    const rhett = participant("p-rhett", "Rhett", "loc-kitchen", { role: "npc" });
    const parts: WorkingParticipant[] = [player, maya, rhett];
    const relationships = [
      { fromParticipantId: "p-maya", toParticipantId: "p-player", kind: "feeling" as const, value: 0, stage: "stranger" },
      { fromParticipantId: "p-rhett", toParticipantId: "p-player", kind: "feeling" as const, value: 0, stage: "stranger" },
    ];
    return { parts, relationships };
  }

  it("folds a witness→player dislike when the player breaches a card, plus a directive", () => {
    const { parts, relationships } = setup();
    const result = planCardBreachReactions(
      [{ cardId: "no-pda", concept: "public_display", byName: "Brian", witnessNames: ["Maya"] }],
      parts,
      relationships,
      [card],
    );
    expect(result.directives[0]).toContain("No public affection");
    expect(result.directives[0]).toContain("Maya");
    expect(result.updates).toHaveLength(1);
    const [first] = result.updates;
    expect(first).toMatchObject({ fromParticipantId: "p-maya", toParticipantId: "p-player", kind: "feeling" });
    expect(first?.delta ?? 0).toBeLessThan(0);
    expect(result.ownedEdgeKeys.has("p-maya::p-player::feeling")).toBe(true);
  });

  it("emits a directive but no affinity fold when the breacher is an NPC", () => {
    const { parts, relationships } = setup();
    const result = planCardBreachReactions(
      [{ cardId: "no-pda", concept: "public_display", byName: "Rhett", witnessNames: ["Maya"] }],
      parts,
      relationships,
      [card],
    );
    expect(result.directives).toHaveLength(1);
    expect(result.updates).toHaveLength(0);
  });

  it("degrades to nothing for an unknown card id", () => {
    const { parts, relationships } = setup();
    const result = planCardBreachReactions(
      [{ cardId: "ghost", concept: "public_display", byName: "Brian", witnessNames: ["Maya"] }],
      parts,
      relationships,
      [card],
    );
    expect(result.updates).toHaveLength(0);
    expect(result.directives).toHaveLength(0);
  });
});

describe("all-agents-null degradation", () => {
  it("still advances the clock, applies drift, and plans a synthetic episode", async () => {
    const narration = "A long quiet beat settles over the kitchen. ".repeat(20);
    const { plan: p, sink, bundle } = await plan({}, results(), { narration });
    expect(p.minutes).toBe(FALLBACK_MINUTES_ADVANCED);
    expect(p.clockMinutes).toBe(FALLBACK_MINUTES_ADVANCED);
    // hygiene drifts -0.04/h → 30 min = -0.02 from 0.9
    const maya = p.participants.find((x) => x.id === "p-maya");
    expect(maya?.state.meters["hygiene"]).toBeCloseTo(0.88, 5);
    expect(p.syntheticEpisode).toBe(true);
    expect(p.episodeSummary.length).toBeLessThanOrEqual(300);
    expect(p.episodeSummary.startsWith("A long quiet beat")).toBe(true);
    expect(codes(sink)).toContain("merge.episode.synthetic");
    expect(codes(sink)).toContain("merge.simulant.degraded");
    expect(p.brief.sceneSummary).toBe(p.episodeSummary);
    // runtime camera tracking still applies
    expect(p.runtime.visitedLocationIds).toContain("loc-kitchen");
    expect(p.runtime.encounteredParticipantIds).toContain("p-maya");
    expect(bundle.runtime.visitedLocationIds).toEqual([]); // input not mutated
  });

  it("syntheticEpisodeSummary degrades cleanly on empty narration", () => {
    expect(syntheticEpisodeSummary("")).toBe("(turn completed without narration)");
  });
});

// ---------------------------------------------------------------------------
// Reconcile mode
// ---------------------------------------------------------------------------

describe("reconcile mode", () => {
  it("applies end-state changes without advancing the clock or drifting meters", async () => {
    const bundle = makeBundle({ clockMinutes: 200 });
    bundle.session.clockMinutes = 200;
    const sink = new DiagnosticCollector();
    const p = await planTurnEffects({
      bundle,
      turn: makeTurn({ number: 3 }),
      results: results({
        simulant: simulant({
          minutesAdvanced: 90,
          movements: [{ participantName: "Maya", toLocationName: "Garden" }],
        }),
        archivist: { episodeSummary: "Edited summary.", facts: [], supersedeHints: [] },
      }),
      sink,
      mode: "reconcile",
    });
    expect(p.minutes).toBe(0);
    expect(p.clockMinutes).toBe(200);
    expect(p.participants.find((x) => x.id === "p-maya")?.locationId).toBe("loc-garden");
    expect(p.participants.find((x) => x.id === "p-maya")?.state.meters["hygiene"]).toBeCloseTo(0.9, 5);
    expect(p.episodeSummary).toBe("Edited summary.");
    expect(p.brief).toBe(bundle.brief); // untouched: nothing dropped, no thresholds crossed
    expect(p.touchedThreadIds).toEqual([]);
  });

  it("folds dropped events and crossed meter thresholds into the brief", async () => {
    const bundle = makeBundle();
    bundle.brief = { ...emptyBrief(), sceneSummary: "Prior scene.", directives: ["Keep it slow."] };
    const sink = new DiagnosticCollector();
    const p = await planTurnEffects({
      bundle,
      turn: makeTurn({ number: 3 }),
      results: results({
        simulant: simulant({
          // Attic is not adjacent to the Kitchen → dropped with a correction.
          movements: [{ participantName: "Maya", toLocationName: "Attic" }],
          // stress 0.15 + 0.7 = 0.85 crosses the >0.6 threshold.
          meterAdjustments: [{ participantName: "Maya", meterId: "stress", delta: 0.7 }],
        }),
        archivist: { episodeSummary: "Edited summary.", facts: [], supersedeHints: [] },
      }),
      sink,
      mode: "reconcile",
    });
    expect(codes(sink)).toContain("merge.movement.invalid");
    expect(p.brief.droppedEvents).toEqual(["Maya Brennan did not actually move to Attic (not adjacent)."]);
    expect(p.brief.directives).toContain("Keep it slow.");
    expect(p.brief.directives.some((d) => d.startsWith("Maya Brennan: On edge"))).toBe(true);
    // Everything else carries forward untouched — director/continuity never ran.
    expect(p.brief.sceneSummary).toBe("Prior scene.");
    expect(p.droppedEvents).toEqual(p.brief.droppedEvents);
  });
});

describe("reconcileBrief", () => {
  const prior = { ...emptyBrief(), sceneSummary: "Prior.", directives: ["Slow."], droppedEvents: ["Old drop."] };

  it("returns the prior brief by identity when there is nothing to fold", () => {
    expect(reconcileBrief(prior, [], [])).toBe(prior);
  });

  it("appends dropped events and caps folded threshold hints", () => {
    const brief = reconcileBrief(prior, ["New drop.", "Old drop."], ["Maya: hint one", "Maya: hint two", "Maya: beyond cap"]);
    expect(brief.droppedEvents).toEqual(["Old drop.", "New drop."]); // deduped, prior kept
    expect(brief.directives).toContain("Slow.");
    expect(brief.directives).toContain("Maya: hint one");
    expect(brief.directives).toContain("Maya: hint two");
    expect(brief.directives).not.toContain("Maya: beyond cap"); // THRESHOLD_HINT_CAP = 2
    expect(brief.sceneSummary).toBe("Prior.");
  });
});

// ---------------------------------------------------------------------------
// Director-driven plan integration
// ---------------------------------------------------------------------------

describe("director integration", () => {
  it("threads from signals reach the episode plan and the brief", async () => {
    const runtime = { ...emptySessionRuntime(), storyThreads: [thread({ id: "th1", title: "The letter" })] };
    const { plan: p } = await plan(
      { runtime },
      results({
        simulant: simulant(),
        archivist: { episodeSummary: "Maya found the letter.", facts: [], supersedeHints: [] },
        director: director({
          sceneSummary: "Maya holds the letter.",
          threadSignals: { touch: [{ id: "th1", title: "The letter" }], develop: [], propose: [], resolve: [] },
        }),
      }),
    );
    expect(p.touchedThreadIds).toEqual(["th1"]);
    expect(p.episodeSummary).toBe("Maya found the letter.");
    expect(p.syntheticEpisode).toBe(false);
    expect(p.brief.sceneSummary).toBe("Maya holds the letter.");
    expect(p.runtime.storyThreads[0]?.lastTouchedTurn).toBe(5);
  });

  it("grounds fact subjects to participants and keeps unresolved subjects ungrounded", async () => {
    const { plan: p } = await plan(
      {},
      results({
        archivist: {
          episodeSummary: "ep",
          facts: [
            { kind: "relationship", subjectName: "Maya", subjectKind: "character", text: "Maya trusts Brian.", tags: [], confidence: 0.9 },
            { kind: "knowledge", subjectName: "The Stranger", subjectKind: "character", text: "Unknown.", tags: [], confidence: 0.8 },
          ],
          supersedeHints: [],
        },
      }),
    );
    expect(p.factDrafts[0]?.subjectId).toBe("p-maya");
    expect(p.factDrafts[1]?.subjectId).toBeNull();
  });
});

describe("stagedLocationAnchor", () => {
  // Pre-turn prompt assembly and the post-turn continuity audit share this
  // anchor — drift between them flags characters the narrator was rightly
  // told are Present (followups.phase2.md #13).
  it("stages an adjacent room on a player enter intent", () => {
    const anchor = stagedLocationAnchor(makeBundle(), "I walk into the garden.", "player");
    expect(anchor.staged?.id).toBe("loc-garden");
    expect(anchor.blocked).toBeNull();
  });

  it("stages nothing for non-adjacent rooms, non-player authors, OOC input, or plain turns", () => {
    expect(stagedLocationAnchor(makeBundle(), "I walk into the attic.", "player").staged).toBeNull();
    expect(stagedLocationAnchor(makeBundle(), "I walk into the garden.", "companion").staged).toBeNull();
    expect(stagedLocationAnchor(makeBundle(), "(OOC: can I go to the garden?)", "player").staged).toBeNull();
    expect(stagedLocationAnchor(makeBundle(), "I look around.", "player").staged).toBeNull();
  });

  it("reports the blocked threshold instead of staging when the way is locked", () => {
    const bundle = makeBundle({
      links: [{ fromId: "loc-kitchen", toId: "loc-garden", label: null, access: { kind: "locked" } }],
    });
    const anchor = stagedLocationAnchor(bundle, "I walk into the garden.", "player");
    expect(anchor.staged).toBeNull();
    expect(anchor.blocked?.target.id).toBe("loc-garden");
    expect(anchor.blocked?.reason).toContain("locked");
  });
});

describe("director-staged movement", () => {
  // Rhett starts in the Garden; the Garden is one adjacent hop from the
  // (player-occupied) Kitchen, so an intent to the Kitchen arrives in one tick.
  const stagedIntent = (over: Partial<StagedIntent> = {}): StagedIntent =>
    stagedIntentSchema.parse({
      id: "si-rhett",
      participantId: "p-rhett",
      destinationLocationId: "loc-kitchen",
      onArrival: { comms: { kind: "text", gist: "locked out, can I use your phone?" } },
      openedAtTurn: 1,
      expiresInTurns: 6,
      ...over,
    });
  const rhettAt = (p: { participants: WorkingParticipant[] }) => p.participants.find((x) => x.id === "p-rhett")?.locationId;

  it("opens an intent from the director's stageMovement (names → ids); the first hop waits for next turn", async () => {
    const { plan: p } = await plan(
      {},
      results({
        director: director({
          stageMovement: {
            stage: [{ npcName: "Rhett", destinationName: "Kitchen", reason: "coming over", onArrivalComms: { kind: "text", gist: "on my way", urgency: "normal" } }],
            cancel: [],
          },
        }),
      }),
    );
    expect(p.runtime.stagedIntents).toHaveLength(1);
    expect(p.runtime.stagedIntents[0]).toMatchObject({ participantId: "p-rhett", destinationLocationId: "loc-kitchen", status: "active" });
    expect(rhettAt(p)).toBe("loc-garden"); // created this turn ⇒ has not set out yet
  });

  it("drops a stage signal naming an unknown NPC or location", async () => {
    const { plan: p, sink } = await plan(
      {},
      results({ director: director({ stageMovement: { stage: [{ npcName: "Nobody", destinationName: "Kitchen", reason: "" }], cancel: [] } }) }),
    );
    expect(p.runtime.stagedIntents).toEqual([]);
    expect(codes(sink)).toContain("merge.movement.intent_unresolved");
  });

  it("advances a pending intent one hop, then on arrival fires pendingComms + a directive and prunes it", async () => {
    const { plan: p } = await plan(
      {
        runtime: {
          ...emptySessionRuntime(),
          stagedIntents: [
            stagedIntent({ onArrival: { comms: { kind: "text", gist: "locked out, can I use your phone?", urgency: "normal" }, directive: "Rhett is at the door, locked out." } }),
          ],
        },
      },
      results({}),
    );
    expect(rhettAt(p)).toBe("loc-kitchen"); // walked the one hop and arrived
    expect(p.runtime.stagedIntents).toEqual([]); // resolved on arrival
    expect(p.runtime.pendingComms).toEqual([
      { fromParticipantId: "p-rhett", kind: "text", gist: "locked out, can I use your phone?", urgency: "normal" },
    ]);
    expect(p.brief.directives).toContain("Rhett is at the door, locked out.");
    expect(p.brief.arrivals.some((a) => a.includes("Rhett"))).toBe(true); // staged into the player's room
  });

  it("cancels a pending intent whose destination is unreachable, without marching at the wall", async () => {
    const { plan: p, sink } = await plan(
      { runtime: { ...emptySessionRuntime(), stagedIntents: [stagedIntent({ destinationLocationId: "loc-attic" })] } },
      results({}),
    );
    expect(p.runtime.stagedIntents).toEqual([]);
    expect(rhettAt(p)).toBe("loc-garden");
    expect(codes(sink)).toContain("merge.movement.unreachable");
  });

  it("cancels a pending intent by id on the director's signal", async () => {
    const { plan: p } = await plan(
      { runtime: { ...emptySessionRuntime(), stagedIntents: [stagedIntent({ id: "si-x" })] } },
      results({ director: director({ stageMovement: { stage: [], cancel: ["si-x"] } }) }),
    );
    expect(p.runtime.stagedIntents).toEqual([]);
    expect(rhettAt(p)).toBe("loc-garden");
  });

  it("commitment: a staged NPC is not yanked away by their schedule that turn", async () => {
    const rhett = participant("p-rhett", "Rhett", "loc-garden", { role: "npc" });
    rhett.snapshot.schedule = [{ startMinute: 0, endMinute: 1439, locationName: "Attic", activity: "brooding" }];
    const participants = [
      participant("p-player", "Brian", "loc-kitchen", { isUser: true, role: "player" }),
      participant("p-maya", "Maya Brennan", "loc-kitchen", { role: "companion", aliases: ["May"] }),
      rhett,
    ];
    const { plan: p } = await plan(
      { participants, runtime: { ...emptySessionRuntime(), stagedIntents: [stagedIntent()] } },
      results({}),
    );
    // The intent (→ Kitchen) wins over the schedule (→ Attic).
    expect(rhettAt(p)).toBe("loc-kitchen");
  });
});

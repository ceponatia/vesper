import { describe, expect, it } from "vitest";
import {
  emptyBrief,
  emptyCharacterProfile,
  emptyItemInstanceState,
  emptySceneGenState,
  emptySessionRuntime,
  emptyWorldLore,
  emptyWorldStyle,
  itemDefinitionSchema,
  participantStateSchema,
  storyThreadSchema,
  type ItemDefinition,
} from "@/contracts";
import type { BundleItem, BundleParticipant, SessionBundle } from "@/server/engine";
import { buildStatusPayload, parseClockDelta } from "./status-payload";

function participant(overrides: Partial<BundleParticipant>): BundleParticipant {
  return {
    id: "p1",
    displayName: "Someone",
    isUser: false,
    role: "npc",
    tier: "minor",
    locationId: null,
    characterId: null,
    avatarImageId: null,
    snapshot: emptyCharacterProfile(),
    state: participantStateSchema.parse({}),
    ...overrides,
  };
}

function item(overrides: Partial<BundleItem> & { definition: ItemDefinition }): BundleItem {
  return {
    id: "i1",
    name: overrides.definition.name,
    itemId: null,
    holderParticipantId: null,
    worn: false,
    locationId: null,
    containerInstanceId: null,
    positionNote: null,
    state: emptyItemInstanceState(),
    ...overrides,
  };
}

const def = (raw: Record<string, unknown>): ItemDefinition => itemDefinitionSchema.parse(raw);

function fakeBundle(): SessionBundle {
  const player = participant({ id: "player", displayName: "Brian", isUser: true, role: "player", locationId: "kitchen" });
  const maya = participant({
    id: "maya",
    displayName: "Maya",
    role: "companion",
    tier: "major",
    locationId: "kitchen",
    avatarImageId: "img-maya",
    state: participantStateSchema.parse({
      activity: "cooking",
      posture: "standing",
      meters: { energy: 0.5 },
      conditions: [
        { id: "c-active", label: "soaked", severity: "minor", startedAtMinutes: 50 },
        { id: "c-expired", label: "winded", startedAtMinutes: 0, durationMinutes: 30 },
        { id: "c-timed", label: "tipsy", startedAtMinutes: 40, durationMinutes: 60 },
      ],
    }),
  });

  const dress = item({
    id: "dress",
    definition: def({ kind: "clothing", name: "sundress", coverage: ["torso"], layer: 2, opacity: "opaque" }),
    holderParticipantId: "maya",
    worn: true,
  });
  const bra = item({
    id: "bra",
    definition: def({ kind: "clothing", name: "bra", coverage: ["chest"], layer: 0, opacity: "opaque" }),
    holderParticipantId: "maya",
    worn: true,
  });
  const lantern = item({
    id: "lantern",
    definition: def({ kind: "object", name: "lantern" }),
    holderParticipantId: "maya",
  });
  const chest = item({
    id: "chest",
    definition: def({ kind: "container", name: "oak chest" }),
    locationId: "kitchen",
    state: { ...emptyItemInstanceState(), open: true },
  });
  const tin = item({
    id: "tin",
    definition: def({ kind: "container", name: "biscuit tin" }),
    locationId: "kitchen",
    state: { ...emptyItemInstanceState(), open: false },
  });
  const coin = item({
    id: "coin",
    definition: def({ kind: "object", name: "old coin" }),
    containerInstanceId: "chest",
  });
  const rake = item({
    id: "rake",
    definition: def({ kind: "object", name: "rake" }),
    locationId: "garden",
  });

  return {
    relationships: [],
    session: {
      id: "s1",
      ownerId: "u1",
      worldId: "w1",
      title: "Test session",
      embodied: true,
      status: "ready",
      clockMinutes: 60,
    },
    world: { id: "w1", ownerId: "u1", name: "Testworld", description: "", narrativeModel: "" },
    participants: [player, maya],
    locations: [
      { id: "kitchen", name: "Kitchen", description: "Warm.", ambient: { scent: "bread" }, locationId: null, emergent: false },
      { id: "garden", name: "Garden", description: "", ambient: {}, locationId: null, emergent: false },
    ],
    links: [{ fromId: "kitchen", toId: "garden", label: null }],
    items: [dress, bra, lantern, chest, tin, coin, rake],
    loreChunks: [],
    style: emptyWorldStyle(),
    lore: emptyWorldLore(),
    runtime: {
      ...emptySessionRuntime(),
      storyThreads: [
        storyThreadSchema.parse({ id: "t-open", title: "The missing brother", status: "open" }),
        storyThreadSchema.parse({ id: "t-resolved", title: "Done", status: "resolved" }),
      ],
    },
    brief: emptyBrief(),
    scene: emptySceneGenState(),
    clockMinutes: 60,
  };
}

describe("buildStatusPayload", () => {
  const payload = buildStatusPayload(fakeBundle(), {
    latestSceneImageId: "img-scene",
    sceneGallery: [{ id: "img-old", createdAt: new Date("2026-01-01") }, { id: "img-scene", createdAt: new Date("2026-01-02") }],
    narrativeModel: "aion-labs/aion-2.0",
    clockDelta: { minutes: 20, cause: "shower" },
  });

  it("shapes session, clock, and exposure", () => {
    expect(payload.session).toEqual({
      id: "s1",
      title: "Test session",
      status: "ready",
      embodied: true,
      worldId: "w1",
      worldName: "Testworld",
      narrativeModel: "aion-labs/aion-2.0",
    });
    // default calendar start 8:00 + 60 minutes
    expect(payload.clock.minutes).toBe(60);
    expect(payload.clock.display).toContain("9:00am");
    // The authored calendar anchor must ship — without it the client
    // falls back to DEFAULT_CALENDAR_START and renders the wrong date
    // (followups.phase2.md #2).
    expect(payload.clock.calendarStart).toEqual(fakeBundle().style.calendarStart);
    expect(payload.clock.delta).toEqual({ minutes: 20, cause: "shower" });
    expect(payload.exposure).toEqual(emptyBrief().exposure);
  });

  it("resolves wardrobe visibility and excludes hidden layers", () => {
    const maya = payload.participants.find((p) => p.id === "maya");
    expect(maya).toBeDefined();
    expect(maya?.wardrobe).toEqual([{ instanceId: "dress", name: "sundress", visibility: "visible" }]);
    expect(maya?.held).toEqual([{ id: "lantern", name: "lantern", kind: "object" }]);
    expect(maya?.activity).toBe("cooking");
    expect(maya?.posture).toBe("standing");
    expect(maya?.meters["energy"]).toBe(0.5);
    expect(maya?.locationName).toBe("Kitchen");
    expect(maya?.avatarImageId).toBe("img-maya");
  });

  it("ships the complete worn list with hidden layers for the expanded cast card", () => {
    const maya = payload.participants.find((p) => p.id === "maya");
    // wornFull carries every layer (hidden included); wardrobe stays filtered.
    expect(maya?.wornFull).toEqual([
      { instanceId: "dress", name: "sundress", visibility: "visible" },
      { instanceId: "bra", name: "bra", visibility: "hidden" },
    ]);
    expect(maya?.wardrobe.map((w) => w.instanceId)).toEqual(["dress"]);
  });

  it("carries each participant's tier for the cast-tab chip", () => {
    expect(payload.participants.find((p) => p.id === "maya")?.tier).toBe("major");
    expect(payload.participants.find((p) => p.id === "player")?.tier).toBe("minor"); // straight from the bundle
  });

  it("filters expired conditions and carries remaining minutes on timed ones", () => {
    const maya = payload.participants.find((p) => p.id === "maya");
    expect(maya?.conditions).toEqual([
      // Open-ended: no remainingMinutes key at all.
      { id: "c-active", label: "soaked", severity: "minor" },
      // Timed: 40 + 60 − clock 60 = 40 game minutes left.
      { id: "c-timed", label: "tipsy", remainingMinutes: 40 },
    ]);
  });

  it("describes the active location with loose items and open containers", () => {
    expect(payload.location?.id).toBe("kitchen"); // the embodied player's location
    expect(payload.location?.name).toBe("Kitchen");
    expect(payload.location?.items.map((i) => i.id).sort()).toEqual(["chest", "tin"]);
    expect(payload.location?.openContainers).toEqual([
      { id: "chest", name: "oak chest", contents: [{ id: "coin", name: "old coin", kind: "object" }] },
    ]);
  });

  it("renders no delta when the latest turn has none (old turns)", () => {
    const withoutDelta = buildStatusPayload(fakeBundle(), {
      latestSceneImageId: null,
      sceneGallery: [],
      narrativeModel: "aion-labs/aion-2.0",
      clockDelta: null,
    });
    expect(withoutDelta.clock.delta).toBeNull();
  });

  it("carries scene-gen state with the latest image id and only open threads", () => {
    expect(payload.sceneGen.latestImageId).toBe("img-scene");
    expect(payload.sceneGen.gallery.map((g) => g.id)).toEqual(["img-old", "img-scene"]);
    expect(payload.sceneGen.status).toBe("idle");
    expect(payload.threads.map((t) => t.id)).toEqual(["t-open"]);
  });
});

describe("parseClockDelta", () => {
  it("reads the clock blob a merge wrote into agentResults", () => {
    expect(parseClockDelta({ simulant: {}, clock: { minutes: 20, cause: "shower" } })).toEqual({
      minutes: 20,
      cause: "shower",
    });
  });

  it("degrades to null on old turns and garbage blobs", () => {
    expect(parseClockDelta({ simulant: {} })).toBeNull(); // pre-clock turn
    expect(parseClockDelta(null)).toBeNull();
    expect(parseClockDelta("not json")).toBeNull();
    expect(parseClockDelta({ clock: { minutes: 0, cause: "scene" } })).toBeNull(); // never "+0m"
    expect(parseClockDelta({ clock: { minutes: "20", cause: "shower" } })).toBeNull();
  });

  it("tolerates a missing cause", () => {
    expect(parseClockDelta({ clock: { minutes: 5 } })).toEqual({ minutes: 5, cause: "" });
  });
});

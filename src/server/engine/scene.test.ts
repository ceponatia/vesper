import { describe, expect, it } from "vitest";
import { initialMeters } from "@/contracts/meters/registry";
import { emptyBrief } from "@/contracts/state/brief";
import { participantStateSchema, type ParticipantState } from "@/contracts/state/participant-state";
import { emptySessionRuntime } from "@/contracts/state/session-runtime";
import { itemDefinitionSchema, type ItemDefinition } from "@/contracts/items/item";
import {
  characterProfileSchema,
  emptyWorldLore,
  emptyWorldStyle,
  type CharacterProfile,
} from "@/contracts/world/profile";
import { activeLocationId } from "./bundle";
import {
  buildAbsenceNotice,
  buildAffordancesBlock,
  buildCanonicalFactsBlock,
  buildFollowGuidance,
  buildGlanceImpressions,
  buildMeterConditionBlock,
  buildPresenceRoster,
  buildRelationshipBlock,
  buildSceneSnapshot,
  buildTurnDigest,
  buildWardrobeBlock,
  computeFollowScores,
  effectiveMeterDefinitions,
  excerptBio,
  scaleFramingLine,
  type LocationScale,
  type RelationshipBlockInput,
  type SceneBundleInput,
  type SceneItemInput,
} from "./scene";

function profile(over: Partial<CharacterProfile> = {}): CharacterProfile {
  return characterProfileSchema.parse(over);
}

function state(over: Record<string, unknown> = {}): ParticipantState {
  return participantStateSchema.parse({ meters: initialMeters(), ...over });
}

function def(over: Partial<ItemDefinition> & { kind: ItemDefinition["kind"]; name: string }): ItemDefinition {
  return itemDefinitionSchema.parse(over);
}

function instance(over: Partial<SceneItemInput> & { id: string; name: string; definition: ItemDefinition }): SceneItemInput {
  return {
    holderParticipantId: null,
    worn: false,
    locationId: null,
    containerInstanceId: null,
    state: { condition: 1, cleanliness: 1, wetness: 0, notes: [] },
    ...over,
  };
}

function makeBundle(over: Partial<SceneBundleInput> = {}): SceneBundleInput {
  const sundress = instance({
    id: "it_dress",
    name: "linen sundress",
    definition: def({
      kind: "clothing",
      name: "linen sundress",
      coverage: ["chest", "waist", "hips"],
      layer: 2,
      sensory: { appearance: "soft cream linen", scent: "sun-dried cotton" },
    }),
    holderParticipantId: "p_maya",
    worn: true,
  });
  const bra = instance({
    id: "it_bra",
    name: "lace bra",
    definition: def({ kind: "clothing", name: "lace bra", coverage: ["chest"], layer: 0 }),
    holderParticipantId: "p_maya",
    worn: true,
  });
  const lantern = instance({
    id: "it_lantern",
    name: "lantern",
    definition: def({ kind: "object", name: "lantern" }),
    locationId: "loc_kitchen",
    positionNote: "on the table",
  });
  const dresser = instance({
    id: "it_dresser",
    name: "dresser",
    definition: def({ kind: "container", name: "dresser" }),
    locationId: "loc_kitchen",
    state: { condition: 1, cleanliness: 1, wetness: 0, open: false, notes: [] },
  });
  const shirt = instance({
    id: "it_shirt",
    name: "flannel shirt",
    definition: def({ kind: "clothing", name: "flannel shirt", coverage: ["torso"], layer: 1 }),
    containerInstanceId: "it_dresser",
  });
  const basket = instance({
    id: "it_basket",
    name: "wicker basket",
    definition: def({ kind: "object", name: "wicker basket" }),
    holderParticipantId: "p_maya",
  });

  return {
    participants: [
      {
        id: "p_brian",
        displayName: "Brian",
        isUser: true,
        role: "player",
        locationId: "loc_kitchen",
        snapshot: profile(),
        state: state(),
      },
      {
        id: "p_maya",
        displayName: "Maya",
        isUser: false,
        role: "companion",
        locationId: "loc_kitchen",
        snapshot: profile({
          bio: "Maya grew up on the coast and fears deep water. She runs the inn alone. She bakes when nervous, which is often.",
          attributes: [
            { id: "identity.apparent_age", value: "mid_twenties", source: "creation" },
            { id: "hair.color", value: "auburn", source: "creation" },
          ],
        }),
        state: state({ activity: "cooking dinner", posture: "standing at the stove" }),
      },
      {
        id: "p_rhett",
        displayName: "Rhett",
        isUser: false,
        role: "npc",
        locationId: "loc_garden",
        snapshot: profile(),
        state: state(),
      },
    ],
    locations: [
      {
        id: "loc_kitchen",
        name: "Kitchen",
        description: "A narrow farmhouse kitchen. Copper pans hang over the stove.",
        ambient: { scent: "rosemary and woodsmoke" },
      },
      { id: "loc_garden", name: "Garden", description: "An overgrown garden.", ambient: {} },
    ],
    links: [{ fromId: "loc_kitchen", toId: "loc_garden", label: "back door" }],
    items: [sundress, bra, lantern, dresser, shirt, basket],
    style: emptyWorldStyle(),
    lore: emptyWorldLore(),
    runtime: emptySessionRuntime(),
    brief: emptyBrief(),
    clockMinutes: 30,
    ...over,
  };
}

describe("buildSceneSnapshot", () => {
  it("renders the full block on first visit", () => {
    const block = buildSceneSnapshot(makeBundle(), "loc_kitchen");
    expect(block).toContain("## Scene: Kitchen (first visit");
    expect(block).toContain("Copper pans hang over the stove.");
    expect(block).toContain("scent — rosemary and woodsmoke");
    expect(block).toContain("Items here: lantern (on the table)");
    expect(block).toContain("Container: dresser (closed — contents not visible)");
    expect(block).toContain("Exits (adjacent only): Garden (back door)");
  });

  it("compresses to a one-line summary on revisits", () => {
    const bundle = makeBundle({
      runtime: { ...emptySessionRuntime(), visitedLocationIds: ["loc_kitchen"] },
    });
    const block = buildSceneSnapshot(bundle, "loc_kitchen");
    expect(block).toContain("## Scene: Kitchen (familiar");
    expect(block).toContain("A narrow farmhouse kitchen.");
    expect(block).not.toContain("Copper pans");
    expect(block).toContain("Exits (adjacent only): Garden (back door)");
  });

  it("re-establishes the room when forceFull is set (enter intent)", () => {
    const bundle = makeBundle({
      runtime: { ...emptySessionRuntime(), visitedLocationIds: ["loc_kitchen"] },
    });
    expect(buildSceneSnapshot(bundle, "loc_kitchen", { forceFull: true })).toContain("first visit");
  });

  it("shows open-container contents and hides closed ones", () => {
    const bundle = makeBundle();
    const dresser = bundle.items.find((i) => i.id === "it_dresser");
    if (dresser) dresser.state = { ...dresser.state, open: true };
    const block = buildSceneSnapshot(bundle, "loc_kitchen");
    expect(block).toContain("dresser (open — containing: flannel shirt)");
  });

  it("returns an empty string for an unknown location", () => {
    expect(buildSceneSnapshot(makeBundle(), "loc_missing")).toBe("");
    expect(buildSceneSnapshot(makeBundle(), null)).toBe("");
  });
});

describe("scale framing line (T10)", () => {
  const withScale = (scale: LocationScale | undefined) => {
    const bundle = makeBundle();
    const kitchen = bundle.locations.find((l) => l.id === "loc_kitchen");
    if (kitchen) kitchen.scale = scale;
    return bundle;
  };

  it("renders one strictly-physical size line per scale", () => {
    expect(scaleFramingLine("intimate")).toBe("Size: an intimate space; a few steps span it.");
    expect(scaleFramingLine("hall")).toContain("hall");
    expect(scaleFramingLine("open")).toContain("open");
    expect(scaleFramingLine("expanse")).toContain("expanse");
    for (const scale of ["intimate", "hall", "open", "expanse"] as const) {
      const block = buildSceneSnapshot(withScale(scale), "loc_kitchen");
      expect(block).toContain(scaleFramingLine(scale));
    }
  });

  it("default room (and absent scale) renders no size line", () => {
    expect(scaleFramingLine("room")).toBe("");
    expect(scaleFramingLine(undefined)).toBe("");
    expect(buildSceneSnapshot(withScale("room"), "loc_kitchen")).not.toContain("Size:");
    expect(buildSceneSnapshot(withScale(undefined), "loc_kitchen")).not.toContain("Size:");
  });

  it("never asserts staging or proximity state (entry default is `apart` — prose must not contradict it)", () => {
    for (const scale of ["intimate", "room", "hall", "open", "expanse"] as const) {
      const line = scaleFramingLine(scale).toLowerCase();
      expect(line).not.toMatch(/close by default|people here are close|everyone is close|huddled/);
    }
  });

  it("rides revisit summaries too, so size rulings stay consistent", () => {
    const bundle = withScale("intimate");
    bundle.runtime = { ...bundle.runtime, visitedLocationIds: ["loc_kitchen"] };
    expect(buildSceneSnapshot(bundle, "loc_kitchen")).toContain("Size: an intimate space; a few steps span it.");
  });
});

describe("buildWardrobeBlock", () => {
  it("lists visible items and omits hidden layers entirely", () => {
    const block = buildWardrobeBlock(makeBundle());
    expect(block).toContain("## Visible wardrobe (sole authority");
    expect(block).toContain("- Maya: linen sundress");
    expect(block).not.toContain("lace bra"); // hidden under opaque dress
    expect(block).toContain("- Rhett: nothing visibly worn");
    expect(block).not.toContain("Brian"); // player wardrobe not rendered
  });

  it("marks items under sheer layers as hinted", () => {
    const bundle = makeBundle();
    const dress = bundle.items.find((i) => i.id === "it_dress");
    if (dress) dress.definition = { ...dress.definition, opacity: "sheer" };
    const block = buildWardrobeBlock(bundle);
    expect(block).toContain("hinted beneath sheer layers");
    expect(block).toContain("lace bra");
  });

  it("appends sensory snippets only when requested", () => {
    expect(buildWardrobeBlock(makeBundle())).not.toContain("soft cream linen");
    const block = buildWardrobeBlock(makeBundle(), { includeSensory: true });
    expect(block).toContain("linen sundress (soft cream linen; sun-dried cotton)");
  });
});

describe("buildCanonicalFactsBlock", () => {
  it("renders name, apparent age, and a bio excerpt per NPC", () => {
    const block = buildCanonicalFactsBlock(makeBundle());
    expect(block).toContain("## Canonical character facts (authoritative truth");
    expect(block).toContain("- Maya — appears mid twenties.");
    expect(block).toContain("Maya grew up on the coast and fears deep water.");
    expect(block).not.toContain("Brian");
  });

  it("caps the bio excerpt at a few sentences", () => {
    expect(excerptBio("One. Two. Three. Four. Five.")).toBe("One. Two. Three.");
    expect(excerptBio("")).toBe("");
  });
});

describe("buildGlanceImpressions", () => {
  it("gives a full impression on first encounter, with registry phrasing hints", () => {
    const block = buildGlanceImpressions(makeBundle(), {});
    expect(block).toContain("- Maya (first encounter — full impression)");
    expect(block).toContain("hair color: auburn");
    expect(block).toContain("apparent age: mid twenties");
    expect(block).toContain("Phrasing guidance:");
  });

  it("collapses to a one-liner once encountered", () => {
    const bundle = makeBundle({
      runtime: { ...emptySessionRuntime(), encounteredParticipantIds: ["p_maya", "p_rhett"] },
    });
    const block = buildGlanceImpressions(bundle, {});
    expect(block).toContain("- Maya — present (appearance already established");
    expect(block).not.toContain("hair color");
  });

  it("re-expands an encountered NPC who is the look target", () => {
    const bundle = makeBundle({
      runtime: { ...emptySessionRuntime(), encounteredParticipantIds: ["p_maya", "p_rhett"] },
    });
    const block = buildGlanceImpressions(bundle, { lookTarget: "Maya" });
    expect(block).toContain("- Maya (being looked at — full impression)");
    expect(block).toContain("- Rhett — present");
  });
});

describe("buildAffordancesBlock", () => {
  it("lists exits, usable items, and carried items", () => {
    const block = buildAffordancesBlock(makeBundle(), "loc_kitchen");
    expect(block).toContain("## NPC affordances");
    expect(block).toContain("Exits from Kitchen: Garden (back door)");
    expect(block).toContain("Usable items here: lantern, dresser");
    expect(block).toContain("Carried by Maya: wicker basket");
    expect(block).not.toContain("linen sundress"); // worn, not carried
  });

  it("returns an empty string without a current location", () => {
    expect(buildAffordancesBlock(makeBundle(), null)).toBe("");
  });
});

describe("buildMeterConditionBlock", () => {
  it("surfaces activity, crossed meter thresholds, and active condition hints", () => {
    const bundle = makeBundle();
    const maya = bundle.participants.find((p) => p.id === "p_maya");
    if (maya) {
      maya.state = state({
        activity: "cooking dinner",
        meters: { ...initialMeters(), hygiene: 0.2 },
        conditions: [
          {
            id: "c1",
            label: "soaked",
            severity: "moderate",
            startedAtMinutes: 0,
            durationMinutes: 60,
            promptHint: "Her clothes cling and drip.",
            attributeEffects: [],
          },
        ],
      });
    }
    const block = buildMeterConditionBlock(bundle);
    expect(block).toContain("## Current state (authoritative");
    expect(block).toContain("- Maya — activity: cooking dinner");
    expect(block).toContain("Clearly unwashed");
    expect(block).toContain("condition: soaked (moderate) — Her clothes cling and drip.");
  });

  it("omits expired conditions", () => {
    const bundle = makeBundle({ clockMinutes: 120 });
    const maya = bundle.participants.find((p) => p.id === "p_maya");
    if (maya) {
      maya.state = state({
        conditions: [{ id: "c1", label: "soaked", startedAtMinutes: 0, durationMinutes: 60, attributeEffects: [] }],
      });
    }
    expect(buildMeterConditionBlock(bundle)).not.toContain("soaked");
  });

  it("respects world meter overrides (null disables)", () => {
    const style = { ...emptyWorldStyle(), meterOverrides: { hygiene: null } };
    const defs = effectiveMeterDefinitions(style);
    expect(defs.find((d) => d.id === "hygiene")).toBeUndefined();

    const bundle = makeBundle({ style });
    const maya = bundle.participants.find((p) => p.id === "p_maya");
    if (maya) maya.state = state({ meters: { ...initialMeters(), hygiene: 0.1 } });
    expect(buildMeterConditionBlock(bundle)).not.toContain("unwashed");
  });
});

describe("follow guidance", () => {
  const baseInput = {
    playerInput: "Come on Maya, let's check the garden.",
    fromLocationName: "Kitchen",
    toLocationName: "Garden",
    npcs: [
      { displayName: "Maya", coLocated: true, activity: "idle" },
      { displayName: "Rhett", coLocated: true, activity: "working on the fence" },
      { displayName: "Far Away", coLocated: false, activity: "idle" },
    ],
    relationshipFacts: [{ subjectName: "Maya", text: "Maya trusts the player." }],
    turnsSinceInteraction: { Maya: 1 },
  };

  it("scores deterministically: warmth + recency + address up, stickiness down", () => {
    const scores = computeFollowScores(baseInput);
    expect(scores.map((s) => s.displayName)).toEqual(["Maya", "Rhett"]); // non-co-located excluded
    const maya = scores[0];
    const rhett = scores[1];
    expect(maya?.score).toBe(0.9); // 0.25 base + 0.25 addressed + 0.15 warmth + 0.25 recency
    expect(maya?.likelyFollows).toBe(true);
    expect(rhett?.score).toBe(0); // 0.25 base − 0.25 busy
    expect(rhett?.likelyFollows).toBe(false);
    expect(maya?.reasons).toContain("addressed in the player's input");
    expect(rhett?.reasons).toContain("busy: working on the fence");
  });

  it("drops scores when the player implies wanting to be alone", () => {
    const scores = computeFollowScores({
      ...baseInput,
      playerInput: "I head to the garden alone. Don't follow me, Maya.",
    });
    const maya = scores.find((s) => s.displayName === "Maya");
    expect(maya?.likelyFollows).toBe(false);
    expect(maya?.reasons).toContain("player implied wanting to be alone");
  });

  it("renders a guidance block with rules and per-NPC lines", () => {
    const block = buildFollowGuidance(baseInput);
    expect(block).toContain("## Movement guidance (player moving: Kitchen → Garden)");
    expect(block).toContain("- Maya — follow likelihood 0.90 (likely follows)");
    expect(block).toContain("- Rhett — follow likelihood 0.00 (likely stays)");
    expect(block).toContain("Never teleport NPCs");
  });

  it("notes when no NPCs are co-located", () => {
    const block = buildFollowGuidance({ ...baseInput, npcs: [{ displayName: "Far", coLocated: false, activity: "idle" }] });
    expect(block).toContain("No co-located NPCs to follow.");
  });
});

describe("buildRelationshipBlock", () => {
  function input(over: Partial<RelationshipBlockInput> = {}): RelationshipBlockInput {
    return {
      playerId: "p_brian",
      playerName: "Brian",
      presentNpcs: [{ id: "p_maya", displayName: "Maya" }],
      relationships: [],
      ...over,
    };
  }

  it("renders a stage line per present NPC: feeling plus the perceived edge (decision 41 wording)", () => {
    const block = buildRelationshipBlock(
      input({
        relationships: [
          { fromParticipantId: "p_maya", toParticipantId: "p_brian", kind: "feeling", stage: "friendly" },
          { fromParticipantId: "p_maya", toParticipantId: "p_brian", kind: "perceived", stage: "acquaintance" },
        ],
      }),
    );
    expect(block).toContain("## Relationships (present characters)");
    expect(block).toContain("- Maya: friendly toward Brian; believes Brian is acquaintance-warm toward her/him");
    expect(block).toContain("relationships move through events, not narration fiat");
  });

  it("renders feeling-only and perceived-only lines on their own", () => {
    const feelingOnly = buildRelationshipBlock(
      input({ relationships: [{ fromParticipantId: "p_maya", toParticipantId: "p_brian", kind: "feeling", stage: "close" }] }),
    );
    expect(feelingOnly).toContain("- Maya: close toward Brian");
    expect(feelingOnly).not.toContain("believes");

    const perceivedOnly = buildRelationshipBlock(
      input({ relationships: [{ fromParticipantId: "p_maya", toParticipantId: "p_brian", kind: "perceived", stage: "wary" }] }),
    );
    expect(perceivedOnly).toContain("- Maya: believes Brian is wary-warm toward her/him");
  });

  it("sparse semantics: no edges (all strangers) renders nothing", () => {
    expect(buildRelationshipBlock(input())).toBe("");
  });

  it("ignores edges owned by absent NPCs and edges not aimed at the player", () => {
    const block = buildRelationshipBlock(
      input({
        relationships: [
          // Rhett is not in presentNpcs — his edge must not render.
          { fromParticipantId: "p_rhett", toParticipantId: "p_brian", kind: "feeling", stage: "hostile" },
          // NPC ↔ NPC edge — never rendered in the player-facing block.
          { fromParticipantId: "p_maya", toParticipantId: "p_rhett", kind: "feeling", stage: "devoted" },
        ],
      }),
    );
    expect(block).toBe("");
  });
});

describe("buildPresenceRoster", () => {
  // Adds an attic two links beyond the garden: kitchen — garden — attic, with
  // Fatima placed there, so all three groups can render at once.
  function rosterBundle(over: Partial<SceneBundleInput> = {}): SceneBundleInput {
    const base = makeBundle();
    return makeBundle({
      participants: [
        ...base.participants,
        { id: "p_fatima", displayName: "Fatima", isUser: false, role: "npc", locationId: "loc_attic", snapshot: profile(), state: state() },
      ],
      locations: [...base.locations, { id: "loc_attic", name: "Attic", description: "A dusty attic.", ambient: {} }],
      links: [...base.links, { fromId: "loc_garden", toId: "loc_attic" }],
      ...over,
    });
  }

  it("groups NPCs into Present, Nearby (with location), and Elsewhere (with location)", () => {
    const block = buildPresenceRoster(rosterBundle(), "loc_kitchen");
    expect(block).toContain('## Who is where (authoritative presence roster this turn — see the "Presence fidelity" rules)');
    expect(block).toContain("Present: Maya");
    expect(block).toContain("Nearby (one room away — may join this turn ONLY if narrated physically arriving before any dialogue): Rhett (Garden)");
    expect(block).toContain("Elsewhere: Fatima (Attic)");
    expect(block).not.toContain("Brian"); // the player is never listed
  });

  it("matches adjacency in either link orientation (undirected graph)", () => {
    const reversed = rosterBundle();
    reversed.links = reversed.links.map((l) => ({ ...l, fromId: l.toId, toId: l.fromId }));
    const block = buildPresenceRoster(reversed, "loc_kitchen");
    expect(block).toContain("Rhett (Garden)");
    expect(block).toContain("Nearby");
    expect(block).toContain("Elsewhere: Fatima (Attic)");
  });

  it("omits empty groups", () => {
    const allHome = rosterBundle();
    for (const p of allHome.participants) p.locationId = "loc_kitchen";
    const block = buildPresenceRoster(allHome, "loc_kitchen");
    expect(block).toContain("Present: Maya, Rhett, Fatima");
    expect(block).not.toContain("Nearby");
    expect(block).not.toContain("Elsewhere");
  });

  it("lists an unplaced NPC as Elsewhere with location unknown", () => {
    const bundle = rosterBundle();
    const fatima = bundle.participants.find((p) => p.id === "p_fatima");
    if (fatima) fatima.locationId = null;
    expect(buildPresenceRoster(bundle, "loc_kitchen")).toContain("Elsewhere: Fatima (location unknown)");
  });

  it("renders nothing with no NPCs or no resolvable location", () => {
    const noNpcs = makeBundle({ participants: makeBundle().participants.filter((p) => p.isUser) });
    expect(buildPresenceRoster(noNpcs, "loc_kitchen")).toBe("");
    expect(buildPresenceRoster(rosterBundle(), null)).toBe("");
    expect(buildPresenceRoster(rosterBundle(), "loc_missing")).toBe("");
  });

  it("observer mode: anchors on the active location resolved without a player", () => {
    // No user participant: activeLocationId falls back to the companion's room
    // (bundle.ts), so Maya anchors the roster and is herself listed Present.
    const bundle = rosterBundle({ participants: rosterBundle().participants.filter((p) => !p.isUser) });
    const anchor = activeLocationId(bundle);
    expect(anchor).toBe("loc_kitchen");
    const block = buildPresenceRoster(bundle, anchor);
    expect(block).toContain("Present: Maya");
    expect(block).toContain("Rhett (Garden)");
    expect(block).toContain("Elsewhere: Fatima (Attic)");
  });
});

describe("buildAbsenceNotice", () => {
  const absent = [
    { displayName: "Maya Rodriguez", locationName: "Main Street" },
    { displayName: "Dr. Green", locationName: null },
  ];

  it("flags an absent NPC addressed by first name, with their whereabouts", () => {
    const block = buildAbsenceNotice({ playerInput: '"Hey Maya, got a second?"', playerName: "Brian", absentNpcs: absent });
    expect(block).toContain("## Absent characters");
    expect(block).toContain("- Maya Rodriguez is not present (currently at Main Street).");
    expect(block).not.toContain("Dr. Green");
    expect(block).toContain('"Talking to yourself again, Brian?"');
  });

  it("defers arrivals to the Presence fidelity rules instead of banning them outright", () => {
    const block = buildAbsenceNotice({ playerInput: '"Hey Maya, got a second?"', playerName: "Brian", absentNpcs: absent });
    expect(block).toContain('They may enter the scene only per the "Presence fidelity" rules');
    expect(block).toContain('listed Nearby in the "Who is where" block and narrated physically arriving before any dialogue');
  });

  it("matches quoted speech and full display names", () => {
    const block = buildAbsenceNotice({ playerInput: "I wave at Dr. Green.", playerName: "Brian", absentNpcs: absent });
    expect(block).toContain("- Dr. Green is not present.");
  });

  it("returns nothing when no absent NPC is named", () => {
    expect(buildAbsenceNotice({ playerInput: "I sit down and wait.", playerName: "Brian", absentNpcs: absent })).toBe("");
    // "Mayan" must not match "Maya"
    expect(buildAbsenceNotice({ playerInput: "I study the Mayan carving.", playerName: "Brian", absentNpcs: absent })).toBe("");
  });
});

describe("buildTurnDigest", () => {
  // Same shape as the roster fixture: kitchen — garden — attic, Fatima in the attic.
  function digestBundle(): SceneBundleInput {
    const base = makeBundle();
    return makeBundle({
      participants: [
        ...base.participants,
        { id: "p_fatima", displayName: "Fatima", isUser: false, role: "npc", locationId: "loc_attic", snapshot: profile(), state: state() },
      ],
      locations: [...base.locations, { id: "loc_attic", name: "Attic", description: "A dusty attic.", ambient: {} }],
      links: [...base.links, { fromId: "loc_garden", toId: "loc_attic" }],
    });
  }

  it("restates the roster groups as imperative allowances", () => {
    const digest = buildTurnDigest(digestBundle(), "loc_kitchen");
    expect(digest).toContain("## This turn (binding digest — each line restates an authoritative block below)");
    expect(digest).toContain("- Voice freely: Maya.");
    expect(digest).toContain("- May bring in, but only via a narrated physical arrival before their first line: Rhett (Garden).");
    expect(digest).toContain("- Never enact — discuss or quote from memory only: Fatima (Attic).");
  });

  it("adds the blocked-threshold line when staging refused a move", () => {
    const digest = buildTurnDigest(digestBundle(), "loc_kitchen", { targetName: "Garden", reason: "the way is locked" });
    expect(digest).toContain("- The way to Garden is not passable this turn (the way is locked) — play the blocked threshold; never narrate the far side.");
  });

  it("renders a blocked line even with no NPCs, and nothing when there is nothing to constrain", () => {
    const noNpcs = makeBundle({ participants: makeBundle().participants.filter((p) => p.isUser) });
    expect(buildTurnDigest(noNpcs, "loc_kitchen", { targetName: "Garden", reason: "closed at this hour" })).toContain(
      "The way to Garden is not passable",
    );
    expect(buildTurnDigest(noNpcs, "loc_kitchen")).toBe("");
    expect(buildTurnDigest(noNpcs, "loc_kitchen", null)).toBe("");
  });

  it("omits empty groups", () => {
    const allHome = digestBundle();
    for (const p of allHome.participants) p.locationId = "loc_kitchen";
    const digest = buildTurnDigest(allHome, "loc_kitchen");
    expect(digest).toContain("- Voice freely: Maya, Rhett, Fatima.");
    expect(digest).not.toContain("May bring in");
    expect(digest).not.toContain("Never enact");
  });
});

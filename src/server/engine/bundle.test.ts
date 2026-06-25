import { describe, expect, it } from "vitest";
import { itemDefinitionSchema } from "@/contracts/items/item";
import { initialMeters } from "@/contracts/meters/registry";
import { emptyBrief } from "@/contracts/state/brief";
import { participantStateSchema } from "@/contracts/state/participant-state";
import { emptySceneGenState } from "@/contracts/state/scene-gen";
import { emptySessionRuntime } from "@/contracts/state/session-runtime";
import { characterProfileSchema, worldLoreSchema, worldStyleSchema } from "@/contracts/world/profile";
import { OBSERVER_PLAYER_NAME } from "@/lib/player-token";
import { bundlePlayerName, fillBundlePlayerToken, type BundleParticipant, type SessionBundle } from "./bundle";

/**
 * fillBundlePlayerToken contract (docs/authoring.md §The {{player}} token):
 * authored-text fields substitute, identifier fields never do — even when an
 * identifier literally contains the token.
 */

function npc(): BundleParticipant {
  return {
    id: "p_maya",
    displayName: "{{player}} Fan", // identifier — must survive verbatim
    isUser: false,
    role: "companion",
    locationId: "loc_room",
    characterId: null,
    avatarImageId: null,
    tier: "major",
    snapshot: characterProfileSchema.parse({
      bio: "Knew {{player}} as a child.",
      personality: "Wary of {{ Player }}.",
      voice: "Mocks {{PLAYER}} gently.",
      schedule: [{ startMinute: 0, endMinute: 60, locationName: "{{player}}'s Room", activity: "writing to {{player}}" }],
    }),
    state: participantStateSchema.parse({ meters: initialMeters() }),
  };
}

function player(): BundleParticipant {
  return {
    id: "p_brian",
    displayName: "Brian",
    isUser: true,
    role: "player",
    locationId: "loc_room",
    characterId: null,
    avatarImageId: null,
    tier: "major",
    snapshot: characterProfileSchema.parse({ bio: "A newcomer." }),
    state: participantStateSchema.parse({ meters: initialMeters() }),
  };
}

function makeBundle(embodied: boolean): SessionBundle {
  return {
    session: {
      id: "s_1",
      ownerId: "u_1",
      worldId: "w_1",
      title: "Test",
      embodied,
      status: "ready",
      clockMinutes: 0,
    },
    world: {
      id: "w_1",
      ownerId: "u_1",
      name: "{{player}} World", // identifier-adjacent: world name is not in the substitution contract
      description: "A tale of {{player}}.",
      narrativeModel: "demo",
      agentModel: "",
    },
    participants: embodied ? [npc(), player()] : [npc()],
    locations: [
      {
        id: "loc_room",
        name: "{{player}}'s Room", // identifier — grounding name
        description: "Where {{player}} sleeps.",
        ambient: {},
        scale: "room",
        locationId: null,
        emergent: false,
      },
    ],
    links: [],
    items: [
      {
        id: "it_locket",
        name: "{{player}}'s locket", // identifier — grounding name
        itemId: null,
        definition: itemDefinitionSchema.parse({
          kind: "object",
          name: "{{player}}'s locket", // identifier — grounding name
          description: "Engraved with {{player}}'s initials.",
          sensory: { appearance: "glints when {{player}} nears", scent: "{{player}}'s cologne", tactile: "warm as {{player}}'s hand" },
        }),
        holderParticipantId: null,
        worn: false,
        locationId: "loc_room",
        containerInstanceId: null,
        positionNote: null,
        state: { condition: 1, cleanliness: 1, wetness: 0, notes: [] },
      },
    ],
    loreChunks: (["always", "scene", "retrieval"] as const).map((tier, i) => ({
      id: `lc_${tier}`,
      title: `The ballad of {{player}} (${tier})`,
      body: `Everyone in town whispers about {{ player }} — the ${tier} chunk.`,
      tier,
      visibility: "public",
      unlockTags: [],
      locationTags: [],
      characterIds: [],
      sort: i,
      manuallyUnlocked: false,
    })),
    scene: emptySceneGenState(),
    relationships: [],
    style: worldStyleSchema.parse({
      directives: ["Focus on {{player}}'s doubts.", "Keep scenes short."],
      narratorGuidance: "Speak warmly of {{ Player }}.",
      socialCards: [
        { id: "respect", label: "Nobody questions {{player}}.", description: "Glares follow {{PLAYER}}.", kind: "social_rule", triggers: [], severity: 20, reactionOverrides: [] },
      ],
    }),
    lore: worldLoreSchema.parse({ synopsis: "{{player}} arrives at dusk." }),
    runtime: emptySessionRuntime(),
    brief: emptyBrief(),
    clockMinutes: 0,
  };
}

describe("bundlePlayerName", () => {
  it("uses the is_user participant's displayName when embodied", () => {
    expect(bundlePlayerName(makeBundle(true))).toBe("Brian");
  });

  it("falls back to the observer phrase when no player row exists", () => {
    expect(bundlePlayerName(makeBundle(false))).toBe(OBSERVER_PLAYER_NAME);
  });
});

describe("fillBundlePlayerToken", () => {
  it("substitutes the player name across every authored-text field class (embodied)", () => {
    const filled = fillBundlePlayerToken(makeBundle(true));

    expect(filled.world.description).toBe("A tale of Brian.");
    expect(filled.lore.synopsis).toBe("Brian arrives at dusk.");

    expect(filled.style.directives).toEqual(["Focus on Brian's doubts.", "Keep scenes short."]);
    expect(filled.style.narratorGuidance).toBe("Speak warmly of Brian.");
    expect(filled.style.socialCards[0]).toMatchObject({ label: "Nobody questions Brian.", description: "Glares follow Brian." });

    for (const chunk of filled.loreChunks) {
      expect(chunk.title).toContain("The ballad of Brian");
      expect(chunk.body).toContain("whispers about Brian");
    }
    expect(filled.loreChunks.map((c) => c.tier)).toEqual(["always", "scene", "retrieval"]);

    expect(filled.locations[0]?.description).toBe("Where Brian sleeps.");

    const maya = filled.participants.find((p) => !p.isUser);
    expect(maya?.snapshot.bio).toBe("Knew Brian as a child.");
    expect(maya?.snapshot.personality).toBe("Wary of Brian.");
    expect(maya?.snapshot.voice).toBe("Mocks Brian gently.");

    const locket = filled.items[0];
    expect(locket?.definition.description).toBe("Engraved with Brian's initials.");
    expect(locket?.definition.sensory).toEqual({
      appearance: "glints when Brian nears",
      scent: "Brian's cologne",
      tactile: "warm as Brian's hand",
    });
  });

  it('fills "the protagonist" everywhere in an observer bundle', () => {
    const filled = fillBundlePlayerToken(makeBundle(false));

    expect(filled.world.description).toBe("A tale of the protagonist.");
    expect(filled.lore.synopsis).toBe("the protagonist arrives at dusk.");
    expect(filled.style.narratorGuidance).toBe("Speak warmly of the protagonist.");
    expect(filled.loreChunks[0]?.body).toContain("whispers about the protagonist");
    expect(filled.locations[0]?.description).toBe("Where the protagonist sleeps.");
    const maya = filled.participants.find((p) => !p.isUser);
    expect(maya?.snapshot.bio).toBe("Knew the protagonist as a child.");
    expect(filled.items[0]?.definition.description).toBe("Engraved with the protagonist's initials.");
  });

  it("never touches identifier fields, even when they contain the token", () => {
    const filled = fillBundlePlayerToken(makeBundle(true));

    expect(filled.world.name).toBe("{{player}} World");
    expect(filled.locations[0]?.name).toBe("{{player}}'s Room");
    expect(filled.items[0]?.name).toBe("{{player}}'s locket");
    expect(filled.items[0]?.definition.name).toBe("{{player}}'s locket");

    const maya = filled.participants.find((p) => !p.isUser);
    expect(maya?.displayName).toBe("{{player}} Fan");
    // schedule locationName grounds against location names; activity is outside the contract too
    expect(maya?.snapshot.schedule[0]).toMatchObject({
      locationName: "{{player}}'s Room",
      activity: "writing to {{player}}",
    });
  });

  it("returns a new bundle and leaves the input untouched", () => {
    const bundle = makeBundle(true);
    const filled = fillBundlePlayerToken(bundle);
    expect(filled).not.toBe(bundle);
    expect(bundle.world.description).toBe("A tale of {{player}}.");
    expect(bundle.loreChunks[0]?.body).toContain("{{ player }}");
  });
});

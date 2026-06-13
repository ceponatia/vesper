import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { emptyBrief } from "@/contracts/state/brief";
import { emptyParticipantState } from "@/contracts/state/participant-state";
import { emptySceneGenState } from "@/contracts/state/scene-gen";
import { emptySessionRuntime } from "@/contracts/state/session-runtime";
import { emptyCharacterProfile, emptyWorldLore, emptyWorldStyle } from "@/contracts/world/profile";
import { runPostTurnAgents } from "./agents";
import type { SessionBundle } from "./bundle";

// Tests run with AI_FAKE=1 (src/test/setup.ts): demo mode short-circuits
// before any DB or network access, so this suite is pure.

function makeBundle(): SessionBundle {
  return {
    relationships: [],
    session: { id: "s-1", ownerId: "u-1", worldId: "w-1", title: "T", embodied: true, status: "processing", clockMinutes: 0 },
    world: { id: "w-1", ownerId: "u-1", name: "Testworld", description: "", narrativeModel: "" },
    participants: [
      {
        id: "p-player",
        displayName: "Brian",
        isUser: true,
        role: "player",
        tier: "major",
        locationId: "loc-kitchen",
        characterId: null,
        avatarImageId: null,
        snapshot: emptyCharacterProfile(),
        state: emptyParticipantState(),
      },
      {
        id: "p-maya",
        displayName: "Maya",
        isUser: false,
        role: "companion",
        tier: "major",
        locationId: "loc-kitchen",
        characterId: null,
        avatarImageId: null,
        snapshot: emptyCharacterProfile(),
        state: emptyParticipantState(),
      },
    ],
    locations: [
      { id: "loc-kitchen", name: "Kitchen", description: "", ambient: {}, locationId: null, emergent: false },
      { id: "loc-garden", name: "Garden", description: "", ambient: {}, locationId: null, emergent: false },
    ],
    links: [{ fromId: "loc-kitchen", toId: "loc-garden", label: null }],
    items: [],
    loreChunks: [],
    style: emptyWorldStyle(),
    lore: emptyWorldLore(),
    runtime: emptySessionRuntime(),
    brief: { ...emptyBrief(), storySoFar: "Two days at the inn.", memoryQueries: ["the inn"] },
    scene: emptySceneGenState(),
    clockMinutes: 0,
  };
}

describe("runPostTurnAgents (demo mode)", () => {
  it("returns all four agents non-null so the merge path matches live mode", async () => {
    const sink = new DiagnosticCollector();
    const results = await runPostTurnAgents(
      makeBundle(),
      { number: 1, author: "player", input: "I head to the Garden with Maya." },
      "You head into the garden; Maya follows.",
      { sink },
    );
    expect(results.simulant).not.toBeNull();
    expect(results.archivist).not.toBeNull();
    expect(results.continuity).not.toBeNull();
    expect(results.director).not.toBeNull();
    // demo heuristics: keyword movement for the embodied player
    expect(results.simulant?.movements).toEqual([
      expect.objectContaining({ participantName: "Brian", toLocationName: "Garden" }),
    ]);
    expect(results.archivist?.episodeSummary.length).toBeGreaterThan(0);
    expect(results.director?.storySoFar).toBe("Two days at the inn.");
  });

  it("end-state mode (reconcile) skips continuity and director", async () => {
    const results = await runPostTurnAgents(
      makeBundle(),
      { number: 2, author: "player", input: "Quiet beat." },
      "Nothing much happens.",
      { endState: true },
    );
    expect(results.simulant).not.toBeNull();
    expect(results.archivist).not.toBeNull();
    expect(results.continuity).toBeNull();
    expect(results.director).toBeNull();
  });

  it("observer mode (no embodied player) never infers player movement", async () => {
    const bundle = makeBundle();
    bundle.session.embodied = false;
    bundle.participants = bundle.participants.filter((p) => !p.isUser);
    const results = await runPostTurnAgents(
      bundle,
      { number: 1, author: "director", input: "Maya walks to the Garden." },
      "Maya wanders out.",
    );
    expect(results.simulant?.movements).toEqual([]);
  });
});

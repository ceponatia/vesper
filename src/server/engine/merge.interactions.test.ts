import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { emptyBrief } from "@/contracts/state/brief";
import { emptyParticipantState } from "@/contracts/state/participant-state";
import { emptySceneGenState } from "@/contracts/state/scene-gen";
import { emptySessionRuntime } from "@/contracts/state/session-runtime";
import type { AgentResults, SimulantResult } from "@/contracts/turns/agent-results";
import { emptyCharacterProfile, emptyWorldLore, emptyWorldStyle } from "@/contracts/world/profile";
import type { BundleParticipant, BundlePlace, SessionBundle } from "./bundle";
import { planTurnEffects, type MergeMode, type MergeTurn } from "./merge";

/**
 * Interaction bookkeeping in the merge (multi-character phase 1, pinned by
 * phase-2 T4): the witness stamp (interim co-location semantics), the
 * lastInteractedTurn runtime map (targeted interactions only — co-presence
 * never counts), and player-only registered-action matching.
 */

// ---------------------------------------------------------------------------
// Fixtures (mirrors merge.test.ts)
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

function makeBundle(overrides: Partial<SessionBundle> = {}): SessionBundle {
  const locations = [place("loc-kitchen", "Kitchen"), place("loc-garden", "Garden")];
  const participants = [
    participant("p-player", "Brian", "loc-kitchen", { isUser: true, role: "player" }),
    participant("p-maya", "Maya Brennan", "loc-kitchen", { role: "companion", aliases: ["May"] }),
    participant("p-rhett", "Rhett", "loc-garden", { role: "npc" }),
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
    links: [{ fromId: "loc-kitchen", toId: "loc-garden", label: null }],
    items: [],
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
    narration: "The kitchen holds its small sounds.",
    ...overrides,
  };
}

function simulant(overrides: Partial<SimulantResult> = {}): SimulantResult {
  return {
    minutesAdvanced: 5,
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
  return { simulant: simulant(), archivist: null, continuity: null, director: null, ...overrides };
}

async function plan(
  bundleOverrides: Partial<SessionBundle>,
  agentResults: AgentResults,
  turnOverrides: Partial<MergeTurn> = {},
  mode: MergeMode = "post_turn",
) {
  const sink = new DiagnosticCollector();
  const bundle = makeBundle(bundleOverrides);
  const merged = await planTurnEffects({ bundle, turn: makeTurn(turnOverrides), results: agentResults, sink, mode });
  return { plan: merged, sink };
}

// ---------------------------------------------------------------------------
// Witness stamping (interim co-location semantics — decision 3)
// ---------------------------------------------------------------------------

describe("witnessed_by stamping", () => {
  it("stamps the plan and every fact draft with the participants co-located with the player", async () => {
    const archivist = {
      episodeSummary: "Brian and Maya talked in the kitchen.",
      facts: [
        {
          kind: "knowledge" as const,
          subjectName: "Maya Brennan",
          subjectKind: "character" as const,
          text: "Maya fears deep water.",
          tags: [],
          confidence: 0.9,
        },
      ],
      supersedeHints: [],
    };
    const { plan: p } = await plan({}, results({ archivist }));
    // Player + Maya share the kitchen; Rhett is in the garden and saw nothing.
    expect([...p.witnessedBy].sort()).toEqual(["p-maya", "p-player"]);
    expect(p.factDrafts).toHaveLength(1);
    expect([...(p.factDrafts[0]?.witnessedBy ?? [])].sort()).toEqual(["p-maya", "p-player"]);
  });

  it("witnesses follow the player's post-move location, not the turn's starting room", async () => {
    const { plan: p } = await plan(
      {},
      results({
        simulant: simulant({
          movements: [{ participantName: "Brian", toLocationName: "Garden", reason: "walked out" }],
        }),
      }),
      { input: "I head into the garden." },
    );
    // After the move the player shares the garden with Rhett; Maya stayed behind.
    expect([...p.witnessedBy].sort()).toEqual(["p-player", "p-rhett"]);
  });
});

// ---------------------------------------------------------------------------
// lastInteractedTurn (targeted interactions only — co-presence never counts)
// ---------------------------------------------------------------------------

describe("lastInteractedTurn", () => {
  it("records an intent-detected target (a co-located NPC the player looks at)", async () => {
    const { plan: p } = await plan({}, results(), { input: "I look at Maya Brennan for a long moment." });
    expect(p.runtime.lastInteractedTurn["p-maya"]).toBe(5);
  });

  it("records the speaking NPC on companion-authored turns", async () => {
    const { plan: p } = await plan({}, results(), {
      author: "companion",
      speakerParticipantId: "p-maya",
      input: '"Tea is ready," she calls.',
    });
    expect(p.runtime.lastInteractedTurn["p-maya"]).toBe(5);
  });

  it("records a co-located NPC addressed by alias in the player's input", async () => {
    const { plan: p } = await plan({}, results(), { input: "May, could you pass the bread?" });
    expect(p.runtime.lastInteractedTurn["p-maya"]).toBe(5);
  });

  it("co-presence alone never counts", async () => {
    const { plan: p } = await plan({}, results(), { input: "I stare out the window." });
    expect(p.runtime.lastInteractedTurn).toEqual({});
  });

  it("mentioning an NPC who is not co-located does not count", async () => {
    const { plan: p } = await plan({}, results(), { input: "I wonder where Rhett went." });
    expect(p.runtime.lastInteractedTurn["p-rhett"]).toBeUndefined();
  });

  it("director-authored turns record nothing", async () => {
    const { plan: p } = await plan({}, results(), { author: "director", input: "Maya storms in, furious." });
    expect(p.runtime.lastInteractedTurn).toEqual({});
  });

  it("reconcile mode leaves the map untouched", async () => {
    const runtime = { ...emptySessionRuntime(), lastInteractedTurn: { "p-maya": 2 } };
    const { plan: p } = await plan({ runtime }, results(), { input: "Maya, look at this." }, "reconcile");
    expect(p.runtime.lastInteractedTurn).toEqual({ "p-maya": 2 });
  });

  it("overwrites the targeted NPC's entry and preserves everyone else's", async () => {
    const runtime = { ...emptySessionRuntime(), lastInteractedTurn: { "p-maya": 1, "p-rhett": 2 } };
    const { plan: p } = await plan({ runtime }, results(), { input: "Maya, come see this." });
    expect(p.runtime.lastInteractedTurn).toEqual({ "p-maya": 5, "p-rhett": 2 });
  });
});

// ---------------------------------------------------------------------------
// Registered actions match player-authored turns only
// ---------------------------------------------------------------------------

describe("registered-action author gating", () => {
  it("player turn: a registered action beats the estimate and applies its meter effects", async () => {
    const { plan: p } = await plan({}, results(), { input: "I take a shower." });
    expect(p.minutes).toBe(20);
    expect(p.minutesCause).toBe("shower");
    const player = p.participants.find((x) => x.isUser);
    expect(player?.state.meters["hygiene"]).toBe(0.95);
  });

  it("companion turn: the same input matches no actions — estimate wins, no meter effect", async () => {
    const { plan: p } = await plan({}, results(), {
      author: "companion",
      speakerParticipantId: "p-maya",
      input: "I take a shower.",
    });
    expect(p.minutes).toBe(5);
    expect(p.minutesCause).toBe("scene");
    const player = p.participants.find((x) => x.isUser);
    expect(player?.state.meters["hygiene"]).not.toBe(0.95);
  });
});

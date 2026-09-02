import { describe, expect, it } from "vitest";
import { narrativeCutSchema, type NarrativeCut } from "@vesper/simulation-core/contracts/narrative";
import type { SoloCutContext } from "@vesper/simulation-core/solo-cut";
import {
  narratorPromptUnits,
  type NarratorInstructionSource,
  type NarratorPromptNode,
} from "@/contracts/narrator-prompts";
import { characterProfileSchema, type CharacterProfile } from "@/contracts/world/profile";
import {
  beatHandlesForCut,
  buildSimHandleMap,
  buildSimRenderPrompt,
  buildSimRenderPromptNodes,
  type SimRenderContext,
} from "./sim-render";
import {
  buildSimSoloRenderPrompt,
  buildSimSoloRenderPromptNodes,
  type SimSoloRenderContext,
} from "./sim-solo-render";

/**
 * Snapshot + behavioural tests for the successor narrator prompt
 * builder. Pure — no IO — so the whole prompt is
 * asserted from a fixture cut + context.
 */

const NOW = 100_000;
const PLAYER = "actor-brian";
const PRIMARY = "actor-nora";

function beat(eventId: string, sequence: number, summary: string) {
  return { kind: "actor_departed", eventId, sequence, storySecond: NOW, summary };
}

function richCut(overrides: Record<string, unknown> = {}): NarrativeCut {
  return narrativeCutSchema.parse({
    id: "cut-x",
    semanticHash: "0badcafe",
    compilerVersion: "cut-v3",
    worldId: "world-1",
    branchId: "branch-1",
    branchVersion: 4,
    engagementId: "engagement-1",
    viewpointActorId: PLAYER,
    fromSequence: 4,
    throughSequence: 6,
    fromStorySecond: NOW,
    throughStorySecond: NOW + 400,
    currentLoci: [
      { actorId: PLAYER, kind: "at", zoneId: "zone-home" },
      { actorId: PRIMARY, kind: "at", zoneId: "zone-home" },
    ],
    currentActivities: [
      { activityId: "act-1", actionDefinitionId: "prepare_meal", actorIds: [PRIMARY], zoneId: "zone-home", phase: "active" },
    ],
    mustEnact: [beat("event-a", 5, "Nora finishes plating the eggs.")],
    perceptibleNow: [],
    speakerBeliefs: [
      {
        beliefId: "belief-1",
        assertionId: "assert-1",
        propositionKey: "nora.slept_well",
        subjectIds: [PRIMARY],
        claimedValue: true,
        confidenceFixedPoint: 8_000,
        status: "active",
        learnedFromActorIds: [],
      },
    ],
    relevantPressures: [{ commitmentId: "commit-1", severity: "salient", actBy: NOW + 3_000 }],
    allowedTransitions: [beat("event-b", 6, "The kettle finishes boiling.")],
    forbiddenClaims: [
      { code: "unearned_travel", claim: "Nora has already left for the market.", subjectActorIds: [PRIMARY] },
    ],
    failurePresentations: [],
    creativeLicenses: [],
    armedEffects: [
      {
        id: "armed-x",
        cutId: "cut-x",
        preconditionVersion: 4,
        effectType: "invitation_spoken",
        actorId: PLAYER,
        targetActorIds: [PRIMARY],
        detail: "Brian invites Nora to sit with him.",
      },
    ],
    bodilyReads: { observed: [{ actorId: PRIMARY, signs: ["visible_fatigue"] }] },
    provenance: [],
    ...overrides,
  });
}

function profileOfAge(age: string): CharacterProfile {
  return characterProfileSchema.parse({
    age,
    bio: "Nora runs the corner café her mother left her; she opens before dawn and closes long after the last regular leaves.",
    personality: "Wry, private, and slow to trust.",
    voice: "Low and dry, with a habit of answering a question with a question.",
    traits: [
      { id: "temperament.warmth", value: 55 },
      { id: "social.dominance", value: 60 },
      { id: "intimate.libido", value: 55 },
    ],
    voiceAnchors: { petPhrases: ["no promises"], cadence: "clipped; trails off when she deflects", neverSays: ["babe"] },
    microExemplars: [{ situation: "pushed about her past", line: "\"Ancient history. Coffee?\"" }],
  });
}

const BASE_CONTEXT: SimRenderContext = {
  actorNames: { [PLAYER]: "Brian", [PRIMARY]: "Nora" },
  viewpointIsPlayer: true,
  calendarStart: { year: 2026, month: 6, day: 1 },
  zoneNames: { "zone-home": "kitchen" },
  outfitLine: "a linen apron, a cotton dress",
  relationship: { regard: 55, familiarity: 60 },
  player: {
    name: "Brian",
    persona: "A regular who shows up every morning and never says much.",
    voice: "Warm and unhurried.",
    intimacy: "Responds to being pursued rather than pursuing.",
  },
  primary: { name: "Nora", profile: profileOfAge("29") },
  playerUtterance: '"Morning, Nora."',
  conversationSummary: "They have circled the same unspoken thing for weeks.",
  memory: ["[observed] Brian left a bigger tip than usual yesterday."],
  dialogueTail: [
    { speaker: "PLAYER (as Brian)", text: "Same as always?" },
    { speaker: "NARRATION (previous)", text: "Nora is already reaching for the good beans." },
  ],
};

const RAW_IDS = ["actor-nora", "actor-brian", "zone-home", "event-a", "event-b", "armed-x", "commit-1", "belief-1"];

describe("buildSimRenderPrompt (successor narrator)", () => {
  it("renders the full adult prompt with the six blocks and never a raw id", () => {
    const { system, prompt } = buildSimRenderPrompt(richCut(), BASE_CONTEXT);

    expect(system).toContain("committed simulated world");
    // Block order / presence.
    for (const heading of [
      "ROLE & SAFETY",
      "AUTHORED CANON",
      "COMMITTED TRUTH",
      "SIM PRESENTATION STATE",
      "CONVERSATION",
      "OUTPUT CONTRACT & CRAFT",
    ]) {
      expect(prompt).toContain(heading);
    }
    // Authored canon, third-person.
    expect(prompt).toContain("The character in this scene is Nora.");
    expect(prompt).toContain("Nora is 29");
    expect(prompt).toContain("Disposition (how Nora actually behaves");
    expect(prompt).toContain("When the moment turns intimate, these also drive Nora:");
    // Committed truth: display names, humanized verbs, handles, legible time.
    expect(prompt).toContain("WORLD CLOCK: Tuesday, June 2 — 3:46am (night)");
    expect(prompt).toContain("Nora: at the kitchen");
    expect(prompt).toContain("preparing a meal (active)");
    expect(prompt).toContain("- B1: Nora finishes plating the eggs.");
    expect(prompt).toContain("- B2: The kettle finishes boiling.");
    expect(prompt).toContain("- E1: Brian to Nora — invitation spoken — Brian invites Nora to sit with him.");
    expect(prompt).toContain("needs to act within about an hour");
    expect(prompt).toContain("Nora shows visible fatigue.");
    // Presentation state + relationship as prose, never numbers.
    expect(prompt).toContain("Nora is wearing a linen apron, a cotton dress");
    expect(prompt).toContain("Where things stand between Nora and Brian");
    expect(prompt).not.toContain("55");
    // Conversation + player agency.
    expect(prompt).toContain("THE PLAYER'S TURN");
    expect(prompt).toContain('"Morning, Nora."');
    expect(prompt).toContain("FINAL RULE");
    // Craft + contract, no literal prose placeholder, adult intimate craft present.
    expect(prompt).toContain("When a scene turns intimate:");
    expect(prompt).toContain("enactedBeatEventIds");
    expect(prompt).not.toContain("100-350 words");
    expect(prompt).not.toContain("<the scene");
    // No raw id anywhere in the prompt surface.
    for (const id of RAW_IDS) expect(prompt).not.toContain(id);

    expect(prompt).toMatchSnapshot();
  });

  it("renders the minor variant with the fence and every intimate surface removed", () => {
    const context: SimRenderContext = { ...BASE_CONTEXT, primary: { name: "Nora", profile: profileOfAge("15") } };
    const { prompt } = buildSimRenderPrompt(richCut(), context);

    expect(prompt).toContain("This character is a minor");
    expect(prompt).toContain("Life stage (you are a teenager");
    // Every intimate surface is fenced out for a minor primary.
    expect(prompt).not.toContain("When the moment turns intimate, these also drive Nora:");
    expect(prompt).not.toContain("When a scene turns intimate:");
    expect(prompt).not.toContain("What Brian responds to");
    // Adult framing is gone.
    expect(prompt).not.toContain("fully in scope");

    expect(prompt).toMatchSnapshot();
  });

  it("falls back to a Day-N clock when the world has no calendar anchor", () => {
    const { prompt } = buildSimRenderPrompt(richCut(), { ...BASE_CONTEXT, calendarStart: null });
    expect(prompt).toContain("WORLD CLOCK: Day 2 · 3:46am (night)");
    expect(prompt).not.toContain("Tuesday, June 2");
  });

  it("omits the player-turn block when no utterance is given (the scene breathes)", () => {
    const context = { ...BASE_CONTEXT };
    delete context.playerUtterance;
    const { prompt } = buildSimRenderPrompt(richCut(), context);
    expect(prompt).not.toContain("THE PLAYER'S TURN");
    expect(prompt).not.toContain("FINAL RULE");
    // The rest of the scene still renders.
    expect(prompt).toContain("COMMITTED TRUTH");
  });

  it("appends a CORRECTION block naming the missed beat only on attempt ≥2", () => {
    const cut = richCut();
    const first = buildSimRenderPrompt(cut, BASE_CONTEXT, { attempt: 1 });
    expect(first.prompt).not.toContain("CORRECTION");

    const retry = buildSimRenderPrompt(cut, BASE_CONTEXT, {
      attempt: 2,
      correction: { missingBeats: [{ handle: "B1", summary: "Nora finishes plating the eggs." }], leaked: true },
    });
    expect(retry.prompt).toContain("CORRECTION");
    expect(retry.prompt).toContain("B1 (Nora finishes plating the eggs.)");
    expect(retry.prompt).toContain("NEVER write a handle");
  });

  it("degrades safely with an empty context (no profile, no persona)", () => {
    const { system, prompt } = buildSimRenderPrompt(richCut(), {});
    expect(system.length).toBeGreaterThan(0);
    expect(prompt).toContain("COMMITTED TRUTH");
    // No authored canon, but the role/output scaffolding still stands.
    expect(prompt).toContain("ROLE & SAFETY");
    expect(prompt).toContain("OUTPUT CONTRACT & CRAFT");
  });
});

describe("handle map determinism", () => {
  it("assigns B-handles over mustEnact then allowedTransitions, E-handles over armedEffects", () => {
    const cut = richCut();
    expect(buildSimHandleMap(cut)).toEqual({ B1: "event-a", B2: "event-b", E1: "armed-x" });
    expect(beatHandlesForCut(cut).map((b) => b.handle)).toEqual(["B1", "B2"]);
  });

  it("is stable — the same cut yields the identical map every call (so sim-narrator can rebuild it)", () => {
    const cut = richCut();
    expect(buildSimHandleMap(cut)).toEqual(buildSimHandleMap(cut));
    // The builder exposes the same map it embeds in the prompt.
    expect(buildSimRenderPrompt(cut, BASE_CONTEXT).handleMap).toEqual(buildSimHandleMap(cut));
  });
});

// ---------------------------------------------------------------------------
// Narrator instruction override
// ---------------------------------------------------------------------------

/**
 * The successor half of the Prompt Lab boundary. The co-present and SOLO lanes
 * consume the SAME resolved instruction source, which is the plan's explicit
 * requirement: leaving the primary's physical scene must not silently restore
 * production narrator behavior mid-conversation.
 *
 * What these kill: an override that reaches the committed cut, the deterministic
 * handles, the player-authorship clauses in the CONVERSATION block, or the strict
 * JSON schema — any of which turns a prompt experiment into a parse failure or an
 * invented world fact rather than a different writing style.
 */

const SOLO_CUT: SoloCutContext = {
  playerName: "Brian",
  primaryName: "Nora",
  playerSide: {
    zoneLabel: "town square",
    inTransit: false,
    coPresent: [{ name: "Sable", activity: "selling wares" }],
    heldItems: ["a small keepsake"],
  },
  vignette: {
    primaryName: "Nora",
    zoneLabel: "home",
    inTransit: false,
    activity: "preparing a meal",
    routineMusts: ["Nora is at home and stays there this turn."],
  },
};

const SOLO_CONTEXT: SimSoloRenderContext = { ...BASE_CONTEXT, storySecond: 8 * 3_600, calendarStart: null, solo: SOLO_CUT };

const OVERRIDE: Extract<NarratorInstructionSource, { kind: "test" }> = {
  kind: "test",
  templateId: "tpl-1",
  templateName: "Player Agency Minimal",
  revisionId: "rev-1",
  revision: 4,
  body: "You are the narrator of a roleplaying game and embody every NPC. Resolve the beat before advancing the scene.",
  bodyHash: "hash-1",
  templateLanguage: "plain_v0",
};

/** The whole replacement law over one lane's classified tree. */
function expectOnlyBehaviorReplaced(nodes: readonly NarratorPromptNode[], rendered: string): void {
  const units = narratorPromptUnits(nodes).filter((unit) => unit.text.length > 0);
  expect(units.some((unit) => unit.authority === "behavior")).toBe(true);
  for (const unit of units) {
    if (unit.authority === "behavior") expect(rendered, `behavior unit ${unit.id} survived`).not.toContain(unit.text);
    else expect(rendered, `${unit.authority} unit ${unit.id} was dropped`).toContain(unit.text);
  }
  expect(rendered.split(OVERRIDE.body).length - 1).toBe(1);
  expect(rendered).not.toMatch(/\n\n\n/);
}

describe("narrator instruction source (successor lanes)", () => {
  it("is a no-op in production: an explicit production source changes nothing, co-present or solo", () => {
    const production: NarratorInstructionSource = { kind: "production", instructionHash: "" };

    expect(buildSimRenderPrompt(richCut(), { ...BASE_CONTEXT, instructionSource: production })).toEqual(
      buildSimRenderPrompt(richCut(), BASE_CONTEXT),
    );
    expect(
      buildSimRenderPrompt(richCut(), { ...BASE_CONTEXT, instructionSource: production }, {
        attempt: 2,
        correction: { missingBeats: [{ handle: "B1", summary: "Nora finishes plating the eggs." }], leaked: true },
      }),
    ).toEqual(
      buildSimRenderPrompt(richCut(), BASE_CONTEXT, {
        attempt: 2,
        correction: { missingBeats: [{ handle: "B1", summary: "Nora finishes plating the eggs." }], leaked: true },
      }),
    );
    expect(buildSimSoloRenderPrompt({ ...SOLO_CONTEXT, instructionSource: production })).toEqual(
      buildSimSoloRenderPrompt(SOLO_CONTEXT),
    );
  });

  it("replaces only the craft layer: committed truth, agency law and the JSON contract survive in both lanes", () => {
    const context: SimRenderContext = { ...BASE_CONTEXT, instructionSource: OVERRIDE };
    const { prompt } = buildSimRenderPrompt(richCut(), context);
    expectOnlyBehaviorReplaced(buildSimRenderPromptNodes(richCut(), context), prompt);
    expect(prompt).toContain("Return STRICT JSON");
    expect(prompt).toContain("- B1: Nora finishes plating the eggs.");
    expect(prompt).toContain("never put words, thoughts, or actions in their mouth");
    expect(prompt).toContain("Inner thoughts");
    expect(prompt).toContain("[Nora]");
    expect(prompt).toContain("FINAL RULE");
    expect(prompt).not.toContain("Shaping each reply");

    const soloContext: SimSoloRenderContext = { ...SOLO_CONTEXT, instructionSource: OVERRIDE };
    const solo = buildSimSoloRenderPrompt(soloContext).prompt;
    expectOnlyBehaviorReplaced(buildSimSoloRenderPromptNodes(soloContext), solo);
    expect(solo).toContain("Return STRICT JSON with exactly one field");
    expect(solo).toContain("Nora is at home and stays there this turn.");
    expect(solo).toContain("never put words, thoughts, or actions in their mouth");
    expect(solo).toContain("This glimpse is for the reader only");
    expect(solo).not.toContain("Shaping each reply");
  });
});

// ---------------------------------------------------------------------------
// Visual state
// ---------------------------------------------------------------------------

/**
 * The visual-state pair reaches the successor narrator only when the routed
 * chat's own switch put it there, and it reaches BOTH lanes the same way.
 *
 * What these kill: a builder that emits an empty `sim_visual_state` unit (or any
 * other byte) for a chat with the switch off — the switch is default-off and its
 * whole promise is that a chat without it renders the prompt this lane rendered
 * before the feature existed — and a builder that folds the fence and the offer
 * into one block, which would hand the narrator a must-not-contradict list
 * wearing a "weave one in" invitation.
 */
describe("visual state (successor lanes)", () => {
  const LINES = {
    constraints: ["Nora is wearing the apron", "Nora's crooked nose"],
    cues: ["the apron's left cuff is rolled up — just became visible"],
  };
  const unitIds = (nodes: readonly NarratorPromptNode[]): string[] =>
    narratorPromptUnits(nodes).map((unit) => unit.id);

  it("emits no node and identical bytes when the chat's switch is off", () => {
    expect(unitIds(buildSimRenderPromptNodes(richCut(), BASE_CONTEXT))).not.toContain("sim_visual_state");
    expect(unitIds(buildSimSoloRenderPromptNodes(SOLO_CONTEXT))).not.toContain("sim_visual_state");
    // A switched-ON turn whose projection resolved nothing is the same prompt: an
    // empty pair is silence, never an empty heading.
    const empty = { constraints: [], cues: [] };
    expect(buildSimRenderPrompt(richCut(), { ...BASE_CONTEXT, visualState: empty })).toEqual(
      buildSimRenderPrompt(richCut(), BASE_CONTEXT),
    );
    expect(buildSimSoloRenderPrompt({ ...SOLO_CONTEXT, visualState: empty })).toEqual(
      buildSimSoloRenderPrompt(SOLO_CONTEXT),
    );
  });

  it("renders the fence and the offer as two blocks, in that order, in both lanes", () => {
    for (const prompt of [
      buildSimRenderPrompt(richCut(), { ...BASE_CONTEXT, visualState: LINES }).prompt,
      buildSimSoloRenderPrompt({ ...SOLO_CONTEXT, visualState: LINES }).prompt,
    ]) {
      const fence = prompt.indexOf("True right now — do not contradict");
      const offer = prompt.indexOf("Visible detail worth noticing this turn");
      expect(fence).toBeGreaterThan(-1);
      // The offer reads against a fence that is already standing.
      expect(offer).toBeGreaterThan(fence);
      expect(prompt).toContain("- Nora's crooked nose");
      expect(prompt).toContain("- the apron's left cuff is rolled up — just became visible");
      // The fence carries no invitation; only the cue block does.
      expect(prompt.slice(fence, offer)).toContain("there is no obligation to mention any of them");
      expect(prompt.slice(fence, offer)).not.toContain("weave at most one");
    }
  });

  it("is world truth, not craft: a test instruction source cannot replace it", () => {
    const context: SimRenderContext = { ...BASE_CONTEXT, visualState: LINES, instructionSource: OVERRIDE };
    const { prompt } = buildSimRenderPrompt(richCut(), context);
    expectOnlyBehaviorReplaced(buildSimRenderPromptNodes(richCut(), context), prompt);
    expect(prompt).toContain("- Nora's crooked nose");
  });
});

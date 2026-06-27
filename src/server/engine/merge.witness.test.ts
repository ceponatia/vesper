import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { emptyBrief } from "@/contracts/state/brief";
import { emptyParticipantState } from "@/contracts/state/participant-state";
import { emptySceneGenState } from "@/contracts/state/scene-gen";
import { emptySessionRuntime } from "@/contracts/state/session-runtime";
import type { AgentResults, SimulantResult } from "@/contracts/turns/agent-results";
import { emptyCharacterProfile, emptyWorldLore, emptyWorldStyle } from "@/contracts/world/profile";
import type { BundleItem, BundleParticipant, BundlePlace, SessionBundle } from "./bundle";
import { type MergeTurn, type WorkingParticipant, planTurnEffects } from "./merge";
import { planCommsEvents } from "./merge/phases/comms";
import { turnSalienceSet } from "./merge/phases/witness";

// ---------------------------------------------------------------------------
// Fixtures (mirrors merge.test.ts; kept local so witness tests stand alone)
// ---------------------------------------------------------------------------

function place(id: string, name: string, light?: string): BundlePlace {
  return { id, name, description: `${name} description`, ambient: light !== undefined ? { light } : {}, locationId: null, emergent: false };
}

function participant(
  id: string,
  displayName: string,
  locationId: string | null,
  opts: { isUser?: boolean; role?: "player" | "companion" | "npc"; activity?: string; posture?: string; aliases?: string[] } = {},
): BundleParticipant {
  const snapshot = emptyCharacterProfile();
  if (opts.aliases) snapshot.aliases = opts.aliases;
  const state = emptyParticipantState();
  if (opts.activity) state.activity = opts.activity;
  if (opts.posture) state.posture = opts.posture;
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
    state,
  };
}

function makeBundle(overrides: Partial<SessionBundle> = {}): SessionBundle {
  const locations = [place("loc-kitchen", "Kitchen"), place("loc-garden", "Garden")];
  const participants = [
    participant("p-player", "Brian", "loc-kitchen", { isUser: true, role: "player" }),
    participant("p-maya", "Maya Brennan", "loc-kitchen", { role: "companion", aliases: ["May"] }),
  ];
  const items: BundleItem[] = [];
  return {
    relationships: [],
    session: { id: "s-1", ownerId: "u-1", worldId: "w-1", title: "Test", embodied: true, status: "processing", clockMinutes: 0 },
    world: { id: "w-1", ownerId: "u-1", name: "Testworld", description: "", narrativeModel: "", agentModel: "" },
    participants,
    locations,
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
    narration: "The kitchen holds its small sounds.",
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

async function planWith(bundle: SessionBundle, agentResults: AgentResults, turnOverrides: Partial<MergeTurn> = {}) {
  const sink = new DiagnosticCollector();
  const merged = await planTurnEffects({ bundle, turn: makeTurn(turnOverrides), results: agentResults, sink });
  return { plan: merged, sink };
}

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((d) => d.code);
}

// A clock value that puts the game well inside the night band (calendar starts
// 08:00, so +14h = 22:00 = night).
const NIGHT_CLOCK = 14 * 60;

// ---------------------------------------------------------------------------
// turnSalienceSet (pure)
// ---------------------------------------------------------------------------

describe("turnSalienceSet", () => {
  it("defaults to obvious/quiet baseline", () => {
    const set = turnSalienceSet({ inputText: "I wave hello.", explicit: [], hasConcealmentTarget: true });
    expect(set).toEqual([{ visual: "obvious", audible: "quiet" }]);
  });

  it("uses a concealed baseline only when a stealth marker AND a concealment target are present", () => {
    expect(turnSalienceSet({ inputText: "I quietly slip the note in.", explicit: [], hasConcealmentTarget: true })).toEqual([
      { visual: "subtle", audible: "quiet" },
    ]);
    // Stealth marker but nobody to hide from → still obvious (intimate "quietly").
    expect(turnSalienceSet({ inputText: "I quietly slip the note in.", explicit: [], hasConcealmentTarget: false })).toEqual([
      { visual: "obvious", audible: "quiet" },
    ]);
  });

  it("appends deduped explicit event saliences after the baseline", () => {
    const set = turnSalienceSet({
      inputText: "I do a few things.",
      explicit: [
        { visual: "obvious", audible: "loud" },
        { visual: "obvious", audible: "loud" }, // duplicate
        { visual: "obvious", audible: "quiet" }, // duplicate of baseline
      ],
      hasConcealmentTarget: false,
    });
    expect(set).toEqual([
      { visual: "obvious", audible: "quiet" },
      { visual: "obvious", audible: "loud" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Perception-based witness sets in planTurnEffects
// ---------------------------------------------------------------------------

describe("perception-based witness sets", () => {
  it("includes the player and an idle co-located NPC for a normal turn (no regression)", async () => {
    const bundle = makeBundle();
    const { plan } = await planWith(bundle, results({ simulant: simulant() }), { input: "I look around." });
    expect(plan.witnessedBy).toEqual(["p-player", "p-maya"]);
  });

  it("excludes an absorbed, back-turned NPC from a concealed turn but includes her for a loud one", async () => {
    // Maya is absorbed + facing away; a third NPC (Rhett) is present to hide from.
    const base = makeBundle();
    base.participants[1] = participant("p-maya", "Maya Brennan", "loc-kitchen", {
      role: "companion",
      activity: "washing dishes, back turned to the room",
    });
    base.participants.push(participant("p-rhett", "Rhett", "loc-kitchen", { role: "npc", activity: "reading the paper" }));

    // Concealed turn: stealth marker + a non-targeted present NPC (Rhett) to hide from.
    const concealed = await planWith({ ...base, participants: [...base.participants] }, results({ simulant: simulant() }), {
      input: "I quietly slip the letter into my pocket.",
    });
    // Maya (absorbed, back turned) cannot perceive a subtle/quiet action.
    expect(concealed.plan.witnessedBy).not.toContain("p-maya");
    expect(concealed.plan.witnessedBy).toContain("p-player");

    // Loud/obvious turn: the same Maya now hears it (absorbed hears loud).
    const loud = await planWith(
      { ...base, participants: [...base.participants] },
      results({ simulant: simulant({ activityUpdates: [{ participantName: "Brian", activity: "slamming the drawer", salience: { visual: "obvious", audible: "loud" } }] }) }),
      { input: "I slam the drawer shut." },
    );
    expect(loud.plan.witnessedBy).toContain("p-maya");
  });

  it("falls back to co-location semantics when there is no placed player", async () => {
    const bundle = makeBundle();
    bundle.participants[0] = participant("p-player", "Brian", null, { isUser: true, role: "player" }); // unplaced
    const { plan } = await planWith(bundle, results({ simulant: simulant() }), { author: "companion", input: "" });
    // Co-location fallback: everyone at the witness location (Maya in kitchen).
    expect(plan.witnessedBy).toContain("p-maya");
  });
});

// ---------------------------------------------------------------------------
// Darkness
// ---------------------------------------------------------------------------

// Darkness gates only the VISUAL channel (obvious → subtle). The turn-salience
// set always includes the obvious/quiet baseline, and an idle_alert NPC hears
// quiet — so darkness alone never excludes an idle_alert observer through the
// baseline. To isolate the visual downgrade we use an NPC who does NOT hear the
// quiet baseline (absorbed hears only loud) and watch the obvious-but-silent
// action vanish when the room goes dark. (Integration note: a truly silent,
// obvious-only action is the only kind darkness can hide from an attentive room.)
function darknessBundle(light?: string): SessionBundle {
  const bundle = makeBundle({
    clockMinutes: NIGHT_CLOCK,
    locations: [place("loc-kitchen", "Kitchen", light), place("loc-garden", "Garden")],
  });
  bundle.session.clockMinutes = NIGHT_CLOCK;
  // Maya absorbed but FACING the room (no facesAway) — she can see obvious, hears only loud.
  bundle.participants[1] = participant("p-maya", "Maya Brennan", "loc-kitchen", {
    role: "companion",
    activity: "scrubbing the counter",
  });
  return { ...bundle, participants: [...bundle.participants] };
}

const SILENT_OBVIOUS = simulant({
  activityUpdates: [{ participantName: "Brian", activity: "gesturing silently", salience: { visual: "obvious", audible: "silent" } }],
});

describe("darkness in witness sets", () => {
  it("excludes an absorbed NPC from an obvious-but-silent action at night with empty ambient light", async () => {
    // Empty ambient.light + night = dark; the obvious action reads as subtle, which
    // the absorbed (facing) NPC cannot see; it is silent so nothing is heard.
    const { plan, sink } = await planWith(darknessBundle(undefined), results({ simulant: SILENT_OBVIOUS }), {
      input: "I gesture in the dark.",
    });
    expect(plan.witnessedBy).not.toContain("p-maya");
    expect(plan.witnessedBy).toContain("p-player");
    // Empty light is unambiguous (defaults dark, no miss).
    expect(codes(sink)).not.toContain("merge.perception.darkness_miss");
  });

  it("perceives the same action in a lit room at night", async () => {
    const { plan } = await planWith(darknessBundle("warm lamplight"), results({ simulant: SILENT_OBVIOUS }), {
      input: "I gesture.",
    });
    // Lit → obvious stays obvious → the absorbed (facing) NPC sees it.
    expect(plan.witnessedBy).toContain("p-maya");
  });

  it("emits merge.perception.darkness_miss only for ambiguous light", async () => {
    const bundle = makeBundle({ clockMinutes: NIGHT_CLOCK, locations: [place("loc-kitchen", "Kitchen", "smells faintly of bread"), place("loc-garden", "Garden")] });
    bundle.session.clockMinutes = NIGHT_CLOCK;
    const { sink } = await planWith(bundle, results({ simulant: simulant() }), { input: "I look around." });
    expect(codes(sink)).toContain("merge.perception.darkness_miss");
  });

  it("does not emit darkness_miss during the day", async () => {
    const bundle = makeBundle({ locations: [place("loc-kitchen", "Kitchen", "smells faintly of bread"), place("loc-garden", "Garden")] });
    const { sink } = await planWith(bundle, results({ simulant: simulant() }), { input: "I look around." });
    expect(codes(sink)).not.toContain("merge.perception.darkness_miss");
  });
});

// ---------------------------------------------------------------------------
// Comms link persistence
// ---------------------------------------------------------------------------

describe("planCommsEvents (pure)", () => {
  const parts: WorkingParticipant[] = [
    { id: "p-player", displayName: "Brian", isUser: true, role: "player", characterId: null, snapshot: emptyCharacterProfile(), locationId: "loc-kitchen", state: emptyParticipantState() },
    { id: "p-mara", displayName: "Mara", isUser: false, role: "npc", characterId: null, snapshot: emptyCharacterProfile(), locationId: "loc-garden", state: emptyParticipantState() },
  ];

  it("opens a link, records the change, and stamps the open time", () => {
    const sink = new DiagnosticCollector();
    const out = planCommsEvents([{ op: "open", kind: "call", withName: "Mara" }], [], 120, parts, sink);
    expect(out.links).toEqual([{ kind: "call", withParticipantId: "p-mara", since: 120 }]);
    expect(out.changes).toEqual([{ op: "open", kind: "call", withParticipantId: "p-mara" }]);
  });

  it("replaces an existing link to the same participant rather than duplicating", () => {
    const prior = [{ kind: "text" as const, withParticipantId: "p-mara", since: 10 }];
    const out = planCommsEvents([{ op: "open", kind: "call", withName: "Mara" }], prior, 200, parts);
    expect(out.links).toEqual([{ kind: "call", withParticipantId: "p-mara", since: 200 }]);
  });

  it("closes a link to a participant", () => {
    const prior = [{ kind: "call" as const, withParticipantId: "p-mara", since: 10 }];
    const out = planCommsEvents([{ op: "close", kind: "call", withName: "Mara" }], prior, 300, parts);
    expect(out.links).toEqual([]);
    expect(out.changes).toEqual([{ op: "close", kind: "call", withParticipantId: "p-mara" }]);
  });

  it("drops an unresolved name with merge.comms.unresolved", () => {
    const sink = new DiagnosticCollector();
    const out = planCommsEvents([{ op: "open", kind: "call", withName: "Nobody" }], [], 50, parts, sink);
    expect(out.links).toEqual([]);
    expect(out.changes).toEqual([]);
    expect(codes(sink)).toContain("merge.comms.unresolved");
  });
});

describe("comms link persistence in planTurnEffects", () => {
  it("opens a runtime comms link from a simulant commsEvent", async () => {
    const bundle = makeBundle();
    bundle.participants.push(participant("p-mara", "Mara", "loc-garden", { role: "npc" }));
    const { plan } = await planWith(
      { ...bundle, participants: [...bundle.participants] },
      results({ simulant: simulant({ commsEvents: [{ op: "open", kind: "call", withName: "Mara" }] }) }),
    );
    expect(plan.runtime.commsLinks).toEqual([{ kind: "call", withParticipantId: "p-mara", since: plan.clockMinutes }]);
    expect(plan.commsChanges).toEqual([{ op: "open", kind: "call", withParticipantId: "p-mara" }]);
  });

  it("removes a prior runtime comms link on close", async () => {
    const bundle = makeBundle();
    bundle.participants.push(participant("p-mara", "Mara", "loc-garden", { role: "npc" }));
    bundle.runtime = { ...emptySessionRuntime(), commsLinks: [{ kind: "call", withParticipantId: "p-mara", since: 5 }] };
    const { plan } = await planWith(
      { ...bundle, participants: [...bundle.participants] },
      results({ simulant: simulant({ commsEvents: [{ op: "close", kind: "call", withName: "Mara" }] }) }),
    );
    expect(plan.runtime.commsLinks).toEqual([]);
    expect(plan.commsChanges).toEqual([{ op: "close", kind: "call", withParticipantId: "p-mara" }]);
  });

  it("drops an unknown comms target with a diagnostic and leaves links unchanged", async () => {
    const bundle = makeBundle();
    const { plan, sink } = await planWith(
      bundle,
      results({ simulant: simulant({ commsEvents: [{ op: "open", kind: "call", withName: "Ghost" }] }) }),
    );
    expect(plan.runtime.commsLinks).toEqual([]);
    expect(codes(sink)).toContain("merge.comms.unresolved");
  });

  it("clears surfaced pendingComms after a post-turn merge (surface-once)", async () => {
    const bundle = makeBundle();
    bundle.runtime = { ...emptySessionRuntime(), pendingComms: [{ fromParticipantId: "p-maya", kind: "text", gist: "call me", urgency: "normal" }] };
    const { plan } = await planWith(bundle, results({ simulant: simulant() }));
    // The message already rode in this turn's pre-turn context, so it clears
    // (no staged beat fired a fresh one this turn).
    expect(plan.runtime.pendingComms).toEqual([]);
  });

  it("carries pendingComms through unchanged in reconcile mode", async () => {
    const bundle = makeBundle();
    const pending = [{ fromParticipantId: "p-maya", kind: "text" as const, gist: "call me", urgency: "normal" as const }];
    bundle.runtime = { ...emptySessionRuntime(), pendingComms: pending };
    const sink = new DiagnosticCollector();
    const plan = await planTurnEffects({
      bundle: { ...bundle, participants: [...bundle.participants] },
      turn: makeTurn(),
      results: results({ simulant: simulant() }),
      sink,
      mode: "reconcile",
    });
    expect(plan.runtime.pendingComms).toEqual(pending);
  });

  it("leaves comms links untouched in reconcile mode", async () => {
    const bundle = makeBundle();
    bundle.participants.push(participant("p-mara", "Mara", "loc-garden", { role: "npc" }));
    bundle.runtime = { ...emptySessionRuntime(), commsLinks: [{ kind: "call", withParticipantId: "p-mara", since: 5 }] };
    const sink = new DiagnosticCollector();
    const plan = await planTurnEffects({
      bundle: { ...bundle, participants: [...bundle.participants] },
      turn: makeTurn(),
      results: results({ simulant: simulant({ commsEvents: [{ op: "close", kind: "call", withName: "Mara" }] }) }),
      sink,
      mode: "reconcile",
    });
    expect(plan.runtime.commsLinks).toEqual([{ kind: "call", withParticipantId: "p-mara", since: 5 }]);
    expect(plan.commsChanges).toEqual([]);
  });
});

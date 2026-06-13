import { defaultExposureMask, type NextTurnBrief } from "@/contracts/state/brief";
import type { AgentResults, SimulantResult } from "@/contracts/turns/agent-results";

/**
 * Demo mode (docs/resilience.md §6): with no API key the full turn loop still
 * runs — a deterministic template narrative and heuristic agent results. This
 * is what CI exercises end-to-end.
 */

const CHUNK_SIZE = 40;

function echoOf(input: string, max = 100): string {
  const trimmed = input.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Deterministic 2–3 paragraph narrative, streamed in ~40-char chunks. Includes
 * one `[Name]`-tagged dialogue line when NPCs are present so the segmenter and
 * UI speaker bubbles are exercised even in demo mode.
 */
export async function* demoNarrative(input: string, npcNames: string[]): AsyncGenerator<string> {
  const npc = npcNames[0];
  const paragraphs = [
    `The scene takes shape plainly — demo mode, no narrative model configured — but your words land all the same: "${echoOf(input)}". The room keeps its small sounds while the moment takes them in.`,
    npc
      ? `[${npc}] "I hear you," ${npc} says, with a small tilt of the head. "It's a quiet sort of day — say the word and we'll make something of it."`
      : "No one else is here to answer; the quiet does it for them, settling back into the corners of the room.",
    "Light shifts a little at the window, and the scene holds, waiting on your next move.",
  ];
  const text = paragraphs.join("\n\n");

  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    await Promise.resolve();
    yield text.slice(i, i + CHUNK_SIZE);
  }
}

export interface DemoAgentOptions {
  npcNames: string[];
  locationNames: string[];
  /** Player display name; omit in observer mode (no movement is inferred). */
  playerName?: string;
  /** The (demo) narration, used for the synthetic episode summary. */
  narration?: string;
  /** Prior brief: storySoFar/memoryQueries carry forward heuristically. */
  priorBrief?: NextTurnBrief;
}

const MINUTE_HEURISTICS: Array<{ re: RegExp; minutes: number }> = [
  { re: /\b(sleep|go to bed|overnight|night'?s rest)\b/, minutes: 480 },
  { re: /\b(nap|doze)\b/, minutes: 90 },
  { re: /\b(wait|hours pass|later that)\b/, minutes: 60 },
  { re: /\b(cook|dinner|lunch|breakfast|meal|eat)\b/, minutes: 45 },
  { re: /\b(shower|bathe|bath)\b/, minutes: 30 },
  { re: /\b(walk to|travel|drive|ride|head (?:in)?to|go (?:in)?to|enter)\b/, minutes: 20 },
];

const MOVEMENT_VERB_RE = /\b(go|going|went|walk|walks|walked|head|heads|headed|move|moves|moved|step|steps|stepped|enter|enters|entered|run|runs|ran)\b/;

function stripQuoted(input: string): string {
  return input.replace(/"[^"\n]*(?:"|$)|“[^”\n]*(?:”|$)/g, " ");
}

function heuristicMinutes(lower: string): number {
  for (const { re, minutes } of MINUTE_HEURISTICS) {
    if (re.test(lower)) return minutes;
  }
  return 5;
}

function heuristicMovement(lower: string, opts: DemoAgentOptions): SimulantResult["movements"] {
  if (!opts.playerName || !MOVEMENT_VERB_RE.test(lower)) return [];
  const ordered = [...opts.locationNames].sort((a, b) => b.length - a.length);
  for (const name of ordered) {
    if (lower.includes(name.toLowerCase())) {
      return [{ participantName: opts.playerName, toLocationName: name, reason: "demo keyword movement" }];
    }
  }
  return [];
}

/**
 * Heuristic post-turn results: keyword minutes + movement detection, zero
 * facts, a synthetic episode summary, and a carried-forward brief. All four
 * agents "succeed" so the merge path is identical to live mode.
 */
export function demoAgentResults(input: string, opts: DemoAgentOptions): AgentResults {
  const lower = stripQuoted(input).toLowerCase();
  const npc = opts.npcNames[0];
  const summary = [
    `In demo mode the player ${MOVEMENT_VERB_RE.test(lower) ? "moved through the scene" : "spoke and acted"}: "${echoOf(input, 120)}".`,
    npc ? `${npc} acknowledged it and the scene moved on quietly.` : "The scene moved on quietly.",
  ].join(" ");

  return {
    simulant: {
      minutesAdvanced: heuristicMinutes(lower),
      movements: heuristicMovement(lower, opts),
      itemEvents: [],
      affinityAdjustments: [],
      meterAdjustments: [],
      conditionEvents: [],
      attributeChanges: [],
      activityUpdates: [],
    },
    archivist: {
      episodeSummary: summary,
      facts: [],
      supersedeHints: [],
    },
    continuity: {
      violations: [],
      normBreaches: [],
      driftNotes: [],
    },
    director: {
      sceneSummary: `Demo scene: ${echoOf(input, 80)}`,
      storySoFar: opts.priorBrief?.storySoFar ?? "",
      characterNotes: [],
      directives: [],
      memoryQueries: [echoOf(input, 60), ...(opts.priorBrief?.memoryQueries.slice(0, 2) ?? [])],
      exposure: opts.priorBrief?.exposure ?? defaultExposureMask(),
      threadSignals: { touch: [], propose: [], resolve: [] },
    },
  };
}

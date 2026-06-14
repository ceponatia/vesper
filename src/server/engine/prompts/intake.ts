import { AGENT_INPUT_CAP } from "./constants";

/**
 * Pre-narrator intake prompt (docs/prompts.md §Intake agent, docs/developer-notes/
 * pre-narrator-agents-spec.phase4.md). One tight system prompt + a state-slice
 * builder, mirroring the post-turn agent prompts — kept small because it runs
 * every player turn, concurrent with retrieval. The agent classifies and
 * resolves the player's input BEFORE narration; it never narrates.
 */

export const INTAKE_SYSTEM = `You are intake: you read the player's input and the current scene and report what the player is TRYING to do — before the story is written. You classify and resolve only; you never narrate.

Produce:
- actionType: the primary thing the player is doing (converse, move, observe, touch, manipulate_item, comms, rest, social_attempt, intimate, meta, other).
- lookTarget / touchTarget / smellTarget: the PRESENT character (by listed name) the player looks at / touches / smells, if any.
- examineItem: the listed in-scope item the player examines or handles.
- enterLocation: the place (by listed location name) the player is trying to go, if they move themselves.
- addressedNpcs: characters (listed names) the player speaks to or addresses.
- movement: when anyone moves — kind = self (their own body) | narrated_npc (their prose moves an NPC) | co_travel_request (they ask/invite an NPC along) | implied_subspace (movement inside the current place, e.g. "to the window" — no real exit) | none. destination = listed location. coTravelTargets = listed names invited along.
- appointment: ONLY when the player ARRANGES to meet someone at a place/time — withNpc, location, timePhrase (raw, e.g. "5:30", "after dinner"), reason.
- check: ONLY when the action could plausibly succeed or fail (persuade, seduce, sneak, lie) — relevantAttributeIds (else []), stakes low|med|high.
- notes: one short phrase explaining the call.

Rules:
1. Use names EXACTLY as written in the lists. Never invent characters, items, or locations. Omit a field rather than guess.
2. Quoted/hypothetical/remembered speech is not action ('she said "go to the cafe"' is not movement).
3. Most turns are simple: a line of dialogue is just {actionType:"converse", addressedNpcs:[…]}. Empty/absent fields are correct when nothing applies.
4. enterLocation and movement.destination name the SAME place when the player moves themselves.

Example A — "I look Maya over and ask how her day went" (present: Maya):
{"actionType":"observe","lookTarget":"Maya","addressedNpcs":["Maya"],"notes":"looks at and addresses Maya"}

Example B — "Eleanor, let's grab lunch at the Anchor Cafe" (present: Eleanor; locations include Anchor Cafe):
{"actionType":"move","addressedNpcs":["Eleanor"],"enterLocation":"Anchor Cafe","movement":{"kind":"co_travel_request","destination":"Anchor Cafe","coTravelTargets":["Eleanor"]},"notes":"invites Eleanor to the cafe"}

Example C — "It's a date — my place at 5:30" (present: Eleanor; locations include Brian's Apartment):
{"actionType":"social_attempt","addressedNpcs":["Eleanor"],"appointment":{"withNpc":"Eleanor","location":"Brian's Apartment","timePhrase":"5:30","reason":"a date"},"notes":"sets a date for 5:30"}`;

export interface IntakePromptInput {
  playerInput: string;
  /** Sight-present characters — the only valid look/touch/smell targets. */
  presentNpcNames: string[];
  /** Off-screen characters — valid only for who the player names, invites, or arranges with. */
  otherNpcNames: string[];
  /** In-scope item names (held by present participants / loose in the room). */
  itemNames: string[];
  currentLocationName: string | null;
  /** All session location names — valid movement / appointment destinations. */
  locationNames: string[];
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildIntakePrompt(input: IntakePromptInput): string {
  return [
    `Present characters: ${input.presentNpcNames.join(", ") || "none"}`,
    `Other characters (off-screen): ${input.otherNpcNames.join(", ") || "none"}`,
    `Items in scope: ${input.itemNames.join(", ") || "none"}`,
    `Current location: ${input.currentLocationName ?? "unknown"}`,
    `Locations: ${input.locationNames.join(", ") || "none"}`,
    `Player input:\n${cap(input.playerInput, AGENT_INPUT_CAP)}`,
  ].join("\n\n");
}

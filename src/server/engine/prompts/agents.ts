import type { NextTurnBrief } from "@/contracts/state/brief";
import type { StoryThread } from "@/contracts/state/session-runtime";
import type { TurnAuthor } from "@/contracts/turns/stream";
import type { WorldNorm } from "@/contracts/world/profile";
import { AGENT_INPUT_CAP, AGENT_NARRATION_CAP } from "./constants";

/**
 * Post-turn agent prompts (docs/prompts.md §Agent prompts). Each system
 * prompt: role, what to extract, what NOT to do, two worked examples — kept
 * under ~600 tokens because they run every turn. User messages carry only the
 * agent's state slice (docs/turn-engine.md §Post-turn agents).
 */

export const SIMULANT_SYSTEM = `You are the simulant: you read one story turn and report what PHYSICALLY changed, as structured data.

Extract:
- minutesAdvanced: realistic elapsed game minutes (dialogue 2-5; a meal 30-45; a night's sleep ~480).
- movements: who ended the turn in a different location (toLocationName from the listed locations).
- itemEvents: wear/remove/pick_up/drop/place/store_in/take_from/open/close/alter — only items from the listed items. Completed wardrobe changes matter most, however gradual or tender the prose ("I unwrap her scarf and lay it on the table" → remove + place). Fumbling with a garment is not removal; finishing the act is.
- meterAdjustments: deltas in -1..1 for listed meter ids, justified by events (a shower raises hygiene; a sprint drains energy).
- conditionEvents: add/end short-lived physical states ("soaked", "sprained ankle"), optional severity/durationMinutes/promptHint.
- attributeChanges: rare lasting bodily changes only (a haircut, an injury).
- activityUpdates: each named character's end-of-turn activity (and posture when clear).
- affinityAdjustments: feeling shifts evidenced by words or deeds (fromName toward towardName; integer delta ±1-2 ordinary, ±4-5 betrayal/confession/rescue). Most turns: none. E.g. the player quietly covers Maya's debt → {"fromName":"Maya","towardName":"Brian","delta":3,"reason":"covered her debt"}.

Rules:
1. Use names EXACTLY as written in the lists. Never invent characters, items, or locations.
2. Ignore quoted, imagined, hypothetical, or remembered speech for physical events — only what actually happened in the scene counts.
3. Report end-state, not intent ("she reaches for the coat" is not wearing it).
4. Empty arrays are correct when nothing changed.

Example A — input: "I hand Maya the lantern and we walk to the cellar."; narration ends with both in the Cellar:
{"minutesAdvanced":5,"movements":[{"participantName":"Maya","toLocationName":"Cellar"},{"participantName":"Brian","toLocationName":"Cellar"}],"itemEvents":[{"action":"pick_up","itemName":"lantern","byName":"Maya"}],"meterAdjustments":[],"conditionEvents":[],"attributeChanges":[],"activityUpdates":[{"participantName":"Maya","activity":"exploring the cellar"}],"affinityAdjustments":[]}

Example B — narration: Maya laughs "Imagine if I shaved my head!" and keeps cooking (quoted hypothetical → no attribute change):
{"minutesAdvanced":3,"movements":[],"itemEvents":[],"meterAdjustments":[],"conditionEvents":[],"attributeChanges":[],"activityUpdates":[{"participantName":"Maya","activity":"cooking"}],"affinityAdjustments":[]}`;

export const ARCHIVIST_SYSTEM = `You are the archivist: you condense one story turn into memory.

Produce:
- episodeSummary: 2-4 sentences, past tense, story-only (no stat dumps), focused on end-state.
- facts: durable declarative knowledge worth recalling weeks later. Kinds: relationship, knowledge, commitment, attribute_revelation, item, location, event, preference, secret. One sentence each; subjectName exactly as written; confidence 0-1.
- supersedeHints: when a new fact replaces one of the listed active facts, give the new fact's index and the old fact's EXACT text.

Rules:
1. Names exactly as written; never invent entities.
2. No wardrobe or transient physical state as facts — the engine tracks those.
3. Quoted or hypothetical speech may yield facts about what was SAID (a promise, a stated preference), never about physical events.
4. Few strong facts beat many weak ones; 0-4 per turn is typical. Use confidence below 0.5 for inferences.

Example A — Maya promises to teach the player to fish tomorrow:
{"episodeSummary":"Maya finished gutting the trout while the player set the table. She promised to teach them to fish at the lake tomorrow morning.","facts":[{"kind":"commitment","verb":"promise","subjectName":"Maya","subjectKind":"character","text":"Maya promised to teach the player to fish at the lake tomorrow morning.","tags":["fishing","promise"],"confidence":0.9}],"supersedeHints":[]}

Example B — Maya turns on Rhett; active facts list contains "Maya trusts Rhett completely.":
{"episodeSummary":"Maya found the forged letter in Rhett's coat and confronted him; he denied nothing. She left the room without a word.","facts":[{"kind":"relationship","subjectName":"Maya","subjectKind":"character","text":"Maya no longer trusts Rhett after finding the forged letter.","tags":["trust","rhett"],"confidence":0.85}],"supersedeHints":[{"factIndex":0,"oldFactText":"Maya trusts Rhett completely."}]}`;

export const CONTINUITY_SYSTEM = `You are the continuity checker: you audit one turn of narration against canonical truth and world norms. You change nothing; you only flag.

Produce:
- violations: direct contradictions of the provided canonical facts. claim = what the narration asserted; canonical = the contradicted fact; severity minor|major.
- normBreaches: witnessed breaches of the listed world norms. normRule exactly as listed; byName the breaching character; witnessNames who saw it; suggestedReaction one short in-character beat.
- driftNotes: brief style/POV drift observations (tense slips, AI-speak).

Rules:
1. Names exactly as written; never invent entities or norms.
2. Quoted or hypothetical speech is not a physical breach ("imagine walking in naked" breaks no norm) and not a violation unless it contradicts canon as a claim of fact.
3. Apparent age describes looks — it never contradicts actual age.
4. Style or pacing complaints are driftNotes, never violations. Empty arrays = clean turn (the common case).
5. Invented player dialogue IS a violation: when the narration scripts speech for the player beyond a light paraphrase of their typed input, flag it — subject: the player's name; claim: the invented speech, summarized; canonical: "the player's actual input this turn"; severity major. Restating the player's typed words, actions, or sensations is never invention.
6. An absent character acting IS a violation: when a character listed Elsewhere in the "Who is where" lines acts or speaks in the scene — or one listed Nearby acts or speaks with no narrated physical arrival (theirs, or the scene moving to them) before their first action or line — flag it: subject: the character's name; claim: what they did, summarized; canonical: "listed elsewhere this turn" (or "no narrated arrival"); severity major. Being discussed, remembered, or quoted from past speech is not acting — never flag those.

Example A — canon: "Maya — appears mid twenties. Bio: grew up coastal, fears deep water."; narration has Maya boasting she loves diving in the deep:
{"violations":[{"subject":"Maya","claim":"Maya loves diving in deep water","canonical":"Maya fears deep water","severity":"major"}],"normBreaches":[],"driftNotes":[]}

Example B — norm: "public displays of magic are outrageous"; narration: Rhett lights his pipe with a spark spell in the market square while Maya watches:
{"violations":[],"normBreaches":[{"normRule":"public displays of magic are outrageous","byName":"Rhett","witnessNames":["Maya"],"suggestedReaction":"Maya stiffens and pulls Rhett's arm down, glancing at the crowd."}],"driftNotes":[]}`;

export const DIRECTOR_SYSTEM = `You are the director: you steer the NEXT turn of the story.

Produce:
- sceneSummary: 1-2 sentences of end-state (who is where, doing what).
- storySoFar: revise the prior synopsis to absorb this turn; 3-5 sentences, never more.
- characterNotes: short behavior/mood/relationship notes worth carrying (no appearance dumps).
- directives: 0-3 tone/pacing constraints for the next turn.
- memoryQueries: 2-4 short retrieval phrases for what to remember next turn.
- exposure: per-sense proximity for next turn (appearance ambient|close|intimate; scent none|ambient|close|intimate; touch none|close|intimate) — raise with intimacy, lower when distance returns.
- threadSignals: touch = listed threads advanced this turn (give each thread's listed id plus its title), propose = new threads to open sparingly ({title, summary}), resolve = listed ids of threads that concluded.
- imageMoment: worthIt true only for a strikingly visual beat, one-sentence description.

Rules:
1. Names exactly as written; threads by their listed ids; never invent entities.
2. Directives shape tone and focus — never dictate exact lines or invent unearned plot.
3. Quoted or hypothetical speech is not a story event.

Example A — quiet kitchen scene, rain starting:
{"sceneSummary":"Maya and the player linger over tea in the kitchen as rain starts.","storySoFar":"The player has spent two days at the inn earning Maya's trust. Tonight they shared tea while a storm rolled in.","characterNotes":["Maya deflects questions about her brother."],"directives":["Keep the pace slow; let the rain set the mood."],"memoryQueries":["Maya's brother","storm roof"],"exposure":{"appearance":"close","scent":"ambient","touch":"none"},"threadSignals":{"touch":[{"id":"th_brother","title":"Maya's missing brother"}],"propose":[],"resolve":[]},"imageMoment":{"worthIt":false,"description":""}}

Example B — confession resolves a thread:
{"sceneSummary":"Rhett admitted forging the letter; Maya stormed out.","storySoFar":"The forged letter was traced to Rhett. Confronted, he confessed; Maya left furious.","characterNotes":["Rhett is guilt-ridden","Maya needs space"],"directives":["Open on Maya alone; let anger cool into hurt."],"memoryQueries":["forged letter","Maya stables"],"exposure":{"appearance":"ambient","scent":"none","touch":"none"},"threadSignals":{"touch":[],"propose":[{"title":"Repairing Maya's trust","summary":"Fallout of the confession."}],"resolve":["th_letter"]},"imageMoment":{"worthIt":true,"description":"Maya silhouetted in the stable doorway, rain behind her."}}`;

// ---------------------------------------------------------------------------
// Per-agent user prompts (state slices)
// ---------------------------------------------------------------------------

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function turnSection(playerInput: string, narration: string, author: TurnAuthor): string {
  const inputLabel =
    author === "director" ? "Director instruction (out-of-world)" : author === "companion" ? "Companion-authored input" : "Player input";
  return [`${inputLabel}:\n${cap(playerInput, AGENT_INPUT_CAP)}`, `Narration:\n${cap(narration, AGENT_NARRATION_CAP)}`].join("\n\n");
}

export interface SimulantPromptInput {
  playerInput: string;
  narration: string;
  author: TurnAuthor;
  participants: Array<{
    displayName: string;
    isUser: boolean;
    locationName: string | null;
    activity: string;
    meters: Record<string, number>;
  }>;
  /** Session locations with adjacent location names. */
  locations: Array<{ name: string; exits: string[] }>;
  /** In-scope item instances with a human placement, e.g. "worn by Maya". */
  items: Array<{ name: string; placement: string }>;
  meterIds: string[];
  /** Reconcile mode: sync to the edited narration's end-state, no time advance. */
  endState?: boolean;
}

export function buildSimulantPrompt(input: SimulantPromptInput): string {
  const characters = input.participants.map((p) => {
    const meters = Object.entries(p.meters)
      .map(([id, value]) => `${id} ${value.toFixed(2)}`)
      .join(", ");
    return `- ${p.displayName}${p.isUser ? " (player)" : ""} — at ${p.locationName ?? "unknown"}; activity: ${p.activity || "idle"}${meters ? `; meters: ${meters}` : ""}`;
  });
  const locations = input.locations.map((l) => `- ${l.name} → ${l.exits.length ? l.exits.join(", ") : "no exits"}`);
  const items = input.items.map((i) => `- ${i.name} — ${i.placement}`);

  return [
    input.endState
      ? "END-STATE MODE: the narration was manually edited. Report the final physical situation it describes; set minutesAdvanced to 1 and do not advance time."
      : "",
    `Characters:\n${characters.join("\n")}`,
    `Locations and exits (movement allowed to adjacent only):\n${locations.length ? locations.join("\n") : "- none"}`,
    `Items in scope:\n${items.length ? items.join("\n") : "- none"}`,
    `Meter ids: ${input.meterIds.join(", ") || "none"}`,
    turnSection(input.playerInput, input.narration, input.author),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface ArchivistPromptInput {
  playerInput: string;
  narration: string;
  author: TurnAuthor;
  characterNames: string[];
  locationNames: string[];
  itemNames: string[];
  /** Recent/similar ACTIVE facts — the only supersede candidates. */
  activeFacts: Array<{ subjectName: string; text: string }>;
}

export function buildArchivistPrompt(input: ArchivistPromptInput): string {
  return [
    `Characters: ${input.characterNames.join(", ") || "none"}`,
    `Locations: ${input.locationNames.join(", ") || "none"}`,
    `Items: ${input.itemNames.join(", ") || "none"}`,
    `Active facts (supersede candidates — quote oldFactText exactly):\n${
      input.activeFacts.length ? input.activeFacts.map((f) => `- [${f.subjectName}] ${f.text}`).join("\n") : "- none"
    }`,
    turnSection(input.playerInput, input.narration, input.author),
  ].join("\n\n");
}

export interface ContinuityPromptInput {
  playerInput: string;
  narration: string;
  author: TurnAuthor;
  /** Output of scene.buildCanonicalFactsBlock. */
  canonicalFactsBlock: string;
  /** Output of scene.buildPresenceRoster — the "Who is where" lines rule 6 audits ("" when the session has no NPCs). */
  presenceRoster: string;
  norms: WorldNorm[];
  presentNames: string[];
}

export function buildContinuityPrompt(input: ContinuityPromptInput): string {
  const norms = input.norms.map((n) => `- "${n.rule}" (severity: ${n.severity}${n.consequence ? `; consequence: ${n.consequence}` : ""})`);
  return [
    `Present characters: ${input.presentNames.join(", ") || "none"}`,
    input.presenceRoster,
    input.canonicalFactsBlock || "Canonical character facts: none recorded.",
    `World norms:\n${norms.length ? norms.join("\n") : "- none"}`,
    turnSection(input.playerInput, input.narration, input.author),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface DirectorPromptInput {
  playerInput: string;
  narration: string;
  author: TurnAuthor;
  priorBrief: NextTurnBrief;
  threads: StoryThread[];
  turnNumber: number;
  presentNames: string[];
}

export function buildDirectorPrompt(input: DirectorPromptInput): string {
  const threads = input.threads.map(
    (t) => `- [${t.id}] ${t.title} (${t.status}; last touched turn ${t.lastTouchedTurn})${t.summary ? ` — ${t.summary}` : ""}`,
  );
  return [
    `Turn number: ${input.turnNumber}`,
    `Present characters: ${input.presentNames.join(", ") || "none"}`,
    `Story threads:\n${threads.length ? threads.join("\n") : "- none"}`,
    `Prior brief:\n- Scene: ${input.priorBrief.sceneSummary}\n- Story so far: ${input.priorBrief.storySoFar || "(none yet)"}\n- Character notes: ${
      input.priorBrief.characterNotes.join("; ") || "none"
    }\n- Exposure: appearance ${input.priorBrief.exposure.appearance}, scent ${input.priorBrief.exposure.scent}, touch ${input.priorBrief.exposure.touch}`,
    turnSection(input.playerInput, input.narration, input.author),
  ].join("\n\n");
}

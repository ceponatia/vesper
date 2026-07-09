import { severityToTier, type SocialReactionCard } from "@/contracts/personality/cards";
import type { NextTurnBrief } from "@/contracts/state/brief";
import type { StoryThread } from "@/contracts/state/session-runtime";
import type { TurnAuthor } from "@/contracts/turns/stream";
import { AGENT_INPUT_CAP, AGENT_NARRATION_CAP } from "./constants";
import { channelHint } from "./notation";

/**
 * Post-turn agent prompts (docs/prompts.md §Agent prompts). Each system
 * prompt: role, what to extract, what NOT to do, two worked examples — kept
 * under ~600 tokens because they run every turn. User messages carry only the
 * agent's state slice (docs/turn-engine.md §Post-turn agents).
 */

export const SIMULANT_SYSTEM = `You are the simulant: you read one story turn and report what PHYSICALLY changed.

Extract:
- minutesAdvanced: realistic elapsed minutes (dialogue 2-5; a meal 30-45; sleep ~480).
- movements: who ended the turn elsewhere (toLocationName from listed locations).
- itemEvents: wear/remove/pick_up/drop/place/store_in/take_from/open/close/alter — listed items only. Completed wardrobe changes matter most, however gradual the prose. A removed garment lands where the prose leaves it: kept in hand → bare remove; dropped to the floor → remove + locationName; stowed away → remove + containerName. Fumbling isn't removal; finishing is.
- meterAdjustments: deltas in -1..1 for listed meter ids, justified by events (a shower raises hygiene; a sprint drains energy).
- conditionEvents: add/end short-lived states ("soaked", "sprained ankle"); optional severity/durationMinutes/promptHint.
- attributeChanges: rare lasting MUTABLE changes only (haircut, dye, tattoo, weight). NEVER inherent traits — eye color, gender, age, species, bone structure.
- activityUpdates: each named character's end-of-turn activity (posture when clear).
- commsEvents: phone/text links opened/closed this turn ({op:"open"|"close", kind:"call"|"text", withName: other party}). "She picks up" → open call; "hangs up" → close; "texts back" → open text. Never invent comms not shown.
- affinityAdjustments: feeling shifts shown by words or deeds (fromName toward towardName; ±1-2 ordinary, ±4-5 betrayal/rescue). Often none.

Rules:
1. Use names EXACTLY as written in the lists. Never invent characters, items, or locations.
2. Ignore quoted, imagined, hypothetical, or remembered speech — only what happened counts.
3. Report end-state, not intent ("reaches for the coat" isn't wearing it).
4. Empty arrays are correct when nothing changed.
5. Tag notable itemEvents/activityUpdates with salience {visual, audible}. Default obvious + quiet. visual subtle ONLY for a deliberate sneak with someone present to hide from; "quietly" to a lover stays obvious. audible loud = shouts/crashes; silent = soundless acts.

Example A — input: "I quietly pocket the ring while Maya's back is turned"; her phone rings, she answers Rhett (sneak → subtle, answer → obvious; omitted arrays empty):
{"minutesAdvanced":2,"movements":[],"itemEvents":[{"action":"store_in","itemName":"ring","byName":"Brian","salience":{"visual":"subtle","audible":"silent"}}],"activityUpdates":[{"participantName":"Maya","activity":"on the phone","salience":{"visual":"obvious","audible":"quiet"}}],"commsEvents":[{"op":"open","kind":"call","withName":"Rhett"}]}

Example B — Maya laughs "Imagine if I shaved my head!" and keeps cooking (quoted hypothetical → no change):
{"minutesAdvanced":3,"activityUpdates":[{"participantName":"Maya","activity":"cooking"}]}`;

export const ARCHIVIST_SYSTEM = `You are the archivist: you condense one story turn into memory.

Produce:
- episodeSummary: 2-4 sentences, past tense, story-only (no stat dumps), focused on end-state.
- facts: durable declarative knowledge worth recalling weeks later. Kinds: relationship, knowledge, commitment, attribute_revelation, item, location, event, preference, secret. One sentence each; subjectName exactly as written; confidence 0-1; channel one of perceived|private (rule 5).
- supersedeHints: when a new fact replaces one of the listed active facts, give the new fact's index and the old fact's EXACT text.

Rules:
1. Names exactly as written; never invent entities.
2. No wardrobe or transient physical state as facts — the engine tracks those.
3. Quoted or hypothetical speech may yield facts about what was SAID (a promise, a stated preference), never about physical events.
4. Few strong facts beat many weak ones; 0-4 per turn is typical. Use confidence below 0.5 for inferences.
5. Tag each fact with the CHANNEL it was established through: "perceived" for anything a character saw, heard, or was told this turn (the narrated scene, the player's quoted speech, a visible action); "private" ONLY for a fact drawn solely from the player's unspoken inner thoughts, which no character perceived. Default to "perceived" when unsure. Text inside ((double parentheses)) is out-of-character direction — record NO fact from it.

Example A — Maya promises to teach the player to fish tomorrow:
{"episodeSummary":"Maya finished gutting the trout while the player set the table. She promised to teach them to fish at the lake tomorrow morning.","facts":[{"kind":"commitment","verb":"promise","subjectName":"Maya","subjectKind":"character","text":"Maya promised to teach the player to fish at the lake tomorrow morning.","tags":["fishing","promise"],"confidence":0.9,"channel":"perceived"}],"supersedeHints":[]}

Example B — Maya turns on Rhett; active facts list contains "Maya trusts Rhett completely.":
{"episodeSummary":"Maya found the forged letter in Rhett's coat and confronted him; he denied nothing. She left the room without a word.","facts":[{"kind":"relationship","subjectName":"Maya","subjectKind":"character","text":"Maya no longer trusts Rhett after finding the forged letter.","tags":["trust","rhett"],"confidence":0.85,"channel":"perceived"}],"supersedeHints":[{"factIndex":0,"oldFactText":"Maya trusts Rhett completely."}]}`;

export const CONTINUITY_SYSTEM = `You are the continuity checker: you audit one turn of narration against canon and the world's social cards. You only flag.

Produce:
- violations: contradictions of the provided canon. claim = what the narration asserted; canonical = the contradicted fact; severity minor|major; kind (see rules 5-7, default general).
- cardBreaches: witnessed breaches of the listed cards. cardId exactly as listed; concept it amounts to; byName the breacher; witnessNames who saw it. The engine resolves the reaction, not you.
- driftNotes: brief style/POV drift (tense slips, AI-speak).

Rules:
1. Names exactly as written; never invent entities or cards.
2. Quoted or hypothetical speech is not a breach/violation unless it contradicts canon as a claim of fact.
3. Apparent age describes looks — never contradicts actual age.
4. Style/pacing complaints are driftNotes, never violations. Empty arrays = clean turn (common).
5. Invented player dialogue IS a violation: narration scripting player speech beyond a light paraphrase of their input — subject: the player's name; canonical: "the player's actual input this turn"; major. Restating the player's typed words, actions, or sensations is never invention.
6. An absent character acting IS a violation (kind narrated_absent_character, major): someone listed Elsewhere in the "Who is where" lines who acts, speaks, or appears — or one Nearby with no narrated physical arrival first — canonical: "listed elsewhere this turn" (or "no narrated arrival"). A comms-present character speaking is allowed; being discussed or quoted from past speech is not acting. BUT call/text words that place the speaker somewhere the roster contradicts, or summon the player to meet them, ARE a violation (general): claim = the asserted location/meeting; canonical = their listed location.
7. Reacting to the unperceived IS a violation (kind reacted_to_unperceived_event, major): the Awareness lines say a character couldn't perceive something yet they react — e.g. a back-turned character catching a silent act behind them. canonical: "could not perceive it (per awareness)". Other errors stay general.

Example A — canon "Maya fears deep water."; Maya boasts she loves it (contradiction → general):
{"violations":[{"subject":"Maya","claim":"loves deep water","canonical":"Maya fears deep water","severity":"major","kind":"general"}]}

Example B — roster lists Fatima Elsewhere; she strides in and scolds Rhett, while Maya (awareness: absorbed, back turned) spins to a silent wink behind her:
{"violations":[{"subject":"Fatima","claim":"scolded Rhett","canonical":"listed elsewhere this turn","severity":"major","kind":"narrated_absent_character"},{"subject":"Maya","claim":"reacted to a wink she couldn't see","canonical":"could not perceive it (per awareness)","severity":"major","kind":"reacted_to_unperceived_event"}],"cardBreaches":[]}`;

export const DIRECTOR_SYSTEM = `You are the director: you steer the NEXT turn of the story.

Produce:
- sceneSummary: 1-2 sentences of end-state (who is where, doing what).
- storySoFar: revise the prior synopsis to absorb this turn; 3-5 sentences, never more.
- characterNotes: short behavior/mood/relationship notes worth carrying (no appearance dumps).
- directives: 0-3 tone/pacing constraints for the next turn.
- memoryQueries: 2-4 short retrieval phrases for what to remember next turn.
- exposure: per-sense proximity for next turn (appearance ambient|close|intimate; scent none|ambient|close|intimate; touch none|close|intimate; taste none|close|intimate) — raise with intimacy, lower when distance returns. taste is earned at oral contact (a kiss = close, sustained = intimate) and STAYS raised while that contact continues; none when it ends.
- atmosphere: the scene's emotional tone (calm|warm|romantic|tense|ominous|melancholy|hopeful) — the room's mood, not any one character's; omit to hold the current tone.
- threadSignals — keep the thread list in sync (Rules 4-5):
  · touch = a listed thread is still live but nothing major happened ({id, title}; no log entry).
  · develop = a MAJOR beat advanced a listed thread — new evidence, a meaningful statement, a real development (NOT flavor dialogue) — ({id, entry: one line, entryKind?: evidence|statement|event|lead}).
  · propose = open a genuinely new thread, sparingly ({title, kind: investigation|ongoing, question?, summary, closeConditions?}). Set closeConditions for investigations; ongoing threads (e.g. a person's social life) are never resolved.
  · resolve = listed ids of investigations now finished.
- stageMovement — hand the movement system a goal when a beat needs an ABSENT NPC somewhere they're not yet. You DECIDE; you never move anyone. Rule 6.
  · stage = {npcName, destinationName (from the listed locations), reason, onArrivalComms?: {kind: call|text, gist}, onArrivalDirective?}. The NPC walks there off-screen over several turns; the message/beat fires only once they ARRIVE — not this turn.
  · cancel = ids of staged movements (listed under "Staged movements in flight") a newer beat supersedes or that no longer make sense.
- imageMoment: worthIt true only for a strikingly visual beat, one-sentence description.

Rules:
1. Names exactly as written; threads by their listed ids; never invent entities.
2. Directives shape tone and focus — never dictate exact lines or invent unearned plot.
3. Quoted or hypothetical speech is not a story event.
4. Resolve an investigation the moment its need is met — task finished, question answered, problem fixed; mundane completion counts as much as dramatic payoff. Never keep touching/developing a finished thread: an open thread re-enters every future turn's context and is otherwise raised again as if unsettled. Ongoing threads and long-running arcs still in motion stay open.
5. One subject, one thread. Before proposing, scan the listed threads: if the beat belongs to an existing one, develop THAT thread — never open a near-duplicate (don't add "X's odd behavior" when "Investigating X" already exists).
6. An absent NPC cannot be made present, relocated, or made to send a "come here"/location-claiming message through a directive — stage it. stageMovement is the only way to move an off-screen NPC, and the beat fires when they arrive, never the turn you stage it.
7. Honor each present character's disposition (listed when set): characterNotes and directives must fit their temperament — a guarded character resists opening up, a dominant one takes the lead, a volatile one flares, a warm one softens readily. Never steer a character to act against their disposition without an earned, in-world cause.

Example A — keep one thread warm, develop another with a real clue:
{"sceneSummary":"Over tea, Maya lets slip her brother sailed for Tamis.","storySoFar":"Two days earning Maya's trust; tonight she named where her brother went.","characterNotes":["Maya is softening."],"directives":["Keep the pace slow."],"memoryQueries":["Maya's brother Tamis"],"exposure":{"appearance":"close","scent":"ambient","touch":"none","taste":"none"},"atmosphere":"warm","threadSignals":{"touch":[{"id":"th_innkeep","title":"Earning Maya's trust"}],"develop":[{"id":"th_brother","entry":"Maya let slip her brother sailed for Tamis.","entryKind":"evidence"}],"propose":[],"resolve":[]},"imageMoment":{"worthIt":false,"description":""}}

Example B — open a typed investigation (with close conditions) and resolve a finished one:
{"sceneSummary":"Rhett confessed to forging the letter; Maya stormed out.","storySoFar":"The forgery traced to Rhett; confronted, he confessed; Maya left furious.","characterNotes":["Maya needs space."],"directives":["Open on Maya alone."],"memoryQueries":["forged letter"],"exposure":{"appearance":"ambient","scent":"none","touch":"none","taste":"none"},"atmosphere":"tense","threadSignals":{"touch":[],"develop":[],"propose":[{"title":"Repairing Maya's trust","kind":"investigation","question":"Can the player win Maya back?","summary":"Fallout of the confession.","closeConditions":["Maya forgives","Maya cuts ties for good"]}],"resolve":["th_letter"]},"imageMoment":{"worthIt":true,"description":"Maya in the stable doorway, rain behind her."}}

Example C — one subject, one thread: a new Thorne beat folds into the EXISTING investigation via develop, NOT a new propose (Rule 5):
{"sceneSummary":"Gruff Thorne greets the player warmly, then goes quiet; Brian starts asking around.","storySoFar":"Thorne keeps acting out of character; the player is quietly digging into why.","characterNotes":["Thorne is hiding something."],"directives":["Let suspicion build."],"memoryQueries":["Captain Thorne"],"exposure":{"appearance":"ambient","scent":"none","touch":"none","taste":"none"},"atmosphere":"ominous","threadSignals":{"touch":[],"develop":[{"id":"th_thorne","entry":"Warm-then-withdrawn greeting; Brian begins asking around.","entryKind":"statement"}],"propose":[],"resolve":[]},"imageMoment":{"worthIt":false,"description":""}}

Example D — a "come let me in" beat (Rule 6): Maya is listed Elsewhere (clinic), so send her HOME first and arm the text for when she arrives — it does NOT fire this turn (other fields as above):
{"threadSignals":{"propose":[{"title":"Maya locked herself out","kind":"investigation","summary":"Spare key left at the clinic.","closeConditions":["Maya gets inside"]}]},"stageMovement":{"stage":[{"npcName":"Maya","destinationName":"Apartment Hallway","reason":"locked out, coming for help","onArrivalComms":{"kind":"text","gist":"locked out, spare key's at the clinic — can she use the player's phone?"}}],"cancel":[]}}`;

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
    /** Stable trait bands ("Warmth: cold") so raw deltas read in-character (personality §7). */
    traitBands?: string[];
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
    const traits = p.traitBands?.length ? `; disposition: ${p.traitBands.join(", ")}` : "";
    return `- ${p.displayName}${p.isUser ? " (player)" : ""} — at ${p.locationName ?? "unknown"}; activity: ${p.activity || "idle"}${meters ? `; meters: ${meters}` : ""}${traits}`;
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
  /** The embodied player's display name, for the parser-derived channel hint (slice 7). */
  playerName?: string;
}

export function buildArchivistPrompt(input: ArchivistPromptInput): string {
  // Parser-derived channel hint (player-input-perception.plan.md slice 7): when the
  // player marked a thought / OOC aside in THIS turn's input, the shared span parser
  // makes the fact-channel classification deterministic. Reuses the same `./notation`
  // helper the chat archivist does (no clone); "" when no such sigil was used. Player
  // turns only — the sigil grammar is a player convention (a director/companion turn's
  // input is stage direction / NPC speech, not the player's interiority).
  const hint =
    input.author === "player"
      ? channelHint(input.playerInput, {
          knownNames: input.characterNames,
          playerName: input.playerName?.trim() || "the player",
          perceiverClause: "no character in the scene perceived it",
        })
      : "";
  return [
    `Characters: ${input.characterNames.join(", ") || "none"}`,
    `Locations: ${input.locationNames.join(", ") || "none"}`,
    `Items: ${input.itemNames.join(", ") || "none"}`,
    `Active facts (supersede candidates — quote oldFactText exactly):\n${
      input.activeFacts.length ? input.activeFacts.map((f) => `- [${f.subjectName}] ${f.text}`).join("\n") : "- none"
    }`,
    turnSection(input.playerInput, input.narration, input.author),
    ...(hint ? [hint] : []),
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
  /** The world's social-reaction cards — the breach targets the agent flags. */
  socialCards: SocialReactionCard[];
  presentNames: string[];
  /** Per-character awareness/perception lines rule 7 audits; "" omits the heading (set at integration). */
  awarenessBlocks?: string;
}

export function buildContinuityPrompt(input: ContinuityPromptInput): string {
  const cards = input.socialCards.map(
    (c) => `- [${c.id}] "${c.label}" (${severityToTier(c.severity)}; triggers: ${c.triggers.join(", ") || "—"})${c.description ? ` — ${c.description}` : ""}`,
  );
  return [
    `Present characters: ${input.presentNames.join(", ") || "none"}`,
    input.presenceRoster,
    input.awarenessBlocks ? `Awareness (who can perceive what):\n${input.awarenessBlocks}` : "",
    input.canonicalFactsBlock || "Canonical character facts: none recorded.",
    `Social-reaction cards (taboos / rules):\n${cards.length ? cards.join("\n") : "- none"}`,
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
  /**
   * Present NPCs' standing trait bands ("Warmth: cold") so the director's
   * characterNotes and directives fit each one's temperament (Rule 7). Empty /
   * absent ⇒ no disposition block (unchanged behavior for a traitless cast).
   */
  presentDisposition?: Array<{ name: string; bands: string[] }>;
  /** Absent (off-screen) NPCs and where they currently are — candidates to pre-position. */
  absentNpcs: Array<{ name: string; locationName: string | null }>;
  /** All session location names, so a staged destination names a real place. */
  locationNames: string[];
  /** Active staged movements already in flight — avoid duplicates, cancel by id. */
  stagedIntents: Array<{ id: string; npcName: string; destinationName: string; reason: string }>;
}

export function buildDirectorPrompt(input: DirectorPromptInput): string {
  const threads = input.threads.map(
    // kind + development count + age let the director consolidate (develop an
    // existing thread, Rule 5) and judge staleness (resolve a met need, Rule 4).
    (t) =>
      `- [${t.id}] ${t.title} (${t.kind}, ${t.status}; opened turn ${t.openedAtTurn}, last touched turn ${t.lastTouchedTurn}, touched ${t.touchCount}×, ${t.developments.length} developments)${
        t.summary ? ` — ${t.summary}` : ""
      }`,
  );
  const staged = input.stagedIntents.map(
    (s) => `- [${s.id}] ${s.npcName} → ${s.destinationName}${s.reason ? ` (${s.reason})` : ""}`,
  );
  const disposition = (input.presentDisposition ?? []).filter((p) => p.bands.length > 0);
  return [
    `Turn number: ${input.turnNumber}`,
    `Present characters: ${input.presentNames.join(", ") || "none"}`,
    disposition.length
      ? `Present characters' disposition (honor it in characterNotes and directives):\n${disposition.map((p) => `- ${p.name}: ${p.bands.join("; ")}`).join("\n")}`
      : "",
    `Absent characters (off-screen — where they are now): ${
      input.absentNpcs.length ? input.absentNpcs.map((n) => `${n.name} (${n.locationName ?? "unknown"})`).join(", ") : "none"
    }`,
    `Locations you can send someone to: ${input.locationNames.join(", ") || "none"}`,
    `Staged movements in flight:\n${staged.length ? staged.join("\n") : "- none"}`,
    `Story threads:\n${threads.length ? threads.join("\n") : "- none"}`,
    `Prior brief:\n- Scene: ${input.priorBrief.sceneSummary}\n- Story so far: ${input.priorBrief.storySoFar || "(none yet)"}\n- Character notes: ${
      input.priorBrief.characterNotes.join("; ") || "none"
    }\n- Exposure: appearance ${input.priorBrief.exposure.appearance}, scent ${input.priorBrief.exposure.scent}, touch ${input.priorBrief.exposure.touch}, taste ${input.priorBrief.exposure.taste}`,
    turnSection(input.playerInput, input.narration, input.author),
  ]
    .filter(Boolean)
    .join("\n\n");
}

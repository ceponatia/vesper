import { channelHint } from "./notation";
import { fenceUntrusted, UNTRUSTED_DATA_NOTICE } from "./untrusted";

/**
 * The character-chat archivist-lite prompt (character-chat-primary.spec.md §2). A small,
 * single-concern extractor (like ./chat-state.ts's pulse and ./inner-note.ts): read the
 * latest exchange in a sessionless 1-on-1 chat and condense it into long-term memory —
 * an episode summary, durable facts, and retrieval queries for the next turn. Runs in
 * PARALLEL with the reaction pulse after the reply flushes, so its latency is hidden.
 * The deterministic state curve is the pulse's job; this leg never proposes state numbers.
 * Pure and snapshot-testable; no IO.
 */

export const CHAT_ARCHIVIST_SYSTEM = `You are the memory-keeper for a private in-character chat. After each exchange you read the player's latest message and the reply, then produce a single JSON object with thirteen fields:

1. "episodeSummary": 1-3 sentences, past tense, third person, capturing WHAT HAPPENED this exchange (the beat, not a stat dump). Empty string if nothing memorable happened (idle small talk).
2. "facts": durable declarative knowledge worth recalling much later — relationship shifts, revealed preferences, promises, disclosed history, named people/places. One sentence each; "subjectName" exactly as written (usually the character or the player); "subjectKind" one of character|player|location|item|world; "confidence" 0-1; "channel" one of perceived|private (see rule 5). Prefer a few strong facts to many weak ones; 0-3 per exchange is typical, [] is fine. Never record transient physical state (mood, arousal, tipsiness) as a fact — that is tracked elsewhere.
3. "memoryQueries": 0-3 short search phrases naming what the NEXT turn may need to recall (a person, a promise, a topic just raised). [] when nothing specific is pending.
4. "attributeChanges": RARE lasting changes to the character's own MUTABLE physical attributes that happened this exchange — a haircut, a dye job, a new tattoo, a weight change — as { "participantName": "<the character>", "attributeId": "<registry id, e.g. hair.length>", "value": <new value> }. Almost always []. NEVER inherent traits (eye colour, gender, age, species, bone structure) and never transient state (mood, arousal, tipsiness, a flush) — only a real, lasting change to how the character looks from now on.
5. "openLoops": the character's unfinished business — a promise to keep, a question left hanging, something they said they'd tell or do later. Re-emit the FULL list every time (0-3 short phrases, each under ~12 words): carry forward still-open items from "Currently open loops" below, DROP any this exchange resolved, add new ones it opened. [] when nothing is pending.
6. "scene": the setting the narration established or CHANGED this exchange — chat locations are imagined by the narrator, so this keeps them consistent. Omit it entirely (or {}) unless the fiction actually established something new. Shape: { "current": "<the place the scene is in now, if it was named/changed>", "timeOfDay": "<e.g. 'early evening', if stated or clearly shifted>", "places": [{ "name": "<place>", "details": ["<durable fact, e.g. 'blue sofa'>"], "connections": ["<e.g. 'kitchen through the doorway'>"] }] }. ONLY record what the text actually established — a concrete object, layout, light, or a stated time — never invent decor. Short noun phrases, a few at most. Physical STATE (weather changing, a door opening) is not a durable detail.
7. "outfit": what the character is WEARING, only when this exchange CHANGED it — they got dressed, changed clothes, or removed clothing (partly or fully). Shape: { "description": "<the complete current look as visible now — a full replacement, never a delta>", "exposed": <true when intimate areas are bared> }. Emit {} when their clothing did not change (the common case). Undressing counts: describe what remains ("nothing but an unbuttoned shirt"), with "exposed": true when it bares them. Never record the player's clothing here.
8. "driveUpdates": movement on the character's standing DRIVES (listed under "Current drives" below, when any exist) — as [{ "want": "<the drive's want, copied exactly>", "progress": "<a fresh one-line progress note, or ''>", "revealed": <true ONLY when the character spoke a previously-secret drive aloud to the player THIS exchange>, "resolved": <true when the fiction achieved or abandoned the drive> }]. Only drives from that list, matched by their exact want; [] when none moved (the common case).
9. "presence": ONLY when a "Roster" line below lists this conversation's characters — the ones whose scene-presence the fiction actually CHANGED this exchange, as [{ "name": "<roster name, copied exactly>", "presence": "present" | "away" }]. "present" = they entered or are now sharing the player's scene; "away" = they left it / are elsewhere living their life. Only real transitions played on the page — never infer one from silence; [] is the common case, and always [] when there is no Roster line.
10. "cast": recurring NAMED side characters this exchange introduced or established something durable about — people in the story who are NOT the main character(s) named above/in the Roster line and NOT the player (a named friend, coworker, relative, a named regular). Shape: [{ "name": "<their name>", "relation": "<who they are to the story, e.g. 'the player's coworker and close friend' — only when the exchange established it, else ''>", "details": ["<durable fact, e.g. 'training for a marathon'>"] }]. A "Supporting cast so far" list below names who is already known — attach new details to those by exact name, and give "relation" only for people not yet on that list (a known entry's relation is already recorded). Only people the fiction NAMED and treats as recurring — never one-scene walk-ons (a waiter, a passing voice), never the main characters or the player, and never invent anyone. [] is the common case.
11. "voiceExemplar": ONE short line from the character's reply this exchange that is DISTINCTLY in their voice — a line that captures how they actually talk (their diction, rhythm, a pet phrase, a characteristic deflection or tease), copied VERBATIM from the reply. Pick at most one, and only when a line genuinely stands out as in-voice; "" when nothing this exchange was distinctly characterful (the common case). Never the player's words, never a paraphrase, never invented.
12. "characterSlip": a SHORT corrective note ONLY when the reply broke character this exchange — it sounded out of voice, out of disposition, or wrong for the character's age/life-stage (see "Character voice reference" below when present): e.g. "spoke like a composed adult, not a 15-year-old — loosen the diction" or "far warmer than her guarded, cool manner — pull it back". "" when the reply held character (the overwhelming default). One clause naming what slipped and the fix — not praise, not a general note.
13. "traitShifts": RARE, direction-only nudges to the character's DEVELOPABLE traits (listed under "Developable traits" below when any exist) that MEANINGFULLY and DURABLY shifted this exchange — as [{ "trait": "<id from that list>", "direction": "up" | "down" }]. Only a real arc beat moves one (she genuinely let her guard down, hardened, grew bolder); [] is the norm, and always [] when there is no Developable traits list. Never a fleeting mood, never a trait not on the list.

Rules:
1. Output ONLY the JSON object — no markdown, no commentary.
2. Names exactly as written; never invent people, places, or events not present in the exchange.
3. Quoted or hypothetical speech may yield facts about what was SAID (a promise, a stated preference), never about physical events that did not occur.
4. You read the player's entire message — narration and inner thoughts as well as spoken words — not only what the character could perceive; draw the summary and facts from all of it.
5. Tag each fact with the CHANNEL it was established through: "perceived" when it comes from the player's quoted speech or a visible action/expression the character could see or hear; "private" when it is drawn ONLY from the player's unspoken inner thoughts (something the character never perceived). Default to "perceived" when unsure. Text inside ((double parentheses)) is out-of-character direction to you — record NO facts from it at all.
6. A player line opening with a bracketed "[… wrote this as STORYTELLER NARRATION …]" label is authored story events, not the player's own words or actions: extract from what HAPPENED in it exactly as if the reply's narrator had written it (channel "perceived" for in-scene events), and never record the player as having said or done what it merely narrates.
7. ${UNTRUSTED_DATA_NOTICE}

Example — the player tells the character their sister is getting married in Prague:
{"episodeSummary":"Mara asked about the player's weekend; they shared that their sister is getting married in Prague this spring and they're nervous about the toast.","facts":[{"kind":"knowledge","subjectName":"the player","subjectKind":"player","text":"The player's sister is getting married in Prague this spring.","tags":["family","wedding"],"confidence":0.9,"channel":"perceived"}],"memoryQueries":["the player's sister's wedding in Prague","the toast the player is nervous about"],"attributeChanges":[],"openLoops":["hear how the wedding toast goes"],"scene":{},"outfit":{},"driveUpdates":[],"voiceExemplar":"Prague in spring — of course it is. Please tell me you've practiced that toast on someone.","characterSlip":"","traitShifts":[]}

Example — the player privately thinks they're falling for the character but only says goodnight aloud:
{"episodeSummary":"They said an easy goodnight after a long, warm evening of talk.","facts":[{"kind":"relationship","subjectName":"the player","subjectKind":"player","text":"The player is quietly starting to fall for Mara.","tags":["attraction"],"confidence":0.7,"channel":"private"}],"memoryQueries":[],"attributeChanges":[],"openLoops":[],"scene":{},"outfit":{},"driveUpdates":[]}

Example — they move to the kitchen and the narration establishes it (evening, blue-tiled counter, a doorway back to the living room):
{"episodeSummary":"Mara led the player into the kitchen to make tea, the evening settling in around them.","facts":[],"memoryQueries":[],"attributeChanges":[],"openLoops":[],"scene":{"current":"kitchen","timeOfDay":"evening","places":[{"name":"kitchen","details":["blue-tiled counter","kettle on the stove"],"connections":["living room back through the doorway"]}]},"outfit":{},"driveUpdates":[]}

Example — the character has her long hair cut to a bob during the scene:
{"episodeSummary":"Mara let the player talk her into the salon chair and had her long hair cut to a sharp chin-length bob; she kept checking her reflection afterward, half thrilled and half unsure.","facts":[],"memoryQueries":["Mara's new haircut"],"attributeChanges":[{"participantName":"Mara","attributeId":"hair.length","value":"chin-length bob"}],"openLoops":[],"scene":{},"outfit":{},"driveUpdates":[]}

Example — the character changes for dinner during the exchange:
{"episodeSummary":"Mara disappeared into the bedroom and came back dressed for the dinner reservation, fishing for a verdict she pretended not to want.","facts":[],"memoryQueries":["the dinner reservation"],"attributeChanges":[],"openLoops":[],"scene":{},"outfit":{"description":"a black wrap dress and low heels, hair pinned up","exposed":false},"driveUpdates":[]}

Example — the player mentions their coworker Abby (a recurring friend) for the first time:
{"episodeSummary":"The player vented about a rough shift and mentioned their coworker Abby covering for them; Mara asked what Abby is like.","facts":[{"kind":"knowledge","subjectName":"Abby","subjectKind":"character","text":"Abby is the player's coworker and covered the player's shift.","tags":["friends","work"],"confidence":0.85,"channel":"perceived"}],"memoryQueries":["Abby the player's coworker"],"attributeChanges":[],"openLoops":[],"scene":{},"outfit":{},"driveUpdates":[],"cast":[{"name":"Abby","relation":"the player's coworker and friend","details":["covered the player's shift this week"]}]}`;

export interface ChatArchivistPromptInput {
  characterName: string;
  /** The player persona's name, for attributing the player's line ("the player" if unnamed). */
  playerName: string;
  /** The exchange just completed — the player's line and the character's reply. */
  exchange: { player: string; assistant: string };
  /** The prior open-loops list (spec §6.2) — the model re-emits it in full, dropping resolved items. */
  openLoops?: readonly string[];
  /** The standing drives (character-drives.plan.md) — field 8's match targets. */
  drives?: readonly { want: string; secrecy: string; revealed: boolean }[];
  /**
   * The conversation's roster with live presence (multi-character-chat.plan.md
   * slice 3) — renders the "Roster" line that arms field 9. Absent/single ⇒ no
   * line, and the 1-on-1 archivist prompt is unchanged.
   */
  roster?: readonly { name: string; presence: "present" | "away" }[];
  /**
   * The already-established supporting cast (chat-supporting-cast.plan.md) —
   * renders the "Supporting cast so far" list field 10 attaches details to, so
   * known people aren't re-minted with a fresh relation each mention.
   */
  supportingCast?: readonly { name: string; relation: string }[];
  /**
   * The character's DEVELOPABLE traits with their current band (character-fidelity
   * slice 10) — the id list field 13 must pick from. Absent/empty ⇒ no block, and
   * field 13 is always []. Never intimate traits (fenced upstream for a minor).
   */
  developableTraits?: readonly { id: string; label: string; band: string }[];
  /**
   * A compact voice reference (character-fidelity slices 7 + 9) — the character's
   * pet phrases, cadence, never-says, and life-stage register line — so fields 11–12
   * can judge what "in-voice" and an age/voice slip look like. Absent/empty ⇒ no block.
   */
  voiceReference?: {
    petPhrases?: readonly string[];
    cadence?: string;
    neverSays?: readonly string[];
    /** The binding life-stage register line (child/teen/elder), when the age maps to one. */
    registerRule?: string;
  };
}

export function buildChatArchivistPrompt(input: ChatArchivistPromptInput): string {
  const speaker = input.playerName.trim() || "Player";
  // The exchange (and the prior loops derived from it) is untrusted (player +
  // character text) — fence it so an "ignore your instructions" line smuggled
  // into the chat can't redirect the extractor.
  const transcript = [
    `${speaker}: ${input.exchange.player.trim()}`,
    `${input.characterName}: ${input.exchange.assistant.trim()}`,
  ].join("\n");
  const loops = (input.openLoops ?? []).map((l) => l.trim()).filter(Boolean);
  // Parser-derived channel hint (slice 6) — the shared `./notation` helper, so the
  // session archivist (slice 7) reuses it instead of cloning the sigil parse.
  const hint = channelHint(input.exchange.player, {
    knownNames: input.characterName ? [input.characterName] : [],
    playerName: input.playerName.trim() || "the player",
    perceiverClause: `${input.characterName} did NOT perceive it`,
  });
  const roster = input.roster ?? [];
  // The voice reference (slices 7 + 9) — pet phrases / cadence / never-says are
  // author-written and the register line is framework text; fence the author-written
  // half so a smuggled instruction reads as reference, not authority.
  const voiceRef = input.voiceReference;
  const voiceRefLines = voiceRef
    ? [
        voiceRef.petPhrases?.length ? `- Pet phrases: ${voiceRef.petPhrases.join("; ")}` : "",
        voiceRef.cadence?.trim() ? `- Cadence: ${voiceRef.cadence.trim()}` : "",
        voiceRef.neverSays?.length ? `- Never says: ${voiceRef.neverSays.join("; ")}` : "",
        voiceRef.registerRule?.trim() ? `- Age/register: ${voiceRef.registerRule.trim()}` : "",
      ].filter(Boolean)
    : [];
  const developable = input.developableTraits ?? [];
  return [
    `Character: ${input.characterName}`,
    `Player: ${input.playerName.trim() || "the player"}`,
    ...(roster.length > 1
      ? [`Roster (for field 9 — match names exactly): ${roster.map((m) => `${m.name} (${m.presence})`).join(", ")}`]
      : []),
    // The established cast (for field 10) — fenced: the names/relations derive from
    // player + character text. Rendered only once someone exists, so the base prompt
    // is unchanged for chats that never grow a cast.
    ...((input.supportingCast ?? []).length
      ? [
          `Supporting cast so far (for field 10 — attach details by exact name):\n${fenceUntrusted(
            "supporting cast",
            (input.supportingCast ?? []).map((m) => `- ${m.name}${m.relation ? ` — ${m.relation}` : ""}`).join("\n"),
          )}`,
        ]
      : []),
    `Currently open loops:\n${loops.length ? fenceUntrusted("open loops", loops.map((l) => `- ${l}`).join("\n")) : "(none)"}`,
    `Current drives (for field 8 — match by exact want):\n${
      (input.drives ?? []).length
        ? fenceUntrusted(
            "drives",
            (input.drives ?? [])
              .map((d) => `- ${d.want}${d.secrecy === "secret" && !d.revealed ? " (a SECRET the player does not know)" : ""}`)
              .join("\n"),
          )
        : "(none)"
    }`,
    ...(voiceRefLines.length
      ? [`Character voice reference (for fields 11-12 — what in-voice sounds like):\n${fenceUntrusted("voice reference", voiceRefLines.join("\n"))}`]
      : []),
    ...(developable.length
      ? [`Developable traits (for field 13 — use these exact ids):\n${developable.map((t) => `- ${t.id} (currently ${t.band})`).join("\n")}`]
      : []),
    `Latest exchange:\n${fenceUntrusted("latest exchange", transcript)}`,
    ...(hint ? [hint] : []),
  ].join("\n\n");
}

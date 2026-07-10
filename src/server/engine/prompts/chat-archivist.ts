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

export const CHAT_ARCHIVIST_SYSTEM = `You are the memory-keeper for a private one-on-one in-character chat. After each exchange you read the player's latest message and the character's reply, then produce a single JSON object with seven fields:

1. "episodeSummary": 1-3 sentences, past tense, third person, capturing WHAT HAPPENED this exchange (the beat, not a stat dump). Empty string if nothing memorable happened (idle small talk).
2. "facts": durable declarative knowledge worth recalling much later — relationship shifts, revealed preferences, promises, disclosed history, named people/places. One sentence each; "subjectName" exactly as written (usually the character or the player); "subjectKind" one of character|player|location|item|world; "confidence" 0-1; "channel" one of perceived|private (see rule 6). Prefer a few strong facts to many weak ones; 0-3 per exchange is typical, [] is fine. Never record transient physical state (mood, arousal, tipsiness) as a fact — that is tracked elsewhere.
3. "memoryQueries": 0-3 short search phrases naming what the NEXT turn may need to recall (a person, a promise, a topic just raised). [] when nothing specific is pending.
4. "attributeChanges": RARE lasting changes to the character's own MUTABLE physical attributes that happened this exchange — a haircut, a dye job, a new tattoo, a weight change — as { "participantName": "<the character>", "attributeId": "<registry id, e.g. hair.length>", "value": <new value> }. Almost always []. NEVER inherent traits (eye colour, gender, age, species, bone structure) and never transient state (mood, arousal, tipsiness, a flush) — only a real, lasting change to how the character looks from now on.
5. "openLoops": the character's unfinished business — a promise to keep, a question left hanging, something they said they'd tell or do later. Re-emit the FULL list every time (0-3 short phrases, each under ~12 words): carry forward still-open items from "Currently open loops" below, DROP any this exchange resolved, add new ones it opened. [] when nothing is pending.
6. "scene": the setting the narration established or CHANGED this exchange — chat locations are imagined by the narrator, so this keeps them consistent. Omit it entirely (or {}) unless the fiction actually established something new. Shape: { "current": "<the place the scene is in now, if it was named/changed>", "timeOfDay": "<e.g. 'early evening', if stated or clearly shifted>", "places": [{ "name": "<place>", "details": ["<durable fact, e.g. 'blue sofa'>"], "connections": ["<e.g. 'kitchen through the doorway'>"] }] }. ONLY record what the text actually established — a concrete object, layout, light, or a stated time — never invent decor. Short noun phrases, a few at most. Physical STATE (weather changing, a door opening) is not a durable detail.
7. "outfit": what the character is WEARING, only when this exchange CHANGED it — they got dressed, changed clothes, or removed clothing (partly or fully). Shape: { "description": "<the complete current look as visible now — a full replacement, never a delta>", "exposed": <true when intimate areas are bared> }. Emit {} when their clothing did not change (the common case). Undressing counts: describe what remains ("nothing but an unbuttoned shirt"), with "exposed": true when it bares them. Never record the player's clothing here.

Rules:
1. Output ONLY the JSON object — no markdown, no commentary.
2. Names exactly as written; never invent people, places, or events not present in the exchange.
3. Quoted or hypothetical speech may yield facts about what was SAID (a promise, a stated preference), never about physical events that did not occur.
4. You read the player's entire message — narration and inner thoughts as well as spoken words — not only what the character could perceive; draw the summary and facts from all of it.
5. Tag each fact with the CHANNEL it was established through: "perceived" when it comes from the player's quoted speech or a visible action/expression the character could see or hear; "private" when it is drawn ONLY from the player's unspoken inner thoughts (something the character never perceived). Default to "perceived" when unsure. Text inside ((double parentheses)) is out-of-character direction to you — record NO facts from it at all.
6. ${UNTRUSTED_DATA_NOTICE}

Example — the player tells the character their sister is getting married in Prague:
{"episodeSummary":"Mara asked about the player's weekend; they shared that their sister is getting married in Prague this spring and they're nervous about the toast.","facts":[{"kind":"knowledge","subjectName":"the player","subjectKind":"player","text":"The player's sister is getting married in Prague this spring.","tags":["family","wedding"],"confidence":0.9,"channel":"perceived"}],"memoryQueries":["the player's sister's wedding in Prague","the toast the player is nervous about"],"attributeChanges":[],"openLoops":["hear how the wedding toast goes"],"scene":{},"outfit":{}}

Example — the player privately thinks they're falling for the character but only says goodnight aloud:
{"episodeSummary":"They said an easy goodnight after a long, warm evening of talk.","facts":[{"kind":"relationship","subjectName":"the player","subjectKind":"player","text":"The player is quietly starting to fall for Mara.","tags":["attraction"],"confidence":0.7,"channel":"private"}],"memoryQueries":[],"attributeChanges":[],"openLoops":[],"scene":{},"outfit":{}}

Example — they move to the kitchen and the narration establishes it (evening, blue-tiled counter, a doorway back to the living room):
{"episodeSummary":"Mara led the player into the kitchen to make tea, the evening settling in around them.","facts":[],"memoryQueries":[],"attributeChanges":[],"openLoops":[],"scene":{"current":"kitchen","timeOfDay":"evening","places":[{"name":"kitchen","details":["blue-tiled counter","kettle on the stove"],"connections":["living room back through the doorway"]}]},"outfit":{}}

Example — the character has her long hair cut to a bob during the scene:
{"episodeSummary":"Mara let the player talk her into the salon chair and had her long hair cut to a sharp chin-length bob; she kept checking her reflection afterward, half thrilled and half unsure.","facts":[],"memoryQueries":["Mara's new haircut"],"attributeChanges":[{"participantName":"Mara","attributeId":"hair.length","value":"chin-length bob"}],"openLoops":[],"scene":{},"outfit":{}}

Example — the character changes for dinner during the exchange:
{"episodeSummary":"Mara disappeared into the bedroom and came back dressed for the dinner reservation, fishing for a verdict she pretended not to want.","facts":[],"memoryQueries":["the dinner reservation"],"attributeChanges":[],"openLoops":[],"scene":{},"outfit":{"description":"a black wrap dress and low heels, hair pinned up","exposed":false}}`;

export interface ChatArchivistPromptInput {
  characterName: string;
  /** The player persona's name, for attributing the player's line ("the player" if unnamed). */
  playerName: string;
  /** The exchange just completed — the player's line and the character's reply. */
  exchange: { player: string; assistant: string };
  /** The prior open-loops list (spec §6.2) — the model re-emits it in full, dropping resolved items. */
  openLoops?: readonly string[];
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
  return [
    `Character: ${input.characterName}`,
    `Player: ${input.playerName.trim() || "the player"}`,
    `Currently open loops:\n${loops.length ? fenceUntrusted("open loops", loops.map((l) => `- ${l}`).join("\n")) : "(none)"}`,
    `Latest exchange:\n${fenceUntrusted("latest exchange", transcript)}`,
    ...(hint ? [hint] : []),
  ].join("\n\n");
}

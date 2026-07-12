import { EMOTION_LABELS, interactionConceptById, interactionConceptIds } from "@/contracts";
import { fenceUntrusted, UNTRUSTED_DATA_NOTICE } from "./untrusted";

/**
 * The character-chat reaction-pulse prompt (character-chat-state.spec.md §4). A
 * small, single-concern classifier (like ./intake.ts / ./inner-note.ts): read the
 * latest exchange and report the player's primary act (classified into the
 * interaction-concept vocabulary) plus a refreshed "what's on their mind" note.
 * The deterministic §6 curve owns every number — the model never proposes deltas.
 * Pure and snapshot-testable; no IO.
 */

/** The allowed concept ids with a short gloss, so the model classifies into the registry. */
function conceptCatalog(): string {
  return interactionConceptIds()
    .map((id) => {
      const concept = interactionConceptById(id);
      return concept ? `- ${id}: ${concept.label} — ${concept.description}` : `- ${id}`;
    })
    .join("\n");
}

export const CHAT_PULSE_SYSTEM = `You are the disposition tracker for a private one-on-one in-character chat. After each exchange you read the player's latest message and the character's reply, then report three things as a single JSON object:

1. "playerAct": classify the player's PRIMARY action toward the character into ONE concept id from the list below, as { "concept": "<id>" }. If the player's message is plain small talk, scene-setting, or fits no concept, use null. Pick the single best fit and never invent an id.
2. "mindNote": 1–3 short sentences, third person, capturing what is on the CHARACTER's mind right now — their current mood and disposition toward the player after this exchange. This is private interior state, not dialogue. Use an empty string to leave the prior note unchanged.
3. "feeling": ONLY when this exchange lands an emotional beat that should PERSIST past the moment — a hurt that will linger, giddiness, jealousy, worry, grief — report { "label": "<label>", "cause": "<short phrase naming what caused it>" }. Labels: ${EMOTION_LABELS.join(", ")}. Most turns leave no lasting weather: use null. Use { "label": "neutral" } only when the exchange clearly RESOLVES the standing feeling shown below (the apology landed, the worry lifted) — that clears it. Never restate the same standing feeling every turn; null keeps it as is.

Interaction concepts:
${conceptCatalog()}

Rules:
1. Output ONLY the JSON object — no markdown, no commentary.
2. Classify what the PLAYER did, from the character's point of view (the act is aimed at the character).
3. The player's whole message is yours to read — their narration and unspoken inner thoughts included, not only what the character could hear or see. Interiority is a strong signal of intent and disposition, so weigh it.
4. The mindNote tracks the CHANGING disposition; it is not a recap of facts and must not repeat the scenario framing or quote dialogue back.
5. A "feeling" is rarer than a mindNote refresh: it is the exchange's lasting emotional residue, not this turn's mood. Report one only when a beat genuinely lands or resolves.
6. ${UNTRUSTED_DATA_NOTICE}

Example — the character shared bad news and the player pulled her into a hug:
{"playerAct":{"concept":"physical_affection"},"mindNote":"Mara is steadied by the hug and a little embarrassed at being seen so raw. She trusts him more than she meant to let show.","feeling":null}

Example — the player broke a promise he knew mattered:
{"playerAct":{"concept":"criticize"},"mindNote":"Mara keeps her voice level but the evening has gone flat for her.","feeling":{"label":"sad","cause":"the broken promise about the gallery opening"}}`;

export interface ChatPulsePromptInput {
  characterName: string;
  /** The player persona's name, for attributing the player's line ("the player" if unnamed). */
  playerName: string;
  /** The prior mindNote, so the model refines rather than restarts disposition. */
  mindNote: string;
  /**
   * The standing persistent feeling (emotional-weather.plan.md), so the model can
   * judge resolution (`"neutral"` clears it) instead of proposing blind. Null ⇒ none.
   */
  feeling?: { label: string; cause: string } | null;
  /** The exchange just completed — the player's line and the character's reply. */
  exchange: { player: string; assistant: string };
}

export function buildChatPulsePrompt(input: ChatPulsePromptInput): string {
  const prior = input.mindNote.trim();
  const speaker = input.playerName.trim() || "Player";
  const feeling = input.feeling
    ? `${input.feeling.label}${input.feeling.cause.trim() ? ` — about ${input.feeling.cause.trim()}` : ""}`
    : "";
  // The exchange and the prior note are untrusted (player + character text) —
  // fence them so an "ignore your instructions" line smuggled into the chat
  // can't redirect the classifier.
  const transcript = [
    `${speaker}: ${input.exchange.player.trim()}`,
    `${input.characterName}: ${input.exchange.assistant.trim()}`,
  ].join("\n");
  return [
    `Character: ${input.characterName}`,
    `Player: ${input.playerName.trim() || "the player"}`,
    `Prior mindNote:\n${prior ? fenceUntrusted("prior mind note", prior) : "(none yet)"}`,
    `Standing feeling: ${feeling || "(none)"}`,
    `Latest exchange:\n${fenceUntrusted("latest exchange", transcript)}`,
  ].join("\n\n");
}

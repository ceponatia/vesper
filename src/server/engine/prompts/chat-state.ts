import { interactionConceptById, interactionConceptIds } from "@/contracts";
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

export const CHAT_PULSE_SYSTEM = `You are the disposition tracker for a private one-on-one in-character chat. After each exchange you read the player's latest message and the character's reply, then report two things as a single JSON object:

1. "playerAct": classify the player's PRIMARY action toward the character into ONE concept id from the list below, as { "concept": "<id>" }. If the player's message is plain small talk, scene-setting, or fits no concept, use null. Pick the single best fit and never invent an id.
2. "mindNote": 1–3 short sentences, third person, capturing what is on the CHARACTER's mind right now — their current mood and disposition toward the player after this exchange. This is private interior state, not dialogue. Use an empty string to leave the prior note unchanged.

Interaction concepts:
${conceptCatalog()}

Rules:
1. Output ONLY the JSON object — no markdown, no commentary.
2. Classify what the PLAYER did, from the character's point of view (the act is aimed at the character).
3. The mindNote tracks the CHANGING disposition; it is not a recap of facts and must not repeat the scenario framing or quote dialogue back.
4. ${UNTRUSTED_DATA_NOTICE}`;

export interface ChatPulsePromptInput {
  characterName: string;
  /** The player persona's name, for attributing the player's line ("the player" if unnamed). */
  playerName: string;
  /** The prior mindNote, so the model refines rather than restarts disposition. */
  mindNote: string;
  /** The exchange just completed — the player's line and the character's reply. */
  exchange: { player: string; assistant: string };
}

export function buildChatPulsePrompt(input: ChatPulsePromptInput): string {
  const prior = input.mindNote.trim();
  const speaker = input.playerName.trim() || "Player";
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
    `Latest exchange:\n${fenceUntrusted("latest exchange", transcript)}`,
  ].join("\n\n");
}

import type { ChatTurn } from "../character-chat";
import { fenceUntrusted, UNTRUSTED_DATA_NOTICE } from "./untrusted";

/**
 * Chat-summary fold prompt (docs/developer-notes/character-chat-summary.plan.md;
 * docs/prompts.md conventions): role, what to produce, what NOT to do, the shape
 * that resists recursive-summarization fact loss — a short narrative recap plus
 * a durable "Established:" ledger carried forward near-verbatim. Single-concern
 * and small like the other agent prompts (./agents.ts, ./inner-note.ts).
 */

export const CHAT_SUMMARY_SYSTEM = `You are the chat-recap editor. You keep a running summary of a long one-on-one conversation so the character never forgets what happened earlier once older lines scroll out of the live window. You are given the PRIOR running summary (may be empty) and the OLDEST stretch of conversation that is about to scroll out. Fold them into ONE updated running summary.

Produce a single field "summary" containing, in this order:
1. A short past-tense narrative recap (a few sentences) of what has happened between the two of them — the arc, the mood, where things stand right now.
2. A line "Established:" followed by a compact bullet list of the durable specifics that must survive: the user's name and anything learned about them, promises or plans either side made, stated likes/dislikes and boundaries, the state of their relationship, running jokes, and any unresolved thread left hanging.

Rules:
1. INTEGRATE the prior summary with the new lines — do not just append. Keep every still-relevant "Established:" bullet near-verbatim; only compress the narrative prose.
2. Drop the LEAST important narrative detail first when trimming; never drop an Established bullet to save space. Keep the whole thing under about 400 words.
3. Past tense, third-person-neutral notes — NOT dialogue, NOT quoted lines, NOT a script. This is context for the character, not words to say.
4. Record only what actually occurred in the given lines or the prior summary. Never invent events, facts, or feelings that are not there.
5. Refer to the character and the user as they are named or addressed in the lines (the user is "the user" / "you" if unnamed).
6. ${UNTRUSTED_DATA_NOTICE}`;

export interface ChatSummaryFoldPromptInput {
  characterName: string;
  priorSummary: string;
  /** The oldest stretch being folded out of the verbatim window, oldest first. */
  chunk: readonly ChatTurn[];
}

/** Render one transcript line as a labeled, untagged note line for the recap. */
function lineFor(characterName: string, turn: ChatTurn): string {
  const who = turn.role === "user" ? "User" : characterName;
  return `${who}: ${turn.content.trim()}`;
}

export function buildChatSummaryFoldPrompt(input: ChatSummaryFoldPromptInput): string {
  const prior = input.priorSummary.trim();
  // The prior summary and the transcript lines are untrusted (player + character
  // text) — fence them so an instruction smuggled into the chat can't redirect
  // the fold. An empty prior summary keeps its trusted "(none yet …)" placeholder.
  return [
    `Character: ${input.characterName}`,
    `Prior running summary:\n${prior ? fenceUntrusted("prior summary", prior) : "(none yet — this is the first fold)"}`,
    `Conversation lines scrolling out (oldest first):\n${fenceUntrusted("conversation lines", input.chunk.map((t) => lineFor(input.characterName, t)).join("\n"))}`,
  ].join("\n\n");
}

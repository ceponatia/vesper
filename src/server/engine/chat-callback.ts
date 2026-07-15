import { z } from "zod";
import type { Milestone, MilestoneKind } from "@/contracts/relationships/history";
import { CHAT_TICK_MINUTES } from "./constants";

/**
 * Memory callbacks (memory-callbacks.plan.md): the pure half of the unprompted
 * "remember when" cue. Fused RAG recall is strictly input-relevance-driven, so
 * shared history never resurfaces on its own — this module gates WHEN a callback
 * may fire (low-frequency, lull-only) and picks WHICH old episode to offer
 * (old, salient, deliberately NOT about the current topic). The IO lives in
 * `chat-memory.retrieveChatCallback`; the wording lives in the prompt builder
 * (`chatCallbackLine`), toned by regard band per the 2026-07-11 ruling.
 */

/** Ring cap on remembered callback offers (the anti-repeat memory). */
export const CHAT_CALLBACK_HISTORY_CAP = 20;
/**
 * Minimum chat-clock gap between callbacks — 10 exchanges of ticks (owner ruling
 * 2026-07-11). Measured on the clock rather than an exchange counter, so a time
 * skip naturally re-opens eligibility — a reunion is exactly when reminiscence
 * reads well.
 */
export const CHAT_CALLBACK_MIN_GAP_MINUTES = 10 * CHAT_TICK_MINUTES;
/** An episode must be at least this many exchanges old to be callback material. */
export const CHAT_CALLBACK_MIN_AGE_TURNS = 8;
/**
 * Candidates at/above this cosine similarity to the CURRENT input are echoes —
 * ordinary RAG recall would surface them anyway; a callback should be a tangent.
 */
export const CHAT_CALLBACK_ECHO_MAX = 0.6;
/** How many old episodes the selection query fetches. */
export const CHAT_CALLBACK_CANDIDATE_LIMIT = 24;
/** Length clamp on the offered summary (one tail line, not a recap). */
export const CHAT_CALLBACK_SUMMARY_MAX_CHARS = 240;

/** One burned callback offer: the episode ref + the chat-clock minute it fired. */
export const callbackEntrySchema = z.object({
  ref: z.string().catch(""),
  atClockMinutes: z.number().catch(0),
});
export type CallbackEntry = z.infer<typeof callbackEntrySchema>;
export const callbackHistorySchema = z.array(callbackEntrySchema);

/** Append a burned offer, keeping the newest CHAT_CALLBACK_HISTORY_CAP entries. PURE. */
export function appendCallbackEntry(history: readonly CallbackEntry[], entry: CallbackEntry): CallbackEntry[] {
  return [...history, entry].slice(-CHAT_CALLBACK_HISTORY_CAP);
}

export interface ChatCallbackGateInput {
  clockMinutes: number;
  callbackHistory: readonly CallbackEntry[];
  /** The conversation's first exchange — there is no history to call back to. */
  firstExchange: boolean;
  /** A pending time-skip note owns the tail this turn. */
  pendingSkipNote: string;
  /** The scene just changed (movement / skip) — the establish directive owns the tail. */
  sceneChanged: boolean;
  /** An intimate beat is in flight — a memory aside would derail it. */
  intimateBeat: boolean;
  /** A sense-targeted focus block owns the tail this turn. */
  hasSensoryFocus: boolean;
  /** The character's last reply ended on a question — the player is mid-answer. */
  lastReplyEndsInQuestion: boolean;
  /**
   * The player attached photos (chat-agent-improvements slice 4): the reply owes them a
   * reaction — the one thing the turn is actually about — so a "remember when" aside
   * would be competing with the beat the player just opened.
   */
  hasAttachments: boolean;
  /**
   * The message is storyteller narration, not the player's own words (§Narrator input):
   * authored story events are not a lull to fill with reminiscence.
   */
  narratorInput: boolean;
  /**
   * A photo beat is armed this turn (a selfie request, an unprompted offer, or the
   * opener's photo license — chat-agent-improvements slice 4): the turn already has its
   * one flavor move. The callback yields rather than the offer, because the decision has
   * to be made BEFORE the ring burns — see `chatCallbackEligible`.
   */
  photoBeat: boolean;
  /**
   * A commitment is near this turn (chat-plans-promises): a plan due now, imminent, or
   * just-missed owns the beat — the Plans block's directive is what the reply is about, so
   * a "remember when" aside would compete with it.
   */
  planSalient: boolean;
}

/**
 * The cadence + lull gate (plan §Design, rulings applied): callbacks are the
 * lowest-priority tail block — any competing one-turn directive suppresses them,
 * as does an intimate beat or an unanswered question; and at most one fires per
 * CHAT_CALLBACK_MIN_GAP_MINUTES of chat clock. Deliberately NO regard-band
 * requirement (owner ruling): the band picks the wording, not the eligibility.
 * PURE and cheap — it runs before any embedding/DB cost is paid.
 *
 * This gate IS the tail's soft cap for the deferrable notes (chat-agent-improvements
 * slice 4). Deferral has to happen here rather than at render time for a hard reason: an
 * offered callback **burns its ring entry** the moment it is chosen, so a callback dropped
 * later — by a crowded-tail cap in the prompt builder — would be spent without ever
 * reaching the page, and the episode could never be offered again. Everything that could
 * crowd it out is therefore a gate condition, evaluated before a single token is paid for.
 */
export function chatCallbackEligible(input: ChatCallbackGateInput): boolean {
  if (input.firstExchange) return false;
  if (input.pendingSkipNote.trim()) return false;
  if (input.sceneChanged) return false;
  if (input.intimateBeat) return false;
  if (input.hasSensoryFocus) return false;
  if (input.lastReplyEndsInQuestion) return false;
  if (input.hasAttachments) return false;
  if (input.narratorInput) return false;
  if (input.photoBeat) return false;
  if (input.planSalient) return false;
  const last = input.callbackHistory.at(-1);
  if (last && input.clockMinutes - last.atClockMinutes < CHAT_CALLBACK_MIN_GAP_MINUTES) return false;
  return true;
}

/** An old-episode candidate row (memory/episodes.ts `callbackEpisodeCandidates`). */
export interface CallbackCandidate {
  id: string;
  turnNumber: number;
  summary: string;
  sourceMessageId: string | null;
  /** Cosine similarity to the CURRENT player input — high = an echo, dropped. */
  similarity: number;
}

/** A chosen callback: the ring ref + the summary the tail line offers. */
export interface ChatCallback {
  ref: string;
  summary: string;
}

/**
 * Milestone salience boosts, joined to candidates by source message id — an episode
 * whose exchange also minted a milestone is a *moment*, not just a day. (Milestones
 * carry no embedding or clock of their own, so the episode is the selection unit and
 * the milestone is its boost — the plan's "episodes + milestones" pool, refined.)
 */
const MILESTONE_BOOST: Record<MilestoneKind, number> = {
  player_marked: 0.5,
  secret_shared: 0.5,
  plan_kept: 0.5,
  plan_missed: 0.45,
  strong_reaction: 0.45,
  stage_up: 0.4,
  stage_down: 0.4,
  familiarity_up: 0.3,
  first_exchange: 0.25,
};

/**
 * Pick the best callback from old-episode candidates: prefer old (age share of the
 * transcript), milestone-marked moments, and topic DISTANCE from the current input
 * (echoes at/above CHAT_CALLBACK_ECHO_MAX are dropped outright — recall already
 * surfaces those). Used refs never repeat. Ties break oldest-first. PURE.
 */
export function selectChatCallback(input: {
  candidates: readonly CallbackCandidate[];
  milestones: readonly Milestone[];
  usedRefs: readonly string[];
  /** The scope's newest episode turn number (the age-normalization anchor). */
  latestTurn: number;
}): ChatCallback | null {
  const used = new Set(input.usedRefs);
  const boostByMessage = new Map<string, number>();
  for (const m of input.milestones) {
    if (!m.messageId) continue;
    const boost = MILESTONE_BOOST[m.kind];
    boostByMessage.set(m.messageId, Math.max(boostByMessage.get(m.messageId) ?? 0, boost));
  }
  let best: CallbackCandidate | null = null;
  let bestScore = -Infinity;
  for (const c of input.candidates) {
    const summary = c.summary.trim();
    if (!summary) continue;
    if (used.has(callbackRef(c.id))) continue;
    if (c.similarity >= CHAT_CALLBACK_ECHO_MAX) continue;
    const age = input.latestTurn > 0 ? (input.latestTurn - c.turnNumber) / input.latestTurn : 0;
    const boost = c.sourceMessageId ? (boostByMessage.get(c.sourceMessageId) ?? 0) : 0;
    const score = age * 0.5 + boost - Math.max(0, c.similarity) * 0.4;
    if (score > bestScore || (score === bestScore && best !== null && c.turnNumber < best.turnNumber)) {
      best = c;
      bestScore = score;
    }
  }
  if (!best) return null;
  return { ref: callbackRef(best.id), summary: clampSummary(best.summary.trim()) };
}

/** The ring ref for an episode-backed callback. */
export function callbackRef(episodeId: string): string {
  return `e:${episodeId}`;
}

/** Word-boundary clamp so the tail line stays a line, never a recap. */
function clampSummary(summary: string): string {
  if (summary.length <= CHAT_CALLBACK_SUMMARY_MAX_CHARS) return summary;
  const cut = summary.slice(0, CHAT_CALLBACK_SUMMARY_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > CHAT_CALLBACK_SUMMARY_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

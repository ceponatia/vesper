import { z } from "zod";
import { regardBandById } from "@/contracts/relationships/bands";
import { parseMessageSpans } from "@/lib/message-spans";
import { CHAT_TICK_MINUTES } from "./constants";

/**
 * Chat selfies (chat-selfies.plan.md): the pure half of character-sent photo
 * messages. Two triggers share one queue decision: the PLAYER asked for a photo
 * (regex, any register — handing one over face-to-face is the player's call), or
 * the character may OFFER one unprompted — gated APART-ONLY (owner ruling: an
 * unprompted selfie simulates texting, so she only offers when the exchange
 * reads as comms), warm-or-better regard, and a cooldown ring. Either way the
 * render only queues when the pulse read the reply as actually sending one
 * (`sentPhoto`) — a decline in fiction stays a decline.
 */

/** Ring cap on recorded selfie sends (the offer cooldown's memory). */
export const CHAT_SELFIE_HISTORY_CAP = 20;
/** Minimum chat-clock gap between selfies before an unprompted OFFER may fire (~15 exchanges). */
export const CHAT_SELFIE_OFFER_GAP_MINUTES = 15 * CHAT_TICK_MINUTES;
/** Regard floor for an unprompted offer: the `warm` band. */
const OFFER_REGARD_MIN = regardBandById("warm")?.min ?? 50;

/** One recorded selfie send: how it was triggered + the chat-clock minute it queued. */
export const selfieEntrySchema = z.object({
  kind: z.enum(["request", "offer"]).catch("request"),
  atClockMinutes: z.number().catch(0),
});
export type SelfieEntry = z.infer<typeof selfieEntrySchema>;
export const selfieHistorySchema = z.array(selfieEntrySchema);

/** Append a recorded send, keeping the newest CHAT_SELFIE_HISTORY_CAP entries. PURE. */
export function appendSelfieEntry(history: readonly SelfieEntry[], entry: SelfieEntry): SelfieEntry[] {
  return [...history, entry].slice(-CHAT_SELFIE_HISTORY_CAP);
}

/**
 * Does the player's message ask the character to send/take a photo of herself?
 * Regex-first like `detectChatCue`; a false positive only arms a one-turn license
 * the character may decline in fiction (the pulse's `sentPhoto` still decides).
 */
const SELFIE_REQUEST_RE =
  /\b(?:send|text|snap|take|show)\s+(?:me\s+|us\s+)?(?:a|an|another|one more|some)\s+(?:quick\s+|cute\s+|little\s+)?(?:pic(?:ture)?s?|photos?|selfies?)\b|\bsend\s+(?:me\s+)?(?:a\s+)?(?:pic|photo|selfie)\b|\bshow me what you(?:'re| are)? wearing\b|\bcan i see (?:you|what you(?:'re| are)? wearing)\b|\b(?:pic|photo|selfie),? (?:please|pls)\b/i;

export function detectSelfieRequest(input: string): boolean {
  return SELFIE_REQUEST_RE.test(input ?? "");
}

/** True when the text carries a `*Name: …*` texted-comms span (the apart signal). */
export function hasCommsSpans(text: string): boolean {
  if (!text.trim()) return false;
  return parseMessageSpans(text).some((s) => s.kind === "comms");
}

export interface SelfieOfferGateInput {
  regard: number;
  clockMinutes: number;
  selfieHistory: readonly SelfieEntry[];
  /** The player's current message carries a texted-comms span. */
  playerComms: boolean;
  /** The character's last reply carried texted-comms lines. */
  lastReplyComms: boolean;
}

/**
 * May the character OFFER an unprompted selfie this turn? Apart-only (owner
 * ruling — the comms register is the deterministic "not in the same place"
 * signal), warm-or-better regard, and a chat-clock cooldown since the last
 * selfie of either kind. PURE and cheap.
 */
export function chatSelfieOfferEligible(input: SelfieOfferGateInput): boolean {
  if (!input.playerComms && !input.lastReplyComms) return false;
  return chatSelfieOpenerEligible(input);
}

/**
 * May a reopen OPENER attach a selfie (chat-initiative.plan.md slice 5 — the
 * "thinking of you" photo)? Warm-or-better regard + the same cooldown ring; no
 * comms-span requirement — a reopen has no fresh exchange to read the register
 * from, so the license line is register-CONDITIONAL instead ("if you open as a
 * text…") and the fiction enforces apartness: an in-scene opener never "sends"
 * a photo, so the pulse's `sentPhoto` read stays false and nothing queues. PURE.
 */
export function chatSelfieOpenerEligible(
  input: Pick<SelfieOfferGateInput, "regard" | "clockMinutes" | "selfieHistory">,
): boolean {
  if (input.regard < OFFER_REGARD_MIN) return false;
  const last = input.selfieHistory.at(-1);
  if (last && input.clockMinutes - last.atClockMinutes < CHAT_SELFIE_OFFER_GAP_MINUTES) return false;
  return true;
}

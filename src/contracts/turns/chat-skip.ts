import { z } from "zod";

/**
 * Player time skips (character-chat-standalone.spec.md §8.1, D3/D8/D14): in-game
 * time is the only time model — a skip advances the chat clock, lets running timed
 * conditions expire through the existing clock-keyed expiry, stamps the one-shot
 * skip note, and records itself. **Meters do not change** (flavor-only v1 — whether
 * twelve skipped hours mean recovery or deterioration is circumstance, so the full
 * time-effects system stays scaffolded, not wired). The fixed four amounts map to
 * minutes in the engine (`CHAT_SKIP_MINUTES`), never free-form durations.
 */

export const chatSkipAmounts = ["moments", "hours", "overnight", "days"] as const;
export const chatSkipAmountSchema = z.enum(chatSkipAmounts);
export type ChatSkipAmount = z.infer<typeof chatSkipAmountSchema>;

/** Cap on the recorded skip ring — the future time-effects system's data (§8.1). */
export const SKIP_HISTORY_CAP = 50;

export const skipRecordSchema = z.object({
  /** ISO wall timestamp of the skip action (bookkeeping only — never enters the fiction). */
  at: z.string().catch(""),
  /** The in-game clock AFTER the skip. */
  clockMinutes: z.number().catch(0),
  amount: chatSkipAmountSchema.catch("moments"),
});
export type SkipRecord = z.infer<typeof skipRecordSchema>;

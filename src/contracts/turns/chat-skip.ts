import { z } from "zod";

/**
 * Player time skips (character-chat-standalone.spec.md §8.1, D3/D8/D14): in-game
 * time is the only time model — a skip advances the chat clock, lets running timed
 * conditions expire through the existing clock-keyed expiry, stamps the one-shot
 * skip note, and records itself. **Meters do not change** (flavor-only v1 — whether
 * twelve skipped hours mean recovery or deterioration is circumstance, so the full
 * time-effects system stays scaffolded, not wired). The fixed four amounts map to
 * minutes via `CHAT_SKIP_MINUTES` below, never free-form durations.
 */

export const chatSkipAmounts = ["moments", "hours", "overnight", "days"] as const;
export const chatSkipAmountSchema = z.enum(chatSkipAmounts);
export type ChatSkipAmount = z.infer<typeof chatSkipAmountSchema>;

/**
 * In-game minutes per player skip amount (spec §8.1 — a fixed four-value map).
 * Lives on the contract (pure vocabulary) so the clock card / pickup strip can
 * preview a skip's landing; the engine re-exports it beside its tuning siblings.
 */
export const CHAT_SKIP_MINUTES: Record<ChatSkipAmount, number> = {
  moments: 30,
  hours: 180,
  overnight: 540,
  days: 4320,
};

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

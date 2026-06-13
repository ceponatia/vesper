import { z } from "zod";

/**
 * Presence channels (presence-and-perception-spec.phase3.md §presence channels).
 * How a character is present to the player's scene this turn — the deterministic
 * pre-turn classification that replaces the old binary co-location convention.
 *
 * - `sight`  — co-located at perceivable proximity: full presence (act/speak/appear).
 * - `sound`  — audibility-linked location: voice/noise only (reserved; the sound
 *              channel ships post-v1, decision 11 — kept in the enum so the rest
 *              of the system needn't change when it lands).
 * - `comms`  — an active call/text link: may speak, but is not physically here.
 * - `absent` — none: may be referenced or remembered, never enacted.
 */
export const presenceChannelSchema = z.enum(["sight", "sound", "comms", "absent"]);
export type PresenceChannel = z.infer<typeof presenceChannelSchema>;

/** A present character is one the narrator may bring into the scene this turn. */
export function isPresent(channel: PresenceChannel): boolean {
  return channel === "sight" || channel === "sound" || channel === "comms";
}

/** One-line narrator rights per channel, for the presence roster / rulebook. */
export const PRESENCE_CHANNEL_RIGHTS: Record<PresenceChannel, string> = {
  sight: "fully present — may act, speak, and be described",
  sound: "heard only — voice and noise carry, but no visual detail",
  comms: "on a call/text — may speak, but is NOT physically here (no action, no appearance)",
  absent: "not present — may be referenced or remembered, never enacted",
};

import { z } from "zod";

/**
 * The **default player character** (docs/developer-notes/player-character.plan.md):
 * a light, profile-level persona representing the player themselves, set in the
 * settings menu and surfaced in character chat so a character talks *to someone*
 * instead of a faceless "the user".
 *
 * Deliberately a tiny subset of {@link characterProfileSchema} — a name plus a
 * short bio/voice, the "basic fields needed for chat" — not the full character
 * model (no attributes, body, schedule). It is stored as a JSONB blob on the
 * `users` row and read back through `resolvePlayerPersona`, which `parseOr`s it
 * at the trust boundary (docs/resilience.md §1). Growing it later (an avatar for
 * symmetric rendering, or graduating to a real library character the player can
 * also embody in sessions) is additive and needs no migration.
 */
export const playerPersonaSchema = z.object({
  /** Display name the character addresses the player by; blank ⇒ fall back to the account name. */
  name: z.string().trim().min(1).max(80).optional(),
  /** A couple of sentences on who the player is and how they come across (untrusted authored text). */
  persona: z.string().trim().max(2000).default(""),
});
export type StoredPlayerPersona = z.infer<typeof playerPersonaSchema>;

/** The empty persona stored on a fresh user row (no default player character set yet). */
export function emptyPlayerPersona(): StoredPlayerPersona {
  return playerPersonaSchema.parse({});
}

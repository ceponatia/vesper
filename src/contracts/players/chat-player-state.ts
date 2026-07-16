import { z } from "zod";

/**
 * Who the player is in ONE conversation, and what they're wearing
 * (persona-library.plan.md slices 7–8) — the player's half of `character_chat_state`,
 * which is keyed by character and so has nowhere to put them.
 *
 * Chat-wide by nature: one player, many roster characters. It rides ONE jsonb column
 * on `character_chats` (`player_state`), the same call `scene_memory` made, so growing
 * it is never a migration.
 *
 * **Structured-only, and deliberately no `exposed` flag.** The character side keeps a
 * manual `outfitExposed` toggle for its free-text/legacy path; the player has no such
 * path — a persona is a library entity with real outfit presets, so exposure is ALWAYS
 * computed from worn coverage via `exposedRegions`. A togglable flag here would be a
 * hole straight through the scene-image coverage gate that decides whether the viewer's
 * anatomy renders (scene-pov-embodiment.plan.md).
 */
export const chatPlayerStateSchema = z.object({
  /**
   * The persona being played (a `personas.id`). "" ⇒ no pick ⇒ `resolveChatPersona`
   * falls to the owner's default. A dangling id (deleted persona) misses the
   * owner-strict lookup and degrades the same way — never an error.
   */
  personaId: z.string().catch("").default(""),
  /** Worn item-definition ids — THE wardrobe truth, exactly like the character side's `wornItemIds`. */
  wornItemIds: z.array(z.string()).catch([]).default([]),
  /**
   * Has `wornItemIds` been initialized from the persona's wardrobe yet?
   *
   * This exists to break a genuine ambiguity: an empty worn list means **"not dressed
   * yet"** before seeding and **"stripped"** after it, and those must not render the
   * same way. Without the flag, a fresh chat — or a persona whose wardrobe was never
   * authored — would read as *naked*, which is a spectacularly wrong default.
   *
   * `false` ⇒ resolve the persona's default outfit preset instead of the (empty) list.
   * It flips to `true` the moment something actually changes the wardrobe, so the seed
   * materializes on first write rather than as a side effect of a read.
   */
  seeded: z.boolean().catch(false).default(false),
  /** Which of the persona's named outfit presets is on; "" ⇒ none/default. */
  outfitPresetId: z.string().catch("").default(""),
  /**
   * Narrated-but-unowned garments ("a borrowed hoodie") riding alongside the worn list
   * — the same ruling as the character path (no minted chat-scoped items for v1). Text
   * only: it dresses the prose, and contributes NO coverage, so it can't move exposure.
   */
  overlay: z.string().catch("").default(""),
});

export type ChatPlayerState = z.infer<typeof chatPlayerStateSchema>;

/** The empty state — a chat with no persona picked and nothing worn. */
export function emptyChatPlayerState(): ChatPlayerState {
  return chatPlayerStateSchema.parse({});
}

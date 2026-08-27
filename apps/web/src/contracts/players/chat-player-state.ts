import { z } from "zod";

/**
 * Who the player is in ONE conversation, and what they're wearing — the player's
 * half of `character_chat_state`,
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
 * anatomy renders.
 */
/**
 * The worn list, read PER ELEMENT: a malformed element drops alone so the
 * readable rest keeps its coverage, and the read records whether it was
 * COMPLETE — i.e. whether an empty result is the stored truth or the residue
 * of dropped garbage. A value that is not an array at all is unreadable
 * (`undefined` after the catch below).
 */
const wornItemIdsReadSchema = z.array(z.unknown()).transform((raw) => {
  const ids = raw.filter((id): id is string => typeof id === "string");
  return { ids, complete: ids.length === raw.length };
});

const chatPlayerStateShape = z.object({
  /**
   * The persona being played (a `personas.id`). "" ⇒ no pick ⇒ `resolveChatPersona`
   * falls to the owner's default. A dangling id (deleted persona) misses the
   * owner-strict lookup and degrades the same way — never an error.
   */
  personaId: z.string().catch("").default(""),
  /** Worn item-definition ids — THE wardrobe truth, exactly like the character side's `wornItemIds`. */
  wornItemIds: wornItemIdsReadSchema.optional().catch(undefined),
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

/**
 * `seeded: true` over an EMPTY `wornItemIds` is downstream PROOF of a stripped
 * player (`resolvePlayerWardrobe` reads it as `worn: []` — pelvis bare, the
 * scene-image viewer-body gates open). That proof may only stand over a worn
 * list read in full: an unreadable value, or an empty residue whose elements
 * all dropped, degrades `seeded` to `false` — the persona's default outfit,
 * dressed — because malformed data must never fabricate a proven-naked body.
 * A genuinely stored `[]` keeps its proof, and a partial drop with survivors
 * keeps `seeded` (the survivors are the wardrobe we can still read) — but
 * NOT the claim of completeness: the dropped element may have been the pants,
 * so `wornItemIdsIncomplete` rides the parse and `resolvePlayerWardrobe`
 * degrades exposure to covered instead of reading every region the survivors
 * miss as bare. The marker is parse-DERIVED, never persisted truth: healthy
 * writers never produce it, the shape above strips it as an unknown key on
 * reparse, and a re-read of the (all-string) survivor list re-derives nothing.
 */
export const chatPlayerStateSchema = chatPlayerStateShape.transform((state) => {
  const worn = state.wornItemIds;
  return {
    personaId: state.personaId,
    wornItemIds: worn?.ids ?? [],
    seeded: state.seeded && worn !== undefined && (worn.ids.length > 0 || worn.complete),
    outfitPresetId: state.outfitPresetId,
    overlay: state.overlay,
    ...(worn !== undefined && !worn.complete && worn.ids.length > 0
      ? { wornItemIdsIncomplete: true as const }
      : {}),
  };
});

export type ChatPlayerState = z.infer<typeof chatPlayerStateSchema>;

/** The empty state — a chat with no persona picked and nothing worn. */
export function emptyChatPlayerState(): ChatPlayerState {
  return chatPlayerStateSchema.parse({});
}

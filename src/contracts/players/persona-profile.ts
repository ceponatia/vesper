import { z } from "zod";
import { attributeValueSchema } from "../attributes/value";
import { DEFAULT_BODY_PLAN_ID } from "../body/plans";
import { characterProfileSchema, outfitPresetSchema, type CharacterProfile } from "../world/profile";

/**
 * A **persona**'s profile (persona-library.plan.md) — the player's own body, wardrobe
 * and bio, as a library entity.
 *
 * Deliberately a NARROW pick from {@link characterProfileSchema}, not the whole thing
 * (owner ruling 2026-07-16). The dividing line is simple: **the narrator never writes
 * the player's dialogue — the player does** — so every character field that exists to
 * *voice* or *drive* a character is dead weight on a persona and is omitted:
 * `personality`, `drives`, `traits`, `socialCards`, `preferences`, `schedule`,
 * `playerRelationship`, and — the two that look tempting but aren't —
 * `voiceAnchors` + `microExemplars`, which shape *generated* lines.
 *
 * What IS kept, and why:
 * - `bio` — who you are. The graduated home of the old `users.playerPersona.persona` blob.
 * - `voice` — the narrator DOES describe the player's voice ("your voice goes rough"),
 *   even though it never scripts their words.
 * - `intimacy` — **re-purposed semantics.** On a character this is "how they read as a
 *   lover"; on a persona it is "what the player responds to" — guidance for how an NPC
 *   should treat them. Same intimate-tier gate, different framing, so it needs its own
 *   block builder rather than reusing `buildIntimateDispositionBlock`.
 * - `attributes` + `speciesId`/`heritageId`/`bodyPlanId`/`intimateRegions`/`bodyFeatures`
 *   — the body. `intimateRegions` is where anatomy lives; it is already *data*, so a
 *   male persona needs no new vocabulary (it is the same switch a character uses).
 * - `outfits` — the wardrobe presets the chat equip flow draws from.
 *
 * Everything downstream (the wardrobe seam, the attribute picker, the outfit editor,
 * the appearance summarizer, the exposure classifier) already speaks `CharacterProfile`
 * — {@link personaToCharacterProfile} is the ONE adapter that lets them all take a
 * persona unforked. Do not fork any of them.
 */
export const personaProfileSchema = z.object({
  /** Who the player is — the narrator reads this. Untrusted authored text (fence it). */
  bio: z.string().default(""),
  /** How the player's voice sounds; the narrator describes it, never scripts it. */
  voice: z.string().optional(),
  /** What the player responds to — intimate-tier gated. NOT the character semantics. */
  intimacy: z.string().optional(),
  speciesId: z.string().default("human"),
  heritageId: z.string().optional(),
  bodyPlanId: z.string().default(DEFAULT_BODY_PLAN_ID),
  /**
   * Which intimate region groups this body has (e.g. `["penis"]`). The explicit switch
   * the realized-body filter reads to gate intimate anatomy + attributes — identical to
   * the character field, because it is the same registry. `[]` ⇒ no intimate anatomy.
   */
  intimateRegions: z.array(z.string()).default([]),
  bodyFeatures: z.array(z.string()).optional(),
  attributes: z.array(attributeValueSchema).default([]),
  /** Named outfit presets — the pool the chat wardrobe equips from. First is the default. */
  outfits: z
    .array(outfitPresetSchema.nullable().catch(null))
    .catch([])
    .default([])
    .transform((presets) => presets.filter((p): p is z.infer<typeof outfitPresetSchema> => p !== null)),
});

export type PersonaProfile = z.infer<typeof personaProfileSchema>;

/** The empty persona profile — a fresh persona with a default human body and no wardrobe. */
export function emptyPersonaProfile(): PersonaProfile {
  return personaProfileSchema.parse({});
}

/**
 * **The one seam** every character-shaped consumer goes through to take a persona
 * (persona-library.plan.md §"The contract + the adapter"): `resolveChatWardrobe`,
 * `characterAppearanceSummary`, `sceneRevealAppearance`, `identityAnchorSummary`,
 * `AttributePicker`, `OutfitEditor` — all already take a `CharacterProfile` and none
 * are character-coupled, so this buys every one of them with no fork.
 *
 * Implemented by **parsing through `characterProfileSchema` itself** rather than
 * spreading over a hand-written defaults object: zod fills every unlisted field with
 * its own default, so a new field on the character profile can never silently leave
 * this adapter behind. The persona's fields are the only ones that survive; the
 * character-only ones come back empty by construction, which is the invariant the
 * unit tests pin.
 *
 * The optional fields are **conditionally spread**, not passed as `undefined`: zod
 * keeps a key that is explicitly present-but-undefined, which would make the output
 * shape differ from a normally-parsed profile. The adapter's product must be
 * indistinguishable from `characterProfileSchema.parse` of the same data.
 */
export function personaToCharacterProfile(persona: PersonaProfile): CharacterProfile {
  return characterProfileSchema.parse({
    bio: persona.bio,
    ...(persona.voice === undefined ? {} : { voice: persona.voice }),
    ...(persona.intimacy === undefined ? {} : { intimacy: persona.intimacy }),
    speciesId: persona.speciesId,
    ...(persona.heritageId === undefined ? {} : { heritageId: persona.heritageId }),
    bodyPlanId: persona.bodyPlanId,
    intimateRegions: persona.intimateRegions,
    ...(persona.bodyFeatures === undefined ? {} : { bodyFeatures: persona.bodyFeatures }),
    attributes: persona.attributes,
    outfits: persona.outfits,
  });
}

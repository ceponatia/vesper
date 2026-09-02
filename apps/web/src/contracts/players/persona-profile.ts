import { z } from "zod";
import { seedRegistryDefaultValues } from "../attributes";
import { attributeValueSchema } from "../attributes/value";
import { DEFAULT_BODY_PLAN_ID } from "../body/plans";
import { materializeBodyDefaults } from "../species/materialize";
import { seedBodyConfigFromAttributes } from "../species/seed";
import { characterProfileSchema, outfitPresetSchema, type CharacterProfile } from "../world/profile";

/**
 * A **persona**'s profile — the player's own body, wardrobe
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
 * Ground a NEWLY-CREATED persona's body — the single seeding step `POST /api/personas`
 * runs, mirroring what `POST /api/characters` does for a character. Three fills, in
 * order, every one of them fill-only (anything the caller supplied wins):
 *
 * 1. **Curated core-visual defaults** (`seedRegistryDefaultValues`) on a truly blank
 *    body, so a persona born from the library's New button has a usable look — and,
 *    load-bearingly, an `identity.gender` for step 2 to seed *from*. The library
 *    creates every persona with `{title, name}` and no profile, so this is the case
 *    that matters in practice.
 * 2. **The body-config those attribute values activate**
 *    (`seedBodyConfigFromAttributes`) — gender `female` ⇒ `["vulva","breasts"]`.
 * 3. **The persisted-baseline facts** (`materializeBodyDefaults`) against the
 *    *post-seed* body, so the freshly seeded anatomy gates them.
 *
 * Step 2 is gated on the **body-config being empty**, not on the whole profile being
 * blank the way `characters/route.ts` gates it. That gate exists to let authored
 * character bodies — forge drafts, clones — through untouched, and those already carry
 * a seeded config from `character-forge.ts`. A persona has neither a forge nor a clone,
 * so its only non-blank creator is an API client, and one that sends `identity.gender`
 * with no anatomy wants the anatomy that gender activates. A supplied config always
 * wins; re-deriving one after creation (including one the author deliberately emptied)
 * needs a provenance flag this profile does not yet carry, and is deliberately not
 * done here.
 *
 * Before this existed a persona was born at the schema default `intimateRegions: []`
 * and stayed there forever, so every character-shaped consumer reached through
 * {@link personaToCharacterProfile} — the realized-body filter, attribute gating, the
 * scene image queue — saw a player body with no intimate anatomy at all. That is audit
 * finding E1 re-occurring on the player's own avatar.
 */
export function seedNewPersonaProfile(profile: PersonaProfile): PersonaProfile {
  const attributes =
    profile.attributes.length === 0 ? seedRegistryDefaultValues(profile.attributes) : profile.attributes;
  const authoredConfig = profile.intimateRegions.length > 0 || (profile.bodyFeatures?.length ?? 0) > 0;
  const seededConfig = authoredConfig ? undefined : seedBodyConfigFromAttributes(attributes);
  const body: PersonaProfile = {
    ...profile,
    attributes,
    ...(seededConfig
      ? {
          intimateRegions: seededConfig.intimateRegions,
          // An empty feature seed must leave `bodyFeatures` ABSENT rather than write
          // `[]`: `realizeBody` reads omitted as "use the species/heritage defaults"
          // and provided-including-`[]` as an explicit override, so writing the empty
          // seed would strip a succubus persona of its species feature groups.
          ...(seededConfig.bodyFeatures.length > 0 ? { bodyFeatures: seededConfig.bodyFeatures } : {}),
        }
      : {}),
  };
  return { ...body, attributes: materializeBodyDefaults(attributes, body) };
}

/**
 * **The one seam** every character-shaped consumer goes through to take a
 * persona — the contract plus the adapter: `resolveChatWardrobe`, the visual
 * digest's snapshot assembly and the character image adapter behind it,
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

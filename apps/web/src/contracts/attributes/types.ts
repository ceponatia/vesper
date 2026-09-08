import { z } from "zod";
import { attributeCategories, attributeCategorySchema, type AttributeCategory } from "./category-ids";

export const attributeKinds = ["physical", "biological", "presentation", "cultural", "condition", "sensory"] as const;
export const attributeKindSchema = z.enum(attributeKinds);
export type AttributeKind = z.infer<typeof attributeKindSchema>;

export const attributeValueTypes = ["enum", "enum_list", "number", "text", "flag"] as const;
export const attributeValueTypeSchema = z.enum(attributeValueTypes);
export type AttributeValueType = z.infer<typeof attributeValueTypeSchema>;

// `inherent` — structural identity the narrative may not rewrite (eye color, gender,
// species, bone structure); only a human author (`manual`) or an explicit supernatural
// transformation (`magic`) may change it (see `overlaySourceMayChange` in value.ts).
// `mutable` — legitimately changes over play (haircut, dye, tattoo, weight). A former
// `temporary` tier was dropped (zero members, no consumer): transient live state rides
// the arousal meter + conditions, not a mutability tier.
export const attributeMutabilities = ["inherent", "mutable"] as const;
export const attributeMutabilitySchema = z.enum(attributeMutabilities);
export type AttributeMutability = z.infer<typeof attributeMutabilitySchema>;

export const attributeEntityKinds = ["character", "item", "location"] as const;
export const attributeEntityKindSchema = z.enum(attributeEntityKinds);
export type AttributeEntityKind = z.infer<typeof attributeEntityKindSchema>;

export type AttributeIdPattern = `${AttributeCategory}.${string}`;

/** Selection priority for canonical attributes in an image description. */
export const imageAppearanceClasses = ["core", "reinforcement", "fine", "fallback"] as const;
export const imageAppearanceClassSchema = z.enum(imageAppearanceClasses);
export type ImageAppearanceClass = z.infer<typeof imageAppearanceClassSchema>;

/**
 * Ordered camera framing bands used by an inclusive minimum/maximum range.
 * A face detail may span close_up through portrait; categorical height may
 * span full_figure through wide.
 * Required-completeness policy may retain a required core fact independently
 * of this ordinary relevance hint.
 */
export const imageAppearanceMinimumFramings = [
  "close_up",
  "portrait",
  "waist_up",
  "full_figure",
  "wide",
] as const;
export const imageAppearanceMinimumFramingSchema = z.enum(imageAppearanceMinimumFramings);
export type ImageAppearanceMinimumFraming = z.infer<typeof imageAppearanceMinimumFramingSchema>;

export const imageAppearanceMetadataSchema = z.object({
  class: imageAppearanceClassSchema,
  referenceFreeRequired: z.boolean().optional(),
  minimumFraming: imageAppearanceMinimumFramingSchema.optional(),
  maximumFraming: imageAppearanceMinimumFramingSchema.optional(),
  /** Deliberate permission for an intimate shape fact to enter an ordinary image description. */
  ordinarySilhouette: z.boolean().optional(),
  /** Values that are valid storage vocabulary but add no useful image fact. */
  omitValues: z.array(z.string().min(1)).readonly().optional(),
});

export type ImageAppearanceMetadata = z.infer<typeof imageAppearanceMetadataSchema>;

export const attributeIdPatternSchema = z.custom<AttributeIdPattern>(
  (value) => {
    if (typeof value !== "string") return false;
    const dot = value.indexOf(".");
    if (dot <= 0 || dot === value.length - 1) return false;
    const category = value.slice(0, dot);
    const name = value.slice(dot + 1);
    return (
      (attributeCategories as readonly string[]).includes(category) &&
      /^[a-z][a-z0-9_]*$/.test(name)
    );
  },
  { message: "Attribute id must be <category>.<snake_case_name> with a known category, e.g. hair.color" },
);

export const attributeDefinitionSchema = z.object({
  id: attributeIdPatternSchema,
  label: z.string().min(1),
  kind: attributeKindSchema,
  category: attributeCategorySchema,
  valueType: attributeValueTypeSchema,
  description: z.string().min(1),
  mutability: attributeMutabilitySchema,
  allowedValues: z.array(z.string().min(1)).readonly().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().min(1).optional(),
  bodyLocationId: z.string().min(1).optional(),
  appliesToBodyPlans: z.array(z.string().min(1)).readonly().optional(),
  excludesBodyPlans: z.array(z.string().min(1)).readonly().optional(),
  /**
   * Intimate region groups whose presence makes this attribute INAPPLICABLE:
   * when any listed group is switched on in the character's body-config, the
   * region's own attributes own the fact and this one drops out of the
   * realized body (`realizeBody(...).isAttributeApplicable`). The everyday
   * `chest.size` (chest build) lists `breasts` — a body with the breasts region
   * carries `breasts.size` instead, and no consumer ever sees both. Anatomy,
   * not the gender label, decides: the region toggle swaps the pair either way.
   * Group ids are validated against INTIMATE_REGION_GROUPS by a contracts test.
   */
  supersededByIntimateRegions: z.array(z.string().min(1)).readonly().optional(),
  appliesToEntityKinds: z.array(attributeEntityKindSchema).readonly().optional(),
  aliases: z.array(z.string().min(1)).readonly().optional(),
  promptHints: z.array(z.string().min(1)).readonly().optional(),
  /**
   * Per-VALUE narrator gloss: a PARTIAL map from
   * enum member → short authored meaning ("cheesy" → what that reads like *in this game*),
   * rendered inline as a parenthetical wherever a read-side prompt states the resolved
   * value — the same mechanism disposition bands use. Sparse by design: only ambiguous or
   * game-calibrated members get an entry; self-evident ones stay bare. The orthogonality
   * rule is an authoring invariant: a gloss describes ONLY its own attribute's dimension
   * (ordinal context within the dimension is fine; another attribute's dimension is not).
   * Enum/enum_list only; keys must be members of `allowedValues` (enforced at group
   * definition time). Image prompts never render these, same as `promptHints`.
   */
  narratorGuidance: z.record(z.string(), z.string().min(1)).optional(),
  /**
   * Core visual attributes are always filled at character creation: the forge
   * asks the model for a best-guess inference, and anything still unset gets a
   * seeded default from allowedValues (enum only). Mark sparingly — every flag
   * here removes a "sparse is correct" attribute.
   */
  coreVisual: z.boolean().optional(),
  /**
   * Render-consistency visuals: the second always-filled
   * tier after `coreVisual`. Silhouette and face-structure attributes that a
   * scene render RE-INVENTS on every image when left unset (face shape, nose,
   * lips, hair length, waist, leg build …) — cross-scene drift, not sparseness.
   * The forge asks for a plausible range like a core visual and anything still
   * unset gets the seeded fill (`fillVisualDefaults`). Mark sparingly and only
   * on enum attributes: every flag removes a "sparse is correct" attribute, and
   * non-enum values can't be seeded from a closed list.
   */
  renderVisual: z.boolean().optional(),
  /**
   * Image-description selection policy. Separate from `coreVisual` /
   * `renderVisual` creation fills, `identityAnchor` forge inference, and the
   * narrow observer-recognition catalog. The registry owns eligibility and
   * priority; render-specific completeness and visibility remain downstream.
   */
  imageAppearance: imageAppearanceMetadataSchema.optional(),
  /**
   * Curated registry default for this attribute (owner ruling 2026-07-11:
   * female-leaning where the attribute is gendered, since most characters are
   * women). Consumed by `seedRegistryDefaultValues` — blank character creation
   * stores these as real values — and preferred by the editor's
   * `defaultValueFor` seed. The forge does NOT use it for unconstrained fills
   * (its concept-hashed variety is deliberate; a fixed default would converge
   * every unspecified character on the same look). Enum defaults are validated
   * against allowedValues at group definition time.
   */
  defaultValue: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]).optional(),
  /**
   * Persisted-baseline default (pre-slice-3 foot-facts hardening): this
   * attribute's `defaultValue` is MATERIALIZED as a stored fact on every
   * character and player-persona profile at grounding time
   * (`materializeRegistryDefaults`) — not just on blank creations, and not as a
   * read-time fallback. The row is written fill-only (a supplied or existing
   * value always wins) at the low-precedence `creation` source with a versioned
   * `sourceId` (`registry-default:<category>:vN`), so any later narrative,
   * manual, or magic value overrides it and a manual edit stays authoritative.
   * A flagged attribute has no blank state on a stored body: players may change
   * the value, but the tracked fact remains present (PATCH re-materializes).
   * Distinct from `coreVisual` — mark only attributes whose ABSENCE downstream
   * consumers cannot interpret (e.g. the foot domain's structural axes), never
   * to make a look converge. Requires `defaultValue`; enforced at group
   * definition time.
   */
  materializeDefault: z.boolean().optional(),
  /**
   * How this attribute surfaces in a **full-body** image prompt relative to
   * clothing (docs/images/pipelines/scene-subjects.md §Subject body reveal). A
   * waist-up avatar portrait conveys
   * the face and upper body but nothing of the figure below it, so a scene
   * render supplements the reference with body detail:
   * - `"shape"`: silhouette/proportion that reads *through* clothing (breast
   *   size, waist, hips, leg build) — described regardless of coverage.
   * - `"skin"`: surface detail only visible when the region is uncovered
   *   (nipples, leg hair, toenails) — described only when that region is
   *   bare/sheer.
   * Absent ⇒ the attribute is not pulled into the reveal-driven body line (it
   * still flows through the normal appearance summary where applicable). This is
   * consumed by the scene render today; avatars keep strict exposure gating.
   */
  imageReveal: z.enum(["shape", "skin"]).optional(),
  /**
   * Identity anchors are the attributes the forge infers first; they condition
   * the plausible-subset ranges for unset core visuals
   * (docs/authoring/character-forge.md §The three-tier fill). A flag rather
   * than a hardcoded id list in the prompt
   * builder, so adding an anchor (era? regional origin?) stays a registry data
   * edit. Anchors constrain physical attributes only — never personality,
   * voice, behavior, or role.
   */
  identityAnchor: z.boolean().optional(),
  /**
   * Excluded from every **generated prompt** (image, narrator, chat) while still
   * stored, authored, and editable. For an attribute we track but have NOT wired
   * into generation yet — e.g. `identity.natal_sex`, a scaffold for future
   * structured natal-sex handling (the gender `…_born_…` variant steers image
   * rendering for now). Each attribute-iterating prompt builder skips a flagged
   * def, the same per-surface pattern the `apparent_age` exclusions use. See
   * docs/contracts/attributes.md.
   */
  excludeFromPrompts: z.boolean().optional(),
  /**
   * Opt-in for rendering a resolved `"none"` value in generated prompts. By
   * default every prompt builder ELIDES a `"none"` (see `promptValueWithNoneElided`
   * in value.ts): "nose piercings: none" spends tokens to plant the very noun we
   * don't want the model dwelling on, and image models sometimes paint the
   * mentioned feature anyway. Set this only where "none" is itself the appearance
   * fact — a deliberate absence the model would otherwise invent around (e.g.
   * `vulva.pubic_hair_density: none` = fully bare; unstated, the narrator/render
   * is free to imagine hair). Requires "none" in `allowedValues` (enforced at
   * group definition time). Storage/editing is never affected — elision is
   * strictly a prompt-rendering rule.
   */
  renderNoneInPrompts: z.boolean().optional(),
  /**
   * Enum members that are valid vocabulary but must never be chosen as an
   * *automatic* default — neither the forge's tier-3 unconstrained fallback
   * fill (`server/authoring/character-forge/attributes.ts`) nor the picker's initial
   * value when a human adds the attribute (attribute-helpers.ts
   * §defaultValueFor). The model or a human may still select them explicitly.
   * Used so minor apparent ages exist for background characters while an
   * unspecified character never silently defaults to one.
   */
  autoDefaultExcludes: z.array(z.string().min(1)).readonly().optional(),
  /**
   * Declarative body-config activation — a creation-time SEED, never a lock.
   * When this (enum) attribute takes one of these values at character creation,
   * the listed groups are added to the character's body-config: intimate region
   * groups (`CharacterProfile.intimateRegions`) and/or additive feature groups
   * (`CharacterProfile.bodyFeatures`). Keyed by enum member; unlisted members
   * seed nothing. The body-config is authoritative and fully editable
   * thereafter — so `identity.gender = "male"` seeds penis/testicles but a male
   * character can still be given a vulva in the editor (no anatomy lock). Group
   * ids are validated by `seedBodyConfigFromAttributes` against the body-config
   * vocab (INTIMATE_REGION_GROUPS / FEATURE_GROUPS). The body-config starts
   * empty, so "deactivate X" is simply "no value activates X".
   */
  activatesGroups: z
    .record(
      z.string(),
      z.object({
        intimateRegions: z.array(z.string().min(1)).readonly().optional(),
        bodyFeatures: z.array(z.string().min(1)).readonly().optional(),
      }),
    )
    .optional(),
});

export type AttributeDefinition = z.infer<typeof attributeDefinitionSchema>;

/**
 * The definition bundle for one attribute category — one file under
 * `./categories/` per category, built by `defineAttributeGroup`. "Group" here
 * means *this bundle of definitions*, NOT a body section: anatomical sections
 * (head, torso, pelvis …) are body **locations** (`contracts/body/locations`),
 * which attributes link into via `bodyLocationId`.
 */
export interface AttributeGroup {
  category: AttributeCategory;
  definitions: readonly AttributeDefinition[];
}

export function defineAttributeGroup(category: AttributeCategory, definitions: readonly AttributeDefinition[]): AttributeGroup {
  for (const def of definitions) {
    if (def.category !== category) {
      throw new Error(`Attribute ${def.id} declares category ${def.category} inside the ${category} group`);
    }
    // A registry default outside the vocabulary would seed unfixable values.
    if (def.defaultValue !== undefined && def.allowedValues) {
      const defaults = Array.isArray(def.defaultValue) ? def.defaultValue : [def.defaultValue];
      for (const value of defaults) {
        if (typeof value === "string" && !def.allowedValues.includes(value)) {
          throw new Error(`Attribute ${def.id} defaultValue "${value}" is not in allowedValues`);
        }
      }
    }
    // A materialized baseline with nothing to materialize is a definition bug:
    // the flag's whole contract is "this fact is always present on a stored
    // body", and only `defaultValue` can make that true.
    if (def.materializeDefault && def.defaultValue === undefined) {
      throw new Error(`Attribute ${def.id} sets materializeDefault but has no defaultValue`);
    }
    // The flag only means anything when "none" is actually in the vocabulary —
    // set anywhere else it would silently do nothing (or mask a rename).
    if (def.renderNoneInPrompts && !def.allowedValues?.includes("none")) {
      throw new Error(`Attribute ${def.id} sets renderNoneInPrompts but "none" is not in allowedValues`);
    }
    if (def.imageAppearance?.ordinarySilhouette) {
      if (def.id !== "breasts.size" || def.imageReveal !== "shape") {
        throw new Error(
          `Attribute ${def.id} sets imageAppearance.ordinarySilhouette outside the breasts.size shape exception`,
        );
      }
    }
    for (const value of def.imageAppearance?.omitValues ?? []) {
      if (!def.allowedValues?.includes(value)) {
        throw new Error(`Attribute ${def.id} imageAppearance omitValue "${value}" is not in allowedValues`);
      }
    }
    if (def.imageAppearance?.minimumFraming && def.imageAppearance.maximumFraming) {
      const minimum = imageAppearanceMinimumFramings.indexOf(def.imageAppearance.minimumFraming);
      const maximum = imageAppearanceMinimumFramings.indexOf(def.imageAppearance.maximumFraming);
      if (minimum > maximum) {
        throw new Error(
          `Attribute ${def.id} imageAppearance minimumFraming must not be wider than maximumFraming`,
        );
      }
    }
    // Narrator glosses key off enum members — a stray key would never render (or worse,
    // mask a vocabulary rename), so it fails loudly at definition time.
    if (def.narratorGuidance) {
      if (def.valueType !== "enum" && def.valueType !== "enum_list") {
        throw new Error(`Attribute ${def.id} has narratorGuidance but is not an enum/enum_list`);
      }
      for (const key of Object.keys(def.narratorGuidance)) {
        if (!def.allowedValues?.includes(key)) {
          throw new Error(`Attribute ${def.id} narratorGuidance key "${key}" is not in allowedValues`);
        }
      }
    }
  }
  return { category, definitions };
}

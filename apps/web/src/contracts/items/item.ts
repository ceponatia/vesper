import { z } from "zod";
import { hairOcclusionSchema } from "./hair-occlusion";

/** How an item draws or averts a wearer's/holder's attention (relocated from the
 *  deleted perception lane; the item wardrobe schema is its only consumer). */
export const attentionHintSchema = z.enum(["absorbing", "faces_away", "outward"]);
export type AttentionHint = z.infer<typeof attentionHintSchema>;

export const itemKinds = ["clothing", "object", "container"] as const;
export const itemKindSchema = z.enum(itemKinds);
export type ItemKind = z.infer<typeof itemKindSchema>;

export const itemSensorySchema = z.object({
  appearance: z.string().optional(),
  scent: z.string().optional(),
  tactile: z.string().optional(),
});

export const clothingLayerSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
/** 0 underwear · 1 base · 2 mid · 3 outerwear */
export type ClothingLayer = z.infer<typeof clothingLayerSchema>;

export const itemDefinitionSchema = z.object({
  kind: itemKindSchema,
  name: z.string().min(1),
  description: z.string().default(""),
  /** Clothing only: body-location ids this item covers (registry-validated at save). */
  coverage: z.array(z.string().min(1)).default([]),
  /**
   * Clothing only: the category template this item started from (authoring
   * convenience). NEVER serialized into gameplay prompts — the engine reads
   * coverage, not the template name (docs/character-chat/prompts.md §Style
   * rules for prompt text).
   */
  category: z.string().optional().catch(undefined),
  /**
   * Subtype id. Objects: contracts/items/object-subtypes.ts (vocabulary now,
   * behavior later). Clothing: contracts/items/subtypes/ — per-category
   * accessory vocabularies (jewelry/headwear/eyewear) whose labels ARE
   * prompt-bearing ("nose ring — thin gold hoop" reaches image + narrator
   * prompts, unlike category ids).
   */
  subtype: z.string().optional().catch(undefined),
  /**
   * Clothing only: wearer-target id (contracts/items/wearer.ts). Absent =
   * unspecified, which every wearer filter treats as unisex — see
   * `wearerMatchesFilter`.
   */
  wearer: z.string().optional().catch(undefined),
  /**
   * Primary color: `family`/`accent` are color-family ids
   * (contracts/items/colors.ts, UI filtering/sorting only); `shade` is free
   * text ("aqua", "olive") kept for display and image prompts. Any kind may
   * carry one (a red car sorts too); clothing is the primary surface.
   */
  color: z
    .object({
      family: z.string().min(1),
      shade: z.string().optional().catch(undefined),
      accent: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  /**
   * Headwear only: this item's HAIR OCCLUSION band — `none` · `partial` ·
   * `full` (hair-occlusion.ts). Overrides the subtype's default when present
   * (`hairOcclusionForItem`); absent keeps the default, and an unknown value
   * is dropped rather than trusted. Optional so existing rows stay valid.
   */
  hairOcclusion: hairOcclusionSchema.optional().catch(undefined),
  layer: clothingLayerSchema.optional(),
  opacity: z.enum(["opaque", "sheer"]).default("opaque"),
  sensory: itemSensorySchema.default({}),
  /**
   * Perception hint — attention × salience: using this item shapes
   * a character's attention — a sink/desk faces them away from the room
   * (`faces_away`), a task absorbs them (`absorbing`), a lookout faces outward
   * (`outward`). Sharpens derived attention; neutral where unset.
   */
  attentionHint: attentionHintSchema.optional(),
  /** Kind-specific extras: { capacity }, { wearableContainer: true }, … */
  fields: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string()).default([]),
});

export type ItemDefinition = z.infer<typeof itemDefinitionSchema>;

export function emptyItemDefinition(): ItemDefinition {
  return itemDefinitionSchema.parse({ kind: "object", name: "unknown item" });
}

/*
 * `itemInstanceStateSchema` lived here with coarse float condition/cleanliness/
 * wetness fields and ZERO importers in the tree — dead, not dormant. It was
 * deleted rather than bridged onto:
 * the live chat-side instance state is `GarmentConditionState`
 * (garment-instance.ts) with a fixed-point gradient vector, regional overrides,
 * located deposits and damage marks, and the only real bridge target on the
 * successor side is `item-condition-v1`.
 */

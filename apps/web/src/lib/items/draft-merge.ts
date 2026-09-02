import type { ItemDefinitionParts, ItemDraftProposal } from "@/lib/client/api";

/**
 * ✦ Draft from description — the fill-EMPTY-only merge of a registry-grounded
 * proposal into the item editor's unsaved definition
 * (docs/authoring/manual-editing.md §The item editor).
 *
 * An authored value is never overwritten: every facet with an empty state
 * fills only from empty. Opacity has none (it defaults to "opaque"), so a
 * proposal applies only over that default. The SaveBar remains the review
 * step; this is a pure function of the two inputs.
 */
export function mergeItemDraft(def: ItemDefinitionParts, drafted: ItemDraftProposal): ItemDefinitionParts {
  const category = def.category ?? drafted.category ?? null;
  return {
    ...def,
    category,
    subtype: def.subtype ?? drafted.subtype ?? null,
    wearer: def.wearer ?? drafted.wearer ?? null,
    layer: def.layer ?? drafted.layer ?? null,
    color:
      def.color ??
      (drafted.color ? { family: drafted.color.family, shade: drafted.color.shade ?? null, accent: null } : null),
    opacity: def.opacity === "opaque" && drafted.opacity ? drafted.opacity : def.opacity,
    // The headwear hair-occlusion override has an empty state (null = the
    // type default), so it fills like any other facet — and only when the
    // merged item IS headwear, the one category the override means anything on.
    hairOcclusion: def.hairOcclusion ?? (category === "headwear" ? (drafted.hairOcclusion ?? null) : null),
    coverage: def.coverage.length > 0 ? def.coverage : (drafted.coverage ?? def.coverage),
    sensory: {
      appearance: def.sensory.appearance?.trim() ? def.sensory.appearance : drafted.sensory?.appearance,
      scent: def.sensory.scent?.trim() ? def.sensory.scent : drafted.sensory?.scent,
      tactile: def.sensory.tactile?.trim() ? def.sensory.tactile : drafted.sensory?.tactile,
    },
  };
}

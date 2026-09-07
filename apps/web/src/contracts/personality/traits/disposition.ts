import { INTIMATE_TRAIT_CATEGORY } from "./category-ids";
import type { TraitRegistry } from "./registry";
import { resolveTraits, type TraitValue } from "./value";

export interface DispositionBandOptions {
  /** Keep only intimate-category traits (`true`) or only the everyday ones (`false`). */
  intimateOnly: boolean;
  /** Append each band's `promptHint` in parentheses. Default `true`. */
  withHint?: boolean;
}

/**
 * Render a character's resolved trait values as behavioural band phrases
 * ("Warmth: warm (openly affectionate and caring)") — the personality sliders
 * turned into narrator-facing guidance. The single source shared by BOTH the
 * session disposition blocks (engine/scene.ts) and the character-chat prompt
 * (engine/prompts/character-chat/state-sections.ts), so the same authored sliders read
 * identically wherever they surface. Unknown / over-range ids are skipped (the
 * registry clamps), so a stale value never breaks the block. Intimate traits are
 * partitioned out by default so callers can exposure-gate them separately.
 */
export function dispositionBands(
  registry: TraitRegistry,
  traits: readonly TraitValue[],
  { intimateOnly, withHint = true }: DispositionBandOptions,
): string[] {
  const parts: string[] = [];
  for (const value of resolveTraits(traits, [])) {
    const def = registry.byId(value.id);
    if (!def) continue;
    if ((def.category === INTIMATE_TRAIT_CATEGORY) !== intimateOnly) continue;
    const band = registry.bandFor(def.id, value.value);
    if (!band) continue;
    parts.push(`${def.label}: ${band.label}${withHint && band.promptHint ? ` (${band.promptHint})` : ""}`);
  }
  return parts;
}

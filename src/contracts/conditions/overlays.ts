import { attributeRegistry } from "../attributes";
import { overlaySourceMayChange, type AttributeValue } from "../attributes/value";
import type { ActiveCondition } from "./condition";

/**
 * Turn active conditions' `attributeEffects` into attribute overlays
 * (character-chat-state-narration.spec.md §2). The `attributeEffects` field and the
 * `condition` provenance level (precedence 3, above `narrative`) were designed for this
 * but never wired in either lane — this is the conversion. Each effect becomes an
 * `AttributeValue` with `source: "condition"`, `sourceId` = the condition id, so a
 * "disheveled"/"unwashed" condition actually overlays grooming/scent/hair while active.
 *
 * **Guard:** every effect is filtered through `overlaySourceMayChange(def.mutability,
 * "condition")`, so a condition can NEVER rewrite an *inherent* attribute (eye colour,
 * species, gender) — `resolveAttributes` itself is unguarded last-write-wins, so without
 * this a stray effect could silently change a defining trait in the prompt. An unknown
 * attribute id is dropped. Applicability (does this body have the attribute?) is left to
 * the caller's existing `isAttributeApplicable` filter.
 */
export function conditionAttributeOverlays(conditions: readonly ActiveCondition[]): AttributeValue[] {
  const overlays: AttributeValue[] = [];
  for (const condition of conditions) {
    for (const effect of condition.attributeEffects) {
      const def = attributeRegistry.byId(effect.attributeId);
      if (!def) continue; // unknown vocabulary — never leak a raw id
      if (!overlaySourceMayChange(def.mutability, "condition")) continue; // inherent ⇒ dropped
      overlays.push({ id: effect.attributeId, value: effect.value, source: "condition", sourceId: condition.id });
    }
  }
  return overlays;
}

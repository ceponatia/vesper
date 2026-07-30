import { materializeRegistryDefaults, type AttributeValue } from "../attributes";
import { realizeBody, type RealizeBodyInput } from "./realize";

/**
 * Materialize the persisted-baseline registry defaults for ONE body — the
 * species-aware entry every grounding path uses (character create/patch,
 * persona create/patch, the forge's post-grounding fill, the backfill).
 *
 * The realized body supplies all three gates `materializeRegistryDefaults`
 * accepts: applicability (a body plan without feet materializes no foot
 * facts), species-narrowed vocabulary (a default outside the narrowed set is
 * replaced by the species rule's own default or skipped, never invented), and
 * the rule default itself. Fill-only, like the underlying function — authored
 * values always survive.
 */
export function materializeBodyDefaults(values: readonly AttributeValue[], body: RealizeBodyInput): AttributeValue[] {
  const realized = realizeBody(body);
  return materializeRegistryDefaults(values, {
    isApplicable: (def) => realized.isAttributeApplicable(def),
    allowedValuesFor: (def) => realized.allowedValuesFor(def),
    ruleDefaultFor: (def) => realized.defaultValueFor(def),
  });
}

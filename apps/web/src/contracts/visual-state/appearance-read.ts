import {
  attributeRegistry,
  promptValueWithNoneElided,
  resolveAttributes,
  type AttributeDefinition,
  type AttributeValue,
} from "../attributes";
import { isIntimateAttributeCategory } from "../body/locations";
import type { ActiveCondition } from "../conditions/condition";
import { conditionAttributeOverlays } from "../conditions/overlays";
import { realizeBody, type RealizedBody, type RealizeBodyInput } from "../species";

/**
 * THE NARRATOR APPEARANCE READ — the one place that decides which appearance
 * facts are true for a subject right now.
 *
 * Every narration surface needs the same two answers: what this body stably
 * looks like (the authored sheet plus the persisted narrative overlays that
 * evolve over a conversation), and what a live condition is currently changing
 * about it. Those answers were previously re-derived at every site that needed
 * them — the solo Attributes block, the solo sensory cues, the solo transient
 * block, the ensemble member lines and the ensemble transient block — each
 * re-typing the same registry lookup and the same applicability guards, so a
 * vocabulary or guard change had to be made in five places to stay true. This
 * module is that decision, once; presentation (headings, grammar, phrasing,
 * which block a fact is spent in) stays at each prompt boundary.
 *
 * The read is pure: attributes in, facts out. No IO, no environment, no clock,
 * and no dependency on any narration feature switch — ordinary character
 * description is not optional, so nothing here may become conditional on one.
 *
 * ## The guard chain
 *
 * A resolved attribute is a narrator fact only when all of these hold. They are
 * stated here once and nowhere else:
 *
 * - it is not `identity.apparent_age` — the portrait studio's own field, never
 *   the narrator's (the narrator gets the character's real `age`);
 * - the registry knows the id, so a stale or renamed attribute can never leak a
 *   raw id into prose;
 * - the definition is not `excludeFromPrompts` (tracked, deliberately unwired);
 * - it is not intimate sensory — chat carries no exposure signal that earns
 *   intimate scent or taste, so it surfaces nowhere;
 * - this realized body actually has the attribute (`isAttributeApplicable`);
 * - something renders after the prompt-side "none" elision — a "none" plants
 *   the very noun the narrator then riffs on.
 *
 * ## Stable versus current
 *
 * {@link NarratorAppearanceRead.stable} resolves the authored base under the
 * persisted overlays only. {@link NarratorAppearanceRead.current} is the delta a
 * live condition adds on top: the same guard chain over the condition-overlaid
 * resolve, minus every fact the condition left alone. Keeping them separate is
 * what lets a prompt put identity in a cached prefix and the condition's
 * overrides in a volatile tail, so a condition starting or expiring never busts
 * a provider's prefix cache.
 */

/** One appearance fact the narrator may spend, with its definition resolved. */
export interface NarratorAppearanceFact {
  /** The attribute id — the fact's identity across solo, ensemble and projection. */
  readonly id: string;
  readonly def: AttributeDefinition;
  /** The resolved value, as the prompt boundary will phrase it. */
  readonly value: AttributeValue["value"];
  /**
   * A closeness-gated sense: `kind: "sensory"`, not `voice`. Voice carries at
   * any conversational distance, so it is an ordinary fact; scent reads as
   * embodiment when close and as a checklist when listed unconditionally, so a
   * surface that has somewhere better to put it may. Intimate senses never
   * reach this set at all — the guard chain drops them first.
   */
  readonly proximitySensory: boolean;
}

export interface NarratorAppearanceInput {
  /** The authored sheet — the base every overlay resolves over. */
  readonly attributes: readonly AttributeValue[];
  /** Persisted narrative overlays (a recorded haircut or dye). Stable. */
  readonly attributeOverlays?: readonly AttributeValue[];
  /** Live conditions, whose `attributeEffects` become the current-state delta. */
  readonly conditions?: readonly ActiveCondition[];
  /** Species, heritage, body plan, intimate regions and body features. */
  readonly realize?: RealizeBodyInput;
}

export interface NarratorAppearanceRead {
  /** Authored base + persisted overlays, guarded — who this character is. */
  readonly stable: readonly NarratorAppearanceFact[];
  /** Only what an active condition changes right now, guarded the same way. */
  readonly current: readonly NarratorAppearanceFact[];
  /** The stable resolve, unfiltered — for callers that address facts by id. */
  readonly stableResolved: readonly AttributeValue[];
  /** Stable + condition overlays, unfiltered — what the projection is taken over. */
  readonly fullResolved: readonly AttributeValue[];
  /** The realized body the applicability guard ran against. */
  readonly realizedBody: RealizedBody;
}

/** The guard chain, once. `null` ⇒ this resolved value is not a narrator fact. */
function factOf(value: AttributeValue, realizedBody: RealizedBody): NarratorAppearanceFact | null {
  if (value.id === "identity.apparent_age") return null;
  const def = attributeRegistry.byId(value.id);
  if (!def) return null;
  if (def.excludeFromPrompts) return null;
  const sensory = def.kind === "sensory";
  if (sensory && isIntimateAttributeCategory(def.category)) return null;
  if (!realizedBody.isAttributeApplicable(def)) return null;
  const rendered = promptValueWithNoneElided(def, value.value);
  if (rendered === null) return null;
  if (typeof rendered === "boolean" && !rendered) return null;
  if (typeof rendered === "string" && rendered.trim().length === 0) return null;
  if (Array.isArray(rendered) && rendered.length === 0) return null;
  return { id: value.id, def, value: value.value, proximitySensory: sensory && def.category !== "voice" };
}

/**
 * One subject's appearance facts, stable and current.
 *
 * Resolution order is provenance order: the authored base, then the persisted
 * narrative overlays, then this moment's condition overlays. Both overlay
 * sources are guarded at their own write sites against rewriting an inherent
 * attribute (eye colour, species), so a condition can never redefine who
 * somebody is — it can only change how they currently look.
 */
export function readNarratorAppearance(input: NarratorAppearanceInput): NarratorAppearanceRead {
  const overlays = [...(input.attributeOverlays ?? [])];
  const stableResolved = resolveAttributes(input.attributes, overlays);
  const fullResolved = resolveAttributes(input.attributes, [
    ...overlays,
    ...conditionAttributeOverlays([...(input.conditions ?? [])]),
  ]);
  const realizedBody = realizeBody(input.realize ?? {});

  const stable: NarratorAppearanceFact[] = [];
  for (const value of stableResolved) {
    const fact = factOf(value, realizedBody);
    if (fact) stable.push(fact);
  }

  // The current-state delta: a fact the condition overlay actually moved (or
  // introduced). An attribute the condition left alone is already carried by
  // `stable`, and repeating it would read as an override of itself.
  const stableById = new Map(stableResolved.map((value) => [value.id, value]));
  const current: NarratorAppearanceFact[] = [];
  for (const value of fullResolved) {
    const before = stableById.get(value.id);
    if (before && before.value === value.value) continue;
    const fact = factOf(value, realizedBody);
    if (fact) current.push(fact);
  }

  return { stable, current, stableResolved, fullResolved, realizedBody };
}

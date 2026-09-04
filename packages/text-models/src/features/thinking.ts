import { flagFeature, type TextModelFeature } from "./text-feature";

/**
 * The chat template's thinking mode, on or off.
 *
 * It is one feature rather than three because a host that serves it normalizes
 * its synonyms: Featherless documents `enable_thinking`, `thinking` and
 * `do_reasoning` as the same switch with `false` winning any conflict, and each
 * one alone was measured sufficient on the models Vesper asks. The dialect
 * therefore encodes a single key, and this vocabulary carries a single toggle.
 *
 * Absence is not the same as `false`. A model whose template has no thinking
 * mode gains nothing from the key, and a model whose template spells it
 * differently would ignore it just as quietly — so a profile states this only
 * where the flag has been measured to change the reply.
 */
export function thinkingFeature(): TextModelFeature {
  return flagFeature({
    id: "thinking",
    semantic: "Turns the chat template's thinking mode on or off for this call.",
  });
}

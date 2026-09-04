import { numericFeature, stringListFeature, type TextModelFeature } from "./text-feature";

/**
 * Where a completion is allowed to stop, and where it is not allowed to stop
 * yet.
 *
 * The two token bounds are a pair worth reading together: a maximum protects
 * the lane's budget, a minimum protects against a model that stops before it
 * says anything. Vesper only ever asks for the minimum on a retry that followed
 * a genuinely silent stop, and the execution hints carry that policy — the
 * feature here is only the ability to ask.
 */

/**
 * Literal strings that end the completion when generated.
 *
 * A list of at least one non-blank string. The entries are literal text, not
 * patterns, and the empty list is refused: omitting the key is how a profile
 * says it sends none.
 */
export function stopFeature(): TextModelFeature {
  return stringListFeature({
    id: "stop",
    semantic: "Ends the completion as soon as one of these literal strings is generated.",
  });
}

/**
 * The floor on generated tokens.
 *
 * Band: whole numbers, 0 or above, where 0 is the same as absence. A floor
 * applied to every call is how narrator padding gets resurrected, so a profile
 * that carries one is stating a retry policy, not a default — which is why the
 * lane-level version of this number lives in the execution hints instead.
 */
export function minTokensFeature(): TextModelFeature {
  return numericFeature({
    id: "minTokens",
    semantic: "Refuses to stop the completion before this many tokens have been generated.",
    min: 0,
    integer: true,
  });
}

/**
 * The ceiling on generated tokens.
 *
 * Band: whole numbers of 1 or above. Zero is excluded because a completion
 * budget of nothing is not a small request, it is a request for an empty reply
 * that reads exactly like a model failure.
 */
export function maxTokensFeature(): TextModelFeature {
  return numericFeature({
    id: "maxTokens",
    semantic: "Caps how many tokens the completion may generate.",
    min: 1,
    integer: true,
  });
}

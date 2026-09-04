import { numericFeature, type TextModelFeature } from "./text-feature";

/**
 * The repetition pressures, and the one window that scopes the oldest of them.
 *
 * Three of the four are neutral at a different number — repetition penalty at
 * 1.0, the two additive penalties at 0.0 — so an adapter that sets one of them
 * to a "safe-looking" zero is not being conservative, it is asking for
 * unbounded repetition. The bands keep both neutral points inside the interior
 * of the range, where a mistake reads as a value rather than as an edge.
 */

/**
 * Multiplicative pressure against tokens already in the context.
 *
 * Band: 0 through 2, the interval OpenRouter documents, neutral at 1.0. Values
 * below 1 actively ENCOURAGE repetition, which is a legitimate thing to ask
 * for, so the floor is 0 rather than 1.
 */
export function repetitionPenaltyFeature(): TextModelFeature {
  return numericFeature({
    id: "repetitionPenalty",
    semantic: "Scales down the likelihood of tokens that already appeared in the context.",
    min: 0,
    max: 2,
  });
}

/**
 * How far back the repetition penalty looks.
 *
 * Band: whole numbers, 0 or above, where 0 means the whole context — the
 * KoboldCpp convention the author profiles are written in. It is a token count,
 * so a fractional value is a typo rather than a fine adjustment.
 */
export function repetitionPenaltyRangeFeature(): TextModelFeature {
  return numericFeature({
    id: "repetitionPenaltyRange",
    semantic: "Limits the repetition penalty to the most recent tokens rather than the whole context.",
    min: 0,
    integer: true,
  });
}

/**
 * Flat pressure against any token that has appeared at all.
 *
 * Band: -2 through 2, neutral at 0 — the OpenAI-compatible convention both
 * hosted dialects inherit. A negative value asks for repetition on purpose.
 */
export function presencePenaltyFeature(): TextModelFeature {
  return numericFeature({
    id: "presencePenalty",
    semantic: "Applies one flat penalty to every token that has already appeared, however often.",
    min: -2,
    max: 2,
  });
}

/**
 * Pressure that grows with how often a token has appeared.
 *
 * Band: -2 through 2, neutral at 0 — the same OpenAI-compatible convention as
 * presence pressure, and the difference between the two is the whole point:
 * presence charges once, frequency charges per occurrence.
 */
export function frequencyPenaltyFeature(): TextModelFeature {
  return numericFeature({
    id: "frequencyPenalty",
    semantic: "Penalises a token in proportion to how many times it has already appeared.",
    min: -2,
    max: 2,
  });
}

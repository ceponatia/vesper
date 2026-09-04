import { numericFeature, type TextModelFeature } from "./text-feature";

/**
 * The four truncation knobs every hosted upstream serves, plus the seed.
 *
 * Grouped in one module because they are the same shape of decision — how much
 * of the token distribution survives before sampling — asked four different
 * ways. The bands below are the widest band that is meaningful to a sampler,
 * not the band one model's author recommends: a recommendation is a value in a
 * profile, and a profile is what a reviewer reads.
 */

/**
 * How flat the token distribution is made before truncation.
 *
 * Band: 0 through 2. Zero is greedy decoding, and 2 is the ceiling every host
 * in the dialect tables documents — OpenRouter states 0.0 to 2.0, and the
 * OpenAI-compatible bodies take the same band. Local runtimes accept more; a
 * self-hosted profile that genuinely wants it widens this band, which is a
 * one-line data edit and a reviewable claim rather than a silent pass-through.
 */
export function temperatureFeature(): TextModelFeature {
  return numericFeature({
    id: "temperature",
    semantic: "Flattens or sharpens the token distribution before any truncation is applied.",
    min: 0,
    max: 2,
  });
}

/**
 * Nucleus sampling: keep the smallest set of tokens whose probabilities sum to
 * this much.
 *
 * Band: above 0, up to 1 — the interval Featherless documents. One keeps the
 * whole distribution and is the disabling value; zero is excluded because a
 * nucleus containing no tokens is not a weaker filter, it is an empty one.
 */
export function topPFeature(): TextModelFeature {
  return numericFeature({
    id: "topP",
    semantic: "Keeps only the smallest set of tokens whose probability mass reaches this fraction.",
    min: 0,
    max: 1,
    minExclusive: true,
  });
}

/**
 * Keep only this many of the most probable tokens.
 *
 * Band: whole numbers of -1 or above. The floor is -1 rather than 0 because the
 * two hosts spell "off" differently and both spellings have to be legal in one
 * profile: Featherless documents -1 as "consider all tokens", OpenRouter
 * documents 0 as the disabled default.
 */
export function topKFeature(): TextModelFeature {
  return numericFeature({
    id: "topK",
    semantic: "Keeps only this many of the most probable tokens.",
    min: -1,
    integer: true,
  });
}

/**
 * Drop every token less probable than this fraction of the most probable one.
 *
 * Band: 0 through 1, the interval Featherless documents, where 0 disables the
 * filter. Unlike nucleus sampling this is a RELATIVE floor, so it holds its
 * meaning at any temperature — which is why the author profiles this package
 * exists to carry tend to set it and leave `topP` at 1.
 */
export function minPFeature(): TextModelFeature {
  return numericFeature({
    id: "minP",
    semantic: "Drops tokens whose probability falls below this fraction of the most probable token's.",
    min: 0,
    max: 1,
  });
}

/**
 * Ask for a reproducible sample.
 *
 * Band: whole numbers, 0 or above. Declaring one is a claim about intent, not
 * about the host: Featherless documents its seed as unreliable because a call
 * may land on any of several servers, and a profile that sets a seed there is
 * asking, not guaranteeing.
 */
export function seedFeature(): TextModelFeature {
  return numericFeature({
    id: "seed",
    semantic: "Asks the sampler for a reproducible draw rather than a fresh one.",
    min: 0,
    integer: true,
  });
}

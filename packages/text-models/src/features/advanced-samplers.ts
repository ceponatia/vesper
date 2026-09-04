import {
  isTokenBiasMap,
  numericFeature,
  stringListFeature,
  type TextModelFeature,
  type TextProfileValue,
} from "./text-feature";

/**
 * The samplers a local runtime serves and no hosted upstream Vesper reaches
 * documents.
 *
 * They are in the vocabulary anyway, and that is the design rather than an
 * oversight. An author tunes a model in KoboldCpp and publishes the whole
 * profile; Vesper's adapter carries the whole profile, so the record of how the
 * model was meant to be asked survives in one reviewable place. Which of them
 * actually reach a wire is a HOST question, answered by the dialect tables and
 * reported per call in the bound profile's withheld list — never by dropping
 * the value at authoring time, where it would simply be lost.
 *
 * That is also why the bands here follow the local runtimes' conventions rather
 * than an API's: these numbers were chosen against llama.cpp and KoboldCpp, and
 * a band that quietly narrowed them would refuse the very profile this package
 * exists to preserve.
 */

/**
 * Keep only tokens within this many standard deviations of the top logit.
 *
 * Band: 0 or above. Local runtimes spell "off" as a negative value and Vesper
 * spells it as absence, so the band starts at the first meaningful setting
 * instead of carrying a second disabling convention.
 */
export function topNsigmaFeature(): TextModelFeature {
  return numericFeature({
    id: "topNsigma",
    semantic: "Keeps only tokens whose logit is within this many standard deviations of the highest.",
    min: 0,
  });
}

/**
 * How hard the DRY sampler penalises a repeated sequence.
 *
 * Band: 0 or above, where 0 disables DRY entirely — the multiplier is the
 * sampler's on switch, which is why the other three DRY fields mean nothing
 * without it.
 */
export function dryMultiplierFeature(): TextModelFeature {
  return numericFeature({
    id: "dryMultiplier",
    semantic: "Scales the penalty the DRY sampler applies to a repeated token sequence.",
    min: 0,
  });
}

/**
 * The base of DRY's exponential growth with sequence length.
 *
 * Band: 1 or above. A base below 1 would shrink the penalty as the repeated
 * sequence got longer, which inverts the sampler.
 */
export function dryBaseFeature(): TextModelFeature {
  return numericFeature({
    id: "dryBase",
    semantic: "Sets how steeply DRY's penalty grows with the length of the repeated sequence.",
    min: 1,
  });
}

/**
 * How long a repeat may be before DRY charges for it.
 *
 * Band: whole numbers, 0 or above. It is a token count, so a fractional value
 * is a typo.
 */
export function dryAllowedLengthFeature(): TextModelFeature {
  return numericFeature({
    id: "dryAllowedLength",
    semantic: "Allows repeated sequences up to this many tokens before DRY penalises them.",
    min: 0,
    integer: true,
  });
}

/**
 * The strings DRY treats as the end of a sequence.
 *
 * Literal text, at least one entry. Omitting the key is how a profile says it
 * breaks on nothing.
 */
export function drySequenceBreakersFeature(): TextModelFeature {
  return stringListFeature({
    id: "drySequenceBreakers",
    semantic: "Treats each of these literal strings as the end of a sequence DRY is tracking.",
  });
}

/**
 * How far below the top token XTC will still consider a token for exclusion.
 *
 * Band: 0 through 1. Local runtimes treat a threshold above 0.5 as disabling
 * because no second token can clear it, and that disabling value stays inside
 * the band rather than being refused — a profile is allowed to say "off" the
 * way its author wrote it.
 */
export function xtcThresholdFeature(): TextModelFeature {
  return numericFeature({
    id: "xtcThreshold",
    semantic: "Marks tokens above this probability as top choices XTC may exclude.",
    min: 0,
    max: 1,
  });
}

/**
 * How often XTC actually removes the top choices it marked.
 *
 * Band: 0 through 1, a probability, where 0 disables the sampler.
 */
export function xtcProbabilityFeature(): TextModelFeature {
  return numericFeature({
    id: "xtcProbability",
    semantic: "Sets how often XTC drops the marked top choices instead of keeping them.",
    min: 0,
    max: 1,
  });
}

/**
 * Locally typical sampling: keep tokens whose surprise is closest to the
 * distribution's average.
 *
 * Band: above 0, up to 1, matching nucleus sampling — 1 keeps everything and is
 * the disabling value, and an empty set is not a stronger filter.
 */
export function typicalPFeature(): TextModelFeature {
  return numericFeature({
    id: "typicalP",
    semantic: "Keeps the tokens whose information content sits closest to the distribution's average.",
    min: 0,
    max: 1,
    minExclusive: true,
  });
}

/**
 * Tail-free sampling: cut the distribution where its second derivative flattens.
 *
 * Band: 0 through 1, where 1 disables it.
 */
export function tfsFeature(): TextModelFeature {
  return numericFeature({
    id: "tfs",
    semantic: "Cuts the distribution's tail at the point its curvature flattens out.",
    min: 0,
    max: 1,
  });
}

/**
 * Drop tokens below a threshold scaled by the top token's probability squared.
 *
 * Band: 0 through 1, the interval OpenRouter documents, where 0 disables it.
 */
export function topAFeature(): TextModelFeature {
  return numericFeature({
    id: "topA",
    semantic: "Drops tokens below a cutoff that scales with the square of the top token's probability.",
    min: 0,
    max: 1,
  });
}

/**
 * Quadratic smoothing applied to the logits before sampling.
 *
 * Band: 0 or above, where 0 disables it.
 */
export function smoothingFactorFeature(): TextModelFeature {
  return numericFeature({
    id: "smoothingFactor",
    semantic: "Applies quadratic smoothing to the logits so the sharpest peaks are flattened.",
    min: 0,
  });
}

/**
 * The exponent that shapes quadratic smoothing.
 *
 * Band: 1 or above, where 1 is the plain quadratic curve. Below 1 the curve
 * stops being the transformation the sampler is named for.
 */
export function smoothingCurveFeature(): TextModelFeature {
  return numericFeature({
    id: "smoothingCurve",
    semantic: "Shapes the smoothing curve, so the flattening is gentler or sharper than plain quadratic.",
    min: 1,
  });
}

/**
 * The bottom of the dynamic-temperature band.
 *
 * Band: 0 through 2, the same band as `temperature`, because it IS a
 * temperature — the pair states an interval the runtime moves within per token
 * rather than a second knob. Nothing here enforces min below max: the two are
 * independent features and the composer validates values one at a time, so a
 * crossed pair is a review finding rather than a definition-time refusal.
 */
export function dynatempMinFeature(): TextModelFeature {
  return numericFeature({
    id: "dynatempMin",
    semantic: "Sets the lowest temperature dynamic temperature may fall to.",
    min: 0,
    max: 2,
  });
}

/** The top of the dynamic-temperature band. Band: 0 through 2, as `dynatempMin`. */
export function dynatempMaxFeature(): TextModelFeature {
  return numericFeature({
    id: "dynatempMax",
    semantic: "Sets the highest temperature dynamic temperature may rise to.",
    min: 0,
    max: 2,
  });
}

/**
 * How sharply dynamic temperature moves across its band.
 *
 * Band: above 0. An exponent of 0 collapses the curve to a constant, which
 * silently turns the whole sampler into a fixed temperature.
 */
export function dynatempExponentFeature(): TextModelFeature {
  return numericFeature({
    id: "dynatempExponent",
    semantic: "Shapes how sharply dynamic temperature moves between the ends of its band.",
    min: 0,
    minExclusive: true,
  });
}

/**
 * Which mirostat algorithm runs, if any.
 *
 * Band: whole numbers 0 through 2 — off, mirostat, mirostat 2.0. It is an
 * enumeration wearing a number, so anything outside the three is meaningless
 * rather than merely extreme.
 */
export function mirostatModeFeature(): TextModelFeature {
  return numericFeature({
    id: "mirostatMode",
    semantic: "Selects which mirostat algorithm holds perplexity steady, or none.",
    min: 0,
    max: 2,
    integer: true,
  });
}

/**
 * The perplexity mirostat steers toward.
 *
 * Band: above 0. A target of zero asks for a completion with no surprise in it
 * at all, which is degenerate rather than deterministic.
 */
export function mirostatTauFeature(): TextModelFeature {
  return numericFeature({
    id: "mirostatTau",
    semantic: "Sets the target perplexity mirostat steers the completion toward.",
    min: 0,
    minExclusive: true,
  });
}

/**
 * How fast mirostat corrects toward its target.
 *
 * Band: above 0. A learning rate of zero never corrects, which disables the
 * sampler while leaving it switched on.
 */
export function mirostatEtaFeature(): TextModelFeature {
  return numericFeature({
    id: "mirostatEta",
    semantic: "Sets how quickly mirostat corrects back toward its target perplexity.",
    min: 0,
    minExclusive: true,
  });
}

/** The band a single token's bias may sit in — the interval OpenRouter documents. */
const TOKEN_BIAS_LIMIT = 100;

/**
 * Per-token additive bias, keyed by token id.
 *
 * The one feature whose value is a record, and the reason the profile value
 * type has a fourth shape at all: a ban list is a set of token ids, and
 * flattening it into a list of strings would lose the strength each ban is
 * applied at.
 *
 * Keys are token ids as decimal strings — the wire spelling every host that
 * serves this uses — and biases run from -100 through 100, where the extremes
 * are effectively a ban and a forced choice. Token ids are TOKENISER-specific,
 * so a bias map is exact-model evidence in the strongest sense: the same map
 * moved to another model bans different text, silently.
 */
export function logitBiasFeature(): TextModelFeature {
  return {
    id: "logitBias",
    semantic: "Shifts named token ids up or down before sampling, up to banning them outright.",
    validate: (value: TextProfileValue): readonly string[] => {
      if (!isTokenBiasMap(value)) return ["logitBias takes a record of token id to bias, not a single value."];
      const entries = Object.entries(value);
      if (entries.length === 0) return ["logitBias needs at least one token id — omit it from the profile to bias none."];
      const reasons: string[] = [];
      for (const [token, bias] of entries) {
        if (!/^\d+$/.test(token)) {
          reasons.push(`logitBias key "${token}" is not a token id; keys are the tokeniser's decimal ids.`);
        }
        if (!Number.isFinite(bias) || Math.abs(bias) > TOKEN_BIAS_LIMIT) {
          reasons.push(`logitBias for token "${token}" accepts values from -${TOKEN_BIAS_LIMIT} through ${TOKEN_BIAS_LIMIT}; ${bias} is outside that band.`);
        }
      }
      return reasons;
    },
  };
}

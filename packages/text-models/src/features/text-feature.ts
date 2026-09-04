/**
 * A SEMANTIC decoding capability a model's call profile composes rather than
 * respells.
 *
 * A feature is the answer to "what does Vesper want to ask for here?" — a
 * temperature, a nucleus cutoff, a repetition penalty, a thinking toggle —
 * stated once and reused by every model that asks for it. It is deliberately
 * NOT the answer to "which wire field carries it": that is a host dialect's
 * job, and it stays the dialect's job because the same semantic knob is spelled
 * differently on every upstream (`topK` here, `top_k` on an OpenAI-compatible
 * body, `top_k` again but as an SDK call setting on another host). A feature
 * that carried a wire name would have to be duplicated the first time a second
 * host served it.
 *
 * So ids are spelled in Vesper's NORMALIZED vocabulary — `topK`, never
 * `top_k`; `repetitionPenaltyRange`, never `rep_pen_range` — and the dialect
 * tables under `../hosts` own every wire spelling in the package.
 *
 * What a feature DOES own is the value band: the range outside which a number
 * means nothing to any sampler, whatever host is asked. `validate` is that
 * band, expressed as plain-English reasons, and an empty result is the normal
 * answer — a refusal is the exception.
 *
 * The vocabulary is grown as needed, never enumerated in advance. There is no
 * master enum of every sampler a language model could conceivably expose:
 * a member nobody's profile sets is an unproven claim, and the profile is what
 * a call actually travels through.
 */
export interface TextModelFeature {
  /**
   * Stable identifier in the normalized vocabulary. It becomes an entry in the
   * composed adapter's `capabilities` and a key in its `profile`, so renaming
   * one is a public API change, not a tidy-up.
   */
  readonly id: string;
  /** One sentence: what this knob MEANS, in Vesper's terms. */
  readonly semantic: string;
  /**
   * Reasons this value cannot be what the author meant, in plain English, one
   * string each. Empty is the normal answer.
   *
   * It judges the VALUE and nothing else — never the host, never the request.
   * Whether a host serves the feature at all is the dialect's answer, and
   * conflating the two would make a profile illegal on one host and legal on
   * the next, which is exactly the coupling the withheld list exists to avoid.
   */
  readonly validate: (value: TextProfileValue) => readonly string[];
}

/**
 * Every kind of value a call profile may carry.
 *
 * Deliberately small and deliberately not `unknown`: a profile is authored
 * TypeScript that a reviewer reads, and four shapes cover every sampler in the
 * vocabulary — a number, a toggle, a list of strings (stop sequences, DRY
 * sequence breakers), and a token-id-keyed bias map. A fifth shape is a
 * vocabulary change, which is the reviewable event it should be.
 */
export type TextProfileValue = number | boolean | readonly string[] | Readonly<Record<string, number>>;

/** True when the value is the string-list shape, narrowed without an assertion. */
export function isStringList(value: TextProfileValue): value is readonly string[] {
  return Array.isArray(value);
}

/** True when the value is the token-id-keyed bias-map shape. */
export function isTokenBiasMap(value: TextProfileValue): value is Readonly<Record<string, number>> {
  return typeof value === "object" && value !== null && !isStringList(value);
}

/** How a rejected value is named back to the author, without dumping a whole record into a message. */
function describeValue(value: TextProfileValue): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isStringList(value)) return "a list of strings";
  return "a token-bias record";
}

/** The band a numeric feature accepts, in the words a refusal uses. */
function bandText(spec: NumericFeatureSpec): string {
  const { min, max, minExclusive = false } = spec;
  if (min !== undefined && max !== undefined) {
    return minExclusive ? `values above ${min} and up to ${max}` : `values from ${min} through ${max}`;
  }
  if (min !== undefined) return minExclusive ? `values above ${min}` : `values of ${min} or above`;
  if (max !== undefined) return `values of ${max} or below`;
  return "any finite value";
}

/** What a numeric feature declares about itself. */
export interface NumericFeatureSpec {
  readonly id: string;
  readonly semantic: string;
  /** Inclusive unless `minExclusive` says otherwise. Absent means unbounded below. */
  readonly min?: number;
  /** Inclusive. Absent means unbounded above. */
  readonly max?: number;
  readonly minExclusive?: boolean;
  /** Whole numbers only — token counts, token ids, sampler modes. */
  readonly integer?: boolean;
}

/**
 * The numeric feature constructor every sampler in the vocabulary is built
 * from.
 *
 * One shared implementation rather than thirty hand-written validators: the
 * band is the only thing that differs between them, so the band is the only
 * thing each feature states. Each feature's own doc comment carries WHY its
 * band is what it is, which is the part a reviewer cannot derive.
 */
export function numericFeature(spec: NumericFeatureSpec): TextModelFeature {
  const { id, semantic, min, max, minExclusive = false, integer = false } = spec;
  return {
    id,
    semantic,
    validate: (value: TextProfileValue): readonly string[] => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return [`${id} takes a finite number; ${describeValue(value)} is not one.`];
      }
      if (integer && !Number.isInteger(value)) {
        return [`${id} takes a whole number; ${value} has a fractional part.`];
      }
      const belowFloor = min !== undefined && (minExclusive ? value <= min : value < min);
      if (belowFloor || (max !== undefined && value > max)) {
        return [`${id} accepts ${bandText(spec)}; ${value} is outside that band.`];
      }
      return [];
    },
  };
}

/** A boolean toggle: on, off, or absent — and absent is not the same as off. */
export function flagFeature(spec: { readonly id: string; readonly semantic: string }): TextModelFeature {
  const { id, semantic } = spec;
  return {
    id,
    semantic,
    validate: (value: TextProfileValue): readonly string[] =>
      typeof value === "boolean" ? [] : [`${id} is a toggle and takes true or false; ${describeValue(value)} is neither.`],
  };
}

/**
 * A list of literal strings.
 *
 * An empty list is refused on purpose. "Send no stop sequences" is already
 * expressible — leave the key out of the profile — so a declared empty list can
 * only be a value the author meant to fill in and did not, and a host that
 * received it would either ignore it or, worse, treat it as a stop on the empty
 * string.
 */
export function stringListFeature(spec: { readonly id: string; readonly semantic: string }): TextModelFeature {
  const { id, semantic } = spec;
  return {
    id,
    semantic,
    validate: (value: TextProfileValue): readonly string[] => {
      if (!isStringList(value)) return [`${id} takes a list of strings; ${describeValue(value)} is not one.`];
      if (value.length === 0) return [`${id} needs at least one entry — omit it from the profile to send none.`];
      if (value.some((entry) => entry.trim().length === 0)) return [`${id} entries are literal text and none of them may be blank.`];
      return [];
    },
  };
}

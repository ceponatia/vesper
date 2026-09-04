import { bodyBinding, type TextHostDialect } from "./host";

/**
 * A local runtime, and a PLACEHOLDER: Vesper has no self-hosted transport, so
 * nothing in this repository ever binds a profile for this host.
 *
 * It exists because the vocabulary's whole point is that an author's profile
 * survives intact, and a sampler no host serves would otherwise have nowhere to
 * be spelled. This table is where the local runtimes' own names are written
 * down, so the day a self-hosted lane is built it starts from the vocabulary
 * the profiles were authored in rather than inventing one.
 *
 * The spellings are KoboldCpp's generate-request names wherever the author
 * profiles this package carries name a field — `rep_pen`, `typical`,
 * `stop_sequence`, `max_length`, `sampler_seed`, `nsigma` — and the
 * OpenAI-compatible spelling for the handful that native API has no name for
 * (`frequency_penalty`, `min_tokens`, `chat_template_kwargs`). They are a
 * record of a profile's vocabulary, not a verified wire contract: the lane that
 * adds a transport checks each one against the endpoint it actually targets.
 *
 * Every feature is bound, and that is what makes this dialect the vocabulary's
 * completeness check: a sampler the hosted tables both withhold still has one
 * place that names it.
 */
export const SELF_HOSTED_DIALECT: TextHostDialect = {
  host: "self-hosted",
  bindings: {
    temperature: bodyBinding("temperature"),
    topP: bodyBinding("top_p"),
    topK: bodyBinding("top_k"),
    minP: bodyBinding("min_p"),
    seed: bodyBinding("sampler_seed"),
    repetitionPenalty: bodyBinding("rep_pen"),
    repetitionPenaltyRange: bodyBinding("rep_pen_range"),
    presencePenalty: bodyBinding("presence_penalty"),
    frequencyPenalty: bodyBinding("frequency_penalty"),
    stop: bodyBinding("stop_sequence"),
    minTokens: bodyBinding("min_tokens"),
    maxTokens: bodyBinding("max_length"),
    thinking: bodyBinding("chat_template_kwargs", (value) => ({ enable_thinking: value === true })),
    topNsigma: bodyBinding("nsigma"),
    dryMultiplier: bodyBinding("dry_multiplier"),
    dryBase: bodyBinding("dry_base"),
    dryAllowedLength: bodyBinding("dry_allowed_length"),
    drySequenceBreakers: bodyBinding("dry_sequence_breakers"),
    xtcThreshold: bodyBinding("xtc_threshold"),
    xtcProbability: bodyBinding("xtc_probability"),
    typicalP: bodyBinding("typical"),
    tfs: bodyBinding("tfs"),
    topA: bodyBinding("top_a"),
    smoothingFactor: bodyBinding("smoothing_factor"),
    smoothingCurve: bodyBinding("smoothing_curve"),
    dynatempMin: bodyBinding("dynatemp_min"),
    dynatempMax: bodyBinding("dynatemp_max"),
    dynatempExponent: bodyBinding("dynatemp_exponent"),
    mirostatMode: bodyBinding("mirostat"),
    mirostatTau: bodyBinding("mirostat_tau"),
    mirostatEta: bodyBinding("mirostat_eta"),
    logitBias: bodyBinding("logit_bias"),
  },
};

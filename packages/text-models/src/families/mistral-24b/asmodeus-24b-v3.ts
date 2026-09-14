import { defineTextModel } from "../../composer";
import {
  dryAllowedLengthFeature,
  dryBaseFeature,
  dryMultiplierFeature,
  dryRangeFeature,
  dynatempMaxFeature,
  dynatempMinFeature,
  maxTokensFeature,
  minPFeature,
  presencePenaltyFeature,
  repetitionPenaltyFeature,
  repetitionPenaltyRangeFeature,
  repetitionPenaltySlopeFeature,
  temperatureFeature,
  topKFeature,
  topNsigmaFeature,
  topPFeature,
  xtcProbabilityFeature,
  xtcThresholdFeature,
} from "../../features";

/** The exact Featherless/Hugging Face id for Asmodeus 24B v3. */
export const ASMODEUS_24B_V3_ID = "DarkArtsForge/Asmodeus-24B-v3";

/**
 * Asmodeus 24B v3 — a Mistral-Small-24B narrator merge, and the first model
 * whose author profile is shipped WHOLE rather than trimmed to its host.
 *
 * Owner ruling (2026-09-04): ship the author's recommended profile and let host
 * selection deactivate the fields the host does not honour. So every value the
 * author published is declared below; Featherless carries the seven it serves
 * and withholds the rest, and the withheld half stays on the record instead of
 * being deleted at authoring time. `docs/text-models/models/asmodeus-24b-v3.md`
 * is the reference page for all of it, including the fields' provenance.
 *
 * ## The two things this model must NOT be sent
 *
 * **`chat_template_kwargs` is rejected outright**, with a 400, even when empty:
 * Featherless refuses the field on this model's Mistral tokenizer. That is why
 * no `thinking` feature is composed here even though the vocabulary has one and
 * the two DavidAU rows depend on it — it is a hard host constraint rather than a
 * preference, and it is the concrete reason this registry keys on an exact model
 * id rather than on a provider.
 *
 * **Nothing undocumented reaches the wire.** Featherless honours exactly its
 * documented parameter set and silently drops every undocumented field — 200,
 * no error, no effect. `top_nsigma` is in that set, so the author's headline
 * pairing of temperature with top-n-sigma cannot ship whole on this host; what
 * ships is the temperature, and the sigma is withheld with the value intact.
 *
 * ## What it is not given
 *
 * No hidden empty retry and no retry floor: nine of nine probe calls returned
 * prose, so there is no empty-reply failure to cover and a retry would be
 * latency spent against a hazard the evidence says does not exist. No startup
 * budget either — the tier is `warm` and no cold start appeared in ~90 calls,
 * and absence measured is recorded as absence rather than guessed at.
 *
 * No `logitBias`. The author bans em dash and ellipsis tokens, and a bias map is
 * keyed by TOKENISER ids that nobody has read off this checkpoint; inventing
 * them would ban different text, silently. The ban is recorded on the reference
 * page as author guidance, which is where an unmeasured setting belongs.
 */
export const asmodeus24bV3 = defineTextModel({
  id: ASMODEUS_24B_V3_ID,
  // Featherless's own `model_class` for this checkpoint, read from its model
  // record rather than inferred from the name.
  family: "mistral-24b",
  // Measured, not quoted: the host's chat-format endpoint renders this model's
  // own repository template as `<s>[SYSTEM_PROMPT]…[/SYSTEM_PROMPT][INST]…[/INST]`,
  // Tekken-shaped with a dedicated system block. Featherless applies it; this
  // adapter sends no template of its own.
  chatTemplate: "mistral-tekken",
  host: "featherless",
  features: [
    // Served on Featherless, in the order they read on the wire.
    temperatureFeature(),
    topPFeature(),
    topKFeature(),
    minPFeature(),
    repetitionPenaltyFeature(),
    presencePenaltyFeature(),
    maxTokensFeature(),
    // Declared and withheld here: the author's local-runtime half of the
    // profile, kept so the record of how this model was meant to be asked
    // survives a host that serves less than its author tuned against.
    topNsigmaFeature(),
    repetitionPenaltyRangeFeature(),
    repetitionPenaltySlopeFeature(),
    dryMultiplierFeature(),
    dryBaseFeature(),
    dryAllowedLengthFeature(),
    dryRangeFeature(),
    xtcProbabilityFeature(),
    xtcThresholdFeature(),
    dynatempMinFeature(),
    dynatempMaxFeature(),
  ],
  profile: {
    temperature: 1.0,
    // One, which is the DISABLING value for nucleus sampling: the author filters
    // with a relative floor (`minP`) instead, and states the neutral top-p
    // explicitly so nothing downstream reads its absence as "unset".
    topP: 1.0,
    topK: 100,
    minP: 0.1,
    repetitionPenalty: 1.08,
    // Neutral, and deliberate: this model is asked with no flat presence
    // pressure at all, where the DavidAU rows are asked with 1.5.
    presencePenalty: 0,
    /**
     * The explicit output cap (owner decision, 2026-09-14).
     *
     * **It buys prompt window, not a stop condition.** The model ends its own
     * turns — every probe call finished on `stop` with prose — so nothing here
     * is holding a runaway completion back. What it changes is the host's
     * ADMISSION check: with no `max_tokens` Featherless reserves 4,096 output
     * tokens inside the same 32,768-token window and refuses anything that does
     * not leave room for them, which is what 400s a 31,594-token prompt that
     * succeeds at `max_tokens: 256`. At 1,024 the usable prompt is ~31.7K
     * instead of ~28.7K, against a longest measured reply of 404 tokens.
     */
    maxTokens: 1024,
    // Withheld on Featherless from here down. Every value is the author's.
    topNsigma: 1.25,
    repetitionPenaltyRange: 360,
    repetitionPenaltySlope: 0.7,
    dryMultiplier: 0.8,
    dryBase: 1.75,
    dryAllowedLength: 2,
    dryRange: 320,
    xtcProbability: 0.1,
    xtcThreshold: 0.08,
    // A band rather than a second temperature knob: where a runtime honours it,
    // it moves within these two per token, and the static `temperature` above is
    // what a host without it uses instead.
    dynatempMin: 0.65,
    dynatempMax: 1.35,
  },
  quirks: [
    {
      id: "featherless-model-record",
      /**
       * Both numbers come from the host's own model record rather than from a
       * call: 32,768 tokens of context and a concurrency cost of 2. No
       * `maxCompletionTokens` — the record does not report one, and the cap this
       * model is asked with is a decision in the profile above, not a ceiling
       * the host imposed.
       */
      executionHints: { contextLength: 32_768, concurrencyCost: 2 },
    },
  ],
});

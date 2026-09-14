import { bodyBinding, settingBinding, type TextHostDialect } from "./host";

/**
 * Featherless, reached over its OpenAI-compatible chat-completions endpoint.
 *
 * The split between settings and body fields is a property of the TRANSPORT,
 * not of the host: the openai-compatible client drops `topK` with an
 * "unsupported setting" warning and has no argument for `min_p`,
 * `repetition_penalty` or `min_tokens` at all, so those four ride the raw body
 * even though Featherless documents every one of them. Reading a value in the
 * body column here means "the host serves it and the SDK does not model it",
 * which is the only thing that column ever means.
 *
 * Everything the host does not document is left out of this table, and a
 * feature the table does not name is withheld rather than sent. That includes
 * every local-runtime sampler — top-n-sigma, DRY, XTC, typical, tail-free,
 * top-a, smoothing, dynamic temperature, mirostat, token bias — and
 * `repetitionPenaltyRange`, which this host accepts with no measurable effect
 * inside a completion short enough to test.
 *
 * `chat_template_kwargs` is absent on purpose and is NOT a sampler: it is a
 * chat-template argument, it is rejected outright on some tokenizers, and a
 * model that needs one states it as a request preparer so that it travels on
 * every call rather than only the ones a lane decided were narration.
 *
 * The table is deliberately trivial to edit: a measurement that proves this
 * host honours one more field adds one row, and nothing else in the package
 * changes.
 */
export const FEATHERLESS_DIALECT: TextHostDialect = {
  host: "featherless",
  bindings: {
    temperature: settingBinding("temperature"),
    topP: settingBinding("topP"),
    presencePenalty: settingBinding("presencePenalty"),
    frequencyPenalty: settingBinding("frequencyPenalty"),
    seed: settingBinding("seed"),
    stop: settingBinding("stopSequences"),
    maxTokens: settingBinding("maxOutputTokens"),
    topK: bodyBinding("top_k"),
    minP: bodyBinding("min_p"),
    repetitionPenalty: bodyBinding("repetition_penalty"),
    minTokens: bodyBinding("min_tokens"),
  },
};

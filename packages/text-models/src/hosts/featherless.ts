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
 * `repetitionPenaltyRange`, whose penalty this host applies over the whole
 * context with no window to narrow it.
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
    // One key, not three. The host normalizes `enable_thinking`, `thinking` and
    // `do_reasoning` to the same switch with `false` winning any conflict, and
    // each was measured sufficient alone; sending all three would be redundancy
    // against a hazard the evidence says does not exist. The feature's own
    // validate has already refused anything but a boolean by the time this runs.
    thinking: bodyBinding("chat_template_kwargs", (value) => ({ enable_thinking: value === true })),
  },
};

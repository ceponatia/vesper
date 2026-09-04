import { bodyBinding, settingBinding, type TextHostDialect } from "./host";

/**
 * OpenRouter, reached through its own SDK provider.
 *
 * The provider models more of the vocabulary than the generic
 * openai-compatible client does — `topK` is a real call setting here rather
 * than a dropped one — so the settings column is longer and the body column
 * carries only the four fields OpenRouter documents that have no SDK argument:
 * `min_p`, `top_a`, `repetition_penalty` and `logit_bias`.
 *
 * Everything else in the vocabulary is withheld here, including the thinking
 * toggle: OpenRouter's reasoning controls are its own request shape rather than
 * a chat-template keyword, so binding this feature to them would claim an
 * equivalence nobody has measured.
 */
export const OPENROUTER_DIALECT: TextHostDialect = {
  host: "openrouter",
  bindings: {
    temperature: settingBinding("temperature"),
    topP: settingBinding("topP"),
    topK: settingBinding("topK"),
    presencePenalty: settingBinding("presencePenalty"),
    frequencyPenalty: settingBinding("frequencyPenalty"),
    seed: settingBinding("seed"),
    stop: settingBinding("stopSequences"),
    maxTokens: settingBinding("maxOutputTokens"),
    minP: bodyBinding("min_p"),
    topA: bodyBinding("top_a"),
    repetitionPenalty: bodyBinding("repetition_penalty"),
    logitBias: bodyBinding("logit_bias"),
  },
};

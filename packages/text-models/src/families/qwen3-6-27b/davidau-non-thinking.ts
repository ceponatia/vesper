import { defineTextModel, type TextModelAdapter } from "../../composer";
import {
  presencePenaltyFeature,
  repetitionPenaltyFeature,
  temperatureFeature,
  topKFeature,
  topPFeature,
} from "../../features";

/**
 * DavidAU's two Qwen3.6-27B merges, asked in the non-thinking configuration
 * their instruct template expects.
 *
 * They exist in Vesper's catalog to be COMPARED against each other — same
 * author, same base family, same quantization, same host economics, differing
 * only by merge recipe. That is the entire reason one definition serves both:
 * a sampler difference between the two would confound the only question the
 * comparison asks. If a later probe rules a different baseline for one of them,
 * split this function rather than editing it.
 */

/**
 * Fable Fusion 711 — the prose-fusion arm of the comparison.
 *
 * The id is exported because the application keys three separate things on it
 * (the catalog row, the chat lane's hidden retry, and the tests that prove no
 * other model inherits either), and a curated row's id is a persisted value, so
 * a second spelling would silently mean "no adapter" rather than fail.
 */
export const FABLE_FUSION_711_ID = "DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP";

/** F451 Ultra Pro Writer — the writer-tuned arm. Named here for the same reason. */
export const F451_ULTRA_PRO_WRITER_ID =
  "DavidAU/Qwen3.6-27B-F451-AND-TRI-Polar-Ultra-Pro-Writer-Uncensored-Heretic";

/**
 * The shared definition. Feature order is the order these fields have always
 * reached Featherless, and it is preserved because a bound profile iterates it.
 *
 * The sampler values are the author's recommended non-thinking/instruct
 * baseline, not a Vesper-tuned guess: these merges ask for 0.7 with a tight
 * nucleus and top-k plus presence pressure, where the repo default for every
 * unadapted narrator stays 0.85 and nothing else. They describe how this model
 * should NARRATE, which is why they are a profile — see the quirk below for the
 * one thing that is not a preference at all.
 */
function davidauQwen36NonThinking(id: string): TextModelAdapter {
  return defineTextModel({
    id,
    family: "qwen3.6-27b",
    // Qwen3's own template, which is where the thinking keyword comes from: the
    // toggle changed this exact model's completion, so the template that reads
    // it is measured rather than quoted off the model card.
    chatTemplate: "qwen3",
    host: "featherless",
    features: [
      temperatureFeature(),
      topPFeature(),
      topKFeature(),
      presencePenaltyFeature(),
      repetitionPenaltyFeature(),
    ],
    profile: {
      temperature: 0.7,
      topP: 0.8,
      topK: 20,
      presencePenalty: 1.5,
      // Neutral, and stated on purpose: the author's baseline names it, and
      // omitting it would read as "unset" to the next person to touch this.
      repetitionPenalty: 1.0,
    },
    quirks: [
      {
        id: "thinking-template-off",
        /**
         * **Thinking off is not a preference, and not a sampler.** Measured per
         * model against the live endpoint on 2026-08-17, identically on both
         * rows: with the template's thinking mode on and a bounded output budget
         * the model spends the whole budget reasoning and returns an EMPTY
         * completion with `finish_reason: "length"` — 298 and 299 completion
         * tokens, zero characters of content — and first prose lands at ~61s,
         * past the chat lane's 50s first-token watchdog. With it off: `stop`,
         * prose, zero reasoning, in seconds.
         *
         * It is a **request preparer rather than a profile value** precisely
         * because of that. A profile says how this model should be sampled when
         * it narrates, and an application is free to decide a given call is not
         * narration and ask at its own settings. This is not that: it is a chat
         * TEMPLATE argument, it changes how the prompt is rendered rather than
         * how tokens are drawn, and a model that must be told not to think must
         * be told on every call it receives. A preparer runs at the model
         * boundary for all of them.
         *
         * Only the template's own keyword works. `reasoning_effort: "none"` and
         * a `/no_think` token in the prompt were both probed on this exact model
         * and both silently ignored, still producing a full chain and no prose.
         *
         * **One key, not three.** The host normalizes `enable_thinking`,
         * `thinking` and `do_reasoning` to the same switch with `false` winning
         * any conflict, and all three were probed independently on this exact
         * model — each alone produced `stop`, prose and zero reasoning. One
         * confirmed-sufficient key is what ships; sending the other two would be
         * redundancy against a hazard the evidence says does not exist.
         *
         * Replaces the key rather than merging into it, which is what keeps it
         * idempotent. Nothing else in this definition writes it.
         */
        prepareRequest: (body) => ({ ...body, chat_template_kwargs: { enable_thinking: false } }),
      },
      {
        id: "measured-intermittent-empty",
        /**
         * Both rows earn the chat lane's ONE hidden retry: an intermittent
         * zero-visible-text completion was measured on each of them, and the
         * floor is asked for only on that retry, only after a genuinely silent
         * stop. A minimum response length applied to every call is how narrator
         * padding gets resurrected.
         */
        executionHints: { hiddenEmptyRetry: true, retryMinTokens: 48 },
      },
    ],
  });
}

/** Fable Fusion 711, asked at the shared non-thinking baseline. */
export const fableFusion711 = davidauQwen36NonThinking(FABLE_FUSION_711_ID);

/** F451 Ultra Pro Writer, asked identically — see the shared definition above. */
export const f451UltraProWriter = davidauQwen36NonThinking(F451_ULTRA_PRO_WRITER_ID);

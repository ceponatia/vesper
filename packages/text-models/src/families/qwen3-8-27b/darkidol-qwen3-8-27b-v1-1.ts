import { defineTextModel } from "../../composer";
import { minPFeature, temperatureFeature } from "../../features";

/** The exact Featherless/Hugging Face id for the DarkIdol Qwen3.8 roleplay merge. */
export const DARKIDOL_QWEN38_ID = "aifeifei798/DarkIdol-Qwen3.8-27B-v1.1";

/**
 * DarkIdol Qwen3.8-27B v1.1 — a cinematic-roleplay tune, and deliberately the
 * OPPOSITE of the DavidAU rows on reasoning.
 *
 * Its short planning pass is a feature rather than a failure: the author
 * recommends medium effort rather than disabling it, so this model keeps its
 * chain where its Qwen3.6 neighbours suppress theirs. Two models on one host,
 * one template family, asked in opposite configurations — which is the case
 * exact-model keying exists for.
 *
 * The profile carries only what Featherless documents and this host therefore
 * honours. The same model card strongly recommends DRY (0.8 / 1.75 / allowed
 * length 2); it is absent rather than declared-and-withheld because nobody has
 * measured this exact model's DRY settings — a value in a profile is a claim
 * that this model was measured, and copying three numbers off a card is the
 * model-card guessing the registry's exact-id keying prevents.
 */
export const darkIdolQwen38V11 = defineTextModel({
  id: DARKIDOL_QWEN38_ID,
  family: "qwen3.8-27b",
  chatTemplate: "qwen3",
  host: "featherless",
  features: [temperatureFeature(), minPFeature()],
  profile: {
    temperature: 1.0,
    // A relative floor rather than a nucleus, which is why the author sets this
    // and leaves top-p alone.
    minP: 0.05,
  },
  quirks: [
    {
      id: "medium-reasoning-effort",
      /**
       * The reasoning effort the author recommends, carried as a chat-template
       * keyword because that is where this checkpoint's Jinja template reads
       * it — it is not the transport's `reasoningEffort` option, and the
       * vocabulary's own `thinking` toggle cannot say "medium".
       *
       * A preparer rather than a feature, and it REPLACES the key rather than
       * merging into it: that is what keeps it idempotent, which the contract
       * requires because a caller may prepare a body twice. Nothing else in this
       * definition composes `thinking`, so there is no second writer of the key
       * for the replacement to lose.
       */
      prepareRequest: (body) => ({ ...body, chat_template_kwargs: { reasoning_effort: "medium" } }),
    },
  ],
});

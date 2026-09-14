import { describe, expect, it } from "vitest";
import { NARRATIVE_MODELS, narrativeModelProvider } from "@/lib/narrative-models";
import {
  DARKIDOL_QWEN38_ID,
  FABLE_FUSION_711_ID,
  narratorHiddenRetryModel,
  narratorRetryFloor,
  prepareTextRequestBody,
  textModelCall,
} from "./model-adapters";

/**
 * DarkIdol Qwen3.8-27B v1.1 — the row that proves exact-model keying is doing
 * work rather than describing a host.
 *
 * It shares its host and its base template family with the two DavidAU Qwen3.6
 * rows and is asked in the OPPOSITE configuration: its author recommends a short
 * planning pass at medium effort where they suppress their chain entirely. Two
 * models, one host, one template family, opposite requests — the case a
 * provider-keyed or family-keyed policy cannot express, and the one this file
 * keeps honest.
 *
 * The defect it kills is inheritance: DarkIdol acquiring a neighbour's thinking
 * suppression, a neighbour's sampler baseline, or a neighbour's hidden retry,
 * any of which would look like a working configuration and quietly ask this
 * model for something nobody measured on it. Its serialized wire body is
 * asserted through both real lanes in `featherless-wire.test.ts`.
 */

/** The narrator lanes' shared temperature — what the adapter has to outrank. */
const LANE_TEMPERATURE = 0.85;

describe("DarkIdol Featherless narrator", () => {
  it("is curated as a Featherless narrator", () => {
    const option = NARRATIVE_MODELS.find((candidate) => candidate.id === DARKIDOL_QWEN38_ID);
    expect(option).toEqual({
      id: DARKIDOL_QWEN38_ID,
      label: "DarkIdol Qwen3.8 27B v1.1 (32K)",
      provider: "featherless",
    });
    expect(narrativeModelProvider(DARKIDOL_QWEN38_ID)).toBe("featherless");
  });

  it("applies the supported author-recommended sampler and medium reasoning settings", () => {
    const call = textModelCall(DARKIDOL_QWEN38_ID, { laneDefaults: { temperature: LANE_TEMPERATURE } });

    // Temperature is an SDK call setting; `min_p` has no SDK argument and rides
    // the raw body. Both outrank the lane's 0.85.
    expect(call.settings).toEqual({ temperature: 1.0 });
    expect(call.providerOptions).toEqual({ featherless: { min_p: 0.05 } });
    // The reasoning effort is a chat-template keyword this checkpoint's Jinja
    // template reads, not the transport's `reasoningEffort` option. It arrives
    // as a request preparer at the model boundary rather than as a profile
    // value, because it changes how the prompt is RENDERED and so has to reach
    // every call this model receives, not only the narration ones.
    expect(prepareTextRequestBody({ model: DARKIDOL_QWEN38_ID, messages: [] })).toEqual({
      model: DARKIDOL_QWEN38_ID,
      messages: [],
      chat_template_kwargs: { reasoning_effort: "medium" },
    });
  });

  // The author also strongly recommends DRY (0.8 / 1.75 / allowed length 2).
  // It is ABSENT rather than declared-and-withheld, and the difference matters:
  // a withheld value is a measured claim this host cannot carry, while copying
  // three numbers off a model card is the guessing exact-id keying prevents.
  it("declares nothing it has not measured, so nothing is withheld either", () => {
    expect(textModelCall(DARKIDOL_QWEN38_ID).withheld).toEqual([]);
  });

  it("inherits none of its Qwen3.6 host-mates' request shaping", () => {
    const darkidol = textModelCall(DARKIDOL_QWEN38_ID, { laneDefaults: { temperature: LANE_TEMPERATURE } });

    // Not their sampler baseline, which is a different author's measurement on a
    // different checkpoint.
    for (const field of ["top_k", "repetition_penalty"]) {
      expect(darkidol.providerOptions?.featherless, field).not.toHaveProperty(field);
    }
    expect(darkidol.settings.topP).toBeUndefined();
    expect(darkidol.settings.presencePenalty).toBeUndefined();
  });

  // Both rows state a chat-template argument, through the same hook, and the two
  // arguments are opposites: suppress the chain, versus keep it at medium. That
  // is the case exact-id keying exists for — one host, one base template family,
  // opposite requests — and an inheritance bug here would read as a working
  // configuration while asking this model for something nobody measured on it.
  it("carries its own template argument and never a host-mate's", () => {
    const darkidol = prepareTextRequestBody({ model: DARKIDOL_QWEN38_ID, messages: [] });
    const davidau = prepareTextRequestBody({ model: FABLE_FUSION_711_ID, messages: [] });

    expect(darkidol.chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
    expect(davidau.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("does not inherit the DavidAU hidden-empty retry policy", () => {
    expect(narratorHiddenRetryModel(DARKIDOL_QWEN38_ID)).toBe(false);
    expect(narratorRetryFloor(DARKIDOL_QWEN38_ID)).toBeUndefined();
  });
});

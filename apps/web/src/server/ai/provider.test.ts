import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_MODEL_ID } from "@/lib/agent-models";
import { DEFAULT_SCENE_COMPOSER_MODEL_ID } from "@/lib/composer-models";
import {
  DEFAULT_CHARACTER_CHAT_MODEL_ID,
  DEFAULT_NARRATIVE_MODEL_ID,
  NARRATIVE_MODELS,
  narrativeModelProvider,
} from "@/lib/narrative-models";
import {
  agentModelId,
  chatNarrativeModelId,
  FABLE_FUSION_711_ID,
  featherlessRequestBody,
  narrativeModelId,
  narrativeProviderOptions,
  narratorHiddenRetryModel,
  narratorRetryFloorOptions,
  providerRouting,
  sceneComposerModelId,
  stateModelId,
  textModel,
} from "./provider";

describe("strict model-id resolvers (codebase-review B3)", () => {
  it("passes a curated id through", () => {
    expect(narrativeModelId("z-ai/glm-5.2")).toBe("z-ai/glm-5.2");
    expect(agentModelId("z-ai/glm-5.2")).toBe("z-ai/glm-5.2");
  });

  it("coerces an uncurated slug to the default — never bills an arbitrary model", () => {
    expect(narrativeModelId("openai/o5-preview")).toBe(DEFAULT_NARRATIVE_MODEL_ID);
    expect(agentModelId("openai/o5-preview")).toBe(DEFAULT_AGENT_MODEL_ID);
  });

  it("empty / null / whitespace fall back to the default", () => {
    expect(narrativeModelId()).toBe(DEFAULT_NARRATIVE_MODEL_ID);
    expect(narrativeModelId(null)).toBe(DEFAULT_NARRATIVE_MODEL_ID);
    expect(narrativeModelId("  ")).toBe(DEFAULT_NARRATIVE_MODEL_ID);
    expect(agentModelId("")).toBe(DEFAULT_AGENT_MODEL_ID);
  });
});

describe("providerRouting", () => {
  it("returns undefined when no routing knob applies", () => {
    expect(providerRouting("~deepseek/deepseek-v4-flash-latest")).toBeUndefined();
  });

  it("sorts by latency when asked", () => {
    expect(providerRouting("~deepseek/deepseek-v4-flash-latest", { sortLatency: true })).toEqual({ sort: "latency" });
  });

  it("drops the per-model bad endpoint (DeepInfra on GLM 5.2)", () => {
    expect(providerRouting("z-ai/glm-5.2")).toEqual({ ignore: ["deepinfra"] });
  });

  it("prefers the cheap fp8 endpoints for the pinned composer, without making it a restriction", () => {
    // Unrouted, OpenRouter picks this snapshot by its own price/latency/uptime blend and
    // lands on endpoints at ~2× the cheapest available — on the model that runs for every
    // scene image. `allow_fallbacks` keeps a total outage of both a routing miss rather
    // than a failed composition.
    expect(providerRouting(DEFAULT_SCENE_COMPOSER_MODEL_ID)).toEqual({
      order: ["gmicloud/fp8", "deepinfra/fp8"],
      allow_fallbacks: true,
    });
  });
});

describe("narrativeProviderOptions", () => {
  // Per-model reasoning knobs are eval-ruled (narrator-prompt-focus.eval-results.md
  // Run 2 — see NARRATOR_REASONING in provider.ts): Aion/GLM effort:low.
  it("sets effort:low for the Aion narrator, even with no routing", () => {
    expect(narrativeProviderOptions("aion-labs/aion-2.0")).toEqual({
      openrouter: { reasoning: { effort: "low" } },
    });
    expect(narrativeProviderOptions("aion-labs/aion-2.0", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency" }, reasoning: { effort: "low" } },
    });
  });

  it("sends NO reasoning knob for Aion 3.0 (reverted 2026-07-09 — un-evaled, hang suspect)", () => {
    // The provisional effort:low was pulled; Aion 3.0 now sends the model default.
    expect(narrativeProviderOptions("aion-labs/aion-3.0")).toBeUndefined();
    expect(narrativeProviderOptions("aion-labs/aion-3.0", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency" } },
    });
  });

  it("combines latency routing, per-model exclusions, and the reasoning knob", () => {
    // GLM 5.2: latency routing + DeepInfra exclusion + effort:low.
    expect(narrativeProviderOptions("z-ai/glm-5.2", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency", ignore: ["deepinfra"] }, reasoning: { effort: "low" } },
    });
  });

  it("carries only provider routing for a model with no reasoning ruling", () => {
    expect(narrativeProviderOptions("~deepseek/deepseek-v4-flash-latest", { sortLatency: true })).toEqual({
      openrouter: { provider: { sort: "latency" } },
    });
  });

  it("returns undefined when nothing applies (no routing, no reasoning ruling)", () => {
    expect(narrativeProviderOptions("~deepseek/deepseek-v4-flash-latest")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The second text provider (Featherless). Narrator ids only — see
// lib/narrative-models.ts §"Which upstream serves a row".
// ---------------------------------------------------------------------------

/** The curated Featherless row, read off the list so a re-labelled row cannot rot this file. */
const FEATHERLESS_MODEL_ID = NARRATIVE_MODELS.find((o) => o.provider === "featherless")?.id ?? "";

describe("multi-provider narrator routing", () => {
  it("the bench has a Featherless row to route", () => {
    expect(FEATHERLESS_MODEL_ID).not.toBe("");
    expect(narrativeModelProvider(FEATHERLESS_MODEL_ID)).toBe("featherless");
  });

  // The whole reason `providerRouting` is provider-aware: `sort`, `ignore` and
  // `order` name OpenRouter's own upstream endpoints. Sending them to Featherless
  // would be asking one vendor to honor another's query string.
  it("sends no OpenRouter routing block to a Featherless model, even when asked for latency sort", () => {
    expect(providerRouting(FEATHERLESS_MODEL_ID)).toBeUndefined();
    expect(providerRouting(FEATHERLESS_MODEL_ID, { sortLatency: true })).toBeUndefined();
  });

  it("sends no provider options at all to a Featherless narrator", () => {
    expect(narrativeProviderOptions(FEATHERLESS_MODEL_ID)).toBeUndefined();
    expect(narrativeProviderOptions(FEATHERLESS_MODEL_ID, { sortLatency: true })).toBeUndefined();
  });

  it("routes each id to the upstream that serves it", () => {
    // The AI SDK reports the provider that built the model; that is the observable
    // difference between the two transports without making a network call.
    expect(textModel(FEATHERLESS_MODEL_ID).provider).toContain("featherless");
    expect(textModel("aion-labs/aion-2.0").provider).toContain("openrouter");
  });

  it("routes an unknown id to OpenRouter — resolvers curate before anything reaches here", () => {
    expect(textModel("vendor/never-listed").provider).toContain("openrouter");
  });
});

describe("provider-key gate on narrator selection", () => {
  const original = process.env.FEATHERLESS_API_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.FEATHERLESS_API_TOKEN;
    else process.env.FEATHERLESS_API_TOKEN = original;
  });

  it("passes the Featherless pick through when the token is configured", () => {
    process.env.FEATHERLESS_API_TOKEN = "fl-test-token";
    expect(chatNarrativeModelId(FEATHERLESS_MODEL_ID)).toBe(FEATHERLESS_MODEL_ID);
    expect(narrativeModelId(FEATHERLESS_MODEL_ID)).toBe(FEATHERLESS_MODEL_ID);
  });

  // A missing token is a stale DEPLOYMENT, not a stale choice: the pick stays
  // stored and valid, and the turn degrades to a narrator that can actually answer
  // instead of spending itself on a guaranteed 401.
  it("degrades to the lane default when the token is missing or blank", () => {
    delete process.env.FEATHERLESS_API_TOKEN;
    expect(chatNarrativeModelId(FEATHERLESS_MODEL_ID)).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
    expect(narrativeModelId(FEATHERLESS_MODEL_ID)).toBe(DEFAULT_NARRATIVE_MODEL_ID);
    process.env.FEATHERLESS_API_TOKEN = "   ";
    expect(chatNarrativeModelId(FEATHERLESS_MODEL_ID)).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
  });

  it("leaves every OpenRouter narrator untouched by the gate", () => {
    delete process.env.FEATHERLESS_API_TOKEN;
    expect(chatNarrativeModelId("z-ai/glm-5.2")).toBe("z-ai/glm-5.2");
    expect(narrativeModelId("aion-labs/aion-2.0")).toBe("aion-labs/aion-2.0");
  });

  it("curates before it gates — an uncurated id still takes the lane default", () => {
    expect(chatNarrativeModelId("openai/o5-preview")).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
    expect(chatNarrativeModelId(null)).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
  });
});

describe("Featherless exact-model request policy", () => {
  // Measured on the live endpoint 2026-08-17, and re-reproduced the same day: with the
  // model's thinking template ON and a bounded output budget it returns an EMPTY reply
  // (`finish_reason: "length"`, 298 completion tokens, zero characters of content, ~1,080
  // characters of reasoning) and first prose at ~61s — past the chat lane's 50s first-token
  // watchdog. With it OFF: `finish_reason "stop"`, prose, zero reasoning, ~2.4s.
  it("disables the chat template's thinking mode for the model that needs it", () => {
    const body = featherlessRequestBody({ model: FABLE_FUSION_711_ID, messages: [] });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  // ONE key, not three. Featherless normalizes `enable_thinking` / `thinking` /
  // `do_reasoning` and each was probed alone on this exact model — all three produced
  // `stop`, prose and zero reasoning — so the confirmed-sufficient key is what ships.
  it("sends exactly one thinking-disable key", () => {
    const body = featherlessRequestBody({ model: FABLE_FUSION_711_ID, messages: [] });
    expect(Object.keys(body.chat_template_kwargs as object)).toEqual(["enable_thinking"]);
  });

  // The author's recommended non-thinking/instruct baseline for this merge. `top_k` and
  // `repetition_penalty` ride the raw body because the AI SDK transport has no equivalent
  // for either (it drops `topK` with an "unsupported" warning).
  it("applies the model's own sampler profile over the call site's defaults", () => {
    expect(featherlessRequestBody({ model: FABLE_FUSION_711_ID, messages: [], temperature: 0.85 })).toEqual({
      model: FABLE_FUSION_711_ID,
      messages: [],
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      presence_penalty: 1.5,
      repetition_penalty: 1,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  // The whole point of keying policy to an exact id: a second Featherless row must arrive
  // with plain defaults, not this model's profile.
  it("leaves every other Featherless model's body byte-identical", () => {
    const body = { model: "SomeOwner/Some-Other-Merge", messages: [], temperature: 0.85 };
    expect(featherlessRequestBody(body)).toEqual(body);
    expect(featherlessRequestBody(body).chat_template_kwargs).toBeUndefined();
  });

  // An OpenRouter slug can never actually reach this hook (`textModel` routes it to the
  // other transport), but the policy must be inert for one regardless — a shared helper
  // that special-cased a slug would be a trap for the next provider added.
  it("leaves the proven OpenRouter narrators' bodies byte-identical", () => {
    for (const modelId of [
      "aion-labs/aion-3.0",
      "z-ai/glm-5.2",
      "~deepseek/deepseek-v4-flash-latest",
      "anthracite-org/magnum-v4-72b",
    ]) {
      const body = { model: modelId, messages: [], temperature: 0.85 };
      expect(featherlessRequestBody(body)).toEqual(body);
    }
  });

  it("passes a body with no model through untouched rather than guessing", () => {
    expect(featherlessRequestBody({ messages: [] })).toEqual({ messages: [] });
  });
});

describe("the hidden empty-reply retry is exact-model", () => {
  it("is on for Fable Fusion 711 and its retry floor is configured", () => {
    expect(narratorHiddenRetryModel(FABLE_FUSION_711_ID)).toBe(true);
    expect(narratorRetryFloorOptions(FABLE_FUSION_711_ID)).toEqual({ featherless: { min_tokens: 48 } });
  });

  it("is off for every other narrator — including another Featherless row", () => {
    for (const modelId of [
      "SomeOwner/Some-Other-Merge",
      "aion-labs/aion-2.0",
      "aion-labs/aion-3.0",
      "aion-labs/aion-3.0-mini",
      "z-ai/glm-5.2",
      "~deepseek/deepseek-v4-flash-latest",
      "google/gemini-3.5-flash",
      "x-ai/grok-4.5",
      "anthracite-org/magnum-v4-72b",
      "sao10k/l3.3-euryale-70b",
      "thedrummer/cydonia-24b-v4.1",
      "nousresearch/hermes-4-70b",
      "minimax/minimax-m2-her",
    ]) {
      expect(narratorHiddenRetryModel(modelId)).toBe(false);
      expect(narratorRetryFloorOptions(modelId)).toBeUndefined();
    }
  });

  it("is off for the agent and composer models — they are not narrators", () => {
    expect(narratorHiddenRetryModel(stateModelId())).toBe(false);
    expect(narratorHiddenRetryModel(sceneComposerModelId())).toBe(false);
  });
});

// The isolation guarantee this whole change rests on: the models that already work must
// be asked byte-identically afterwards. `narrativeProviderOptions` is the entire
// per-call configuration the narrator lanes build, and `featherlessRequestBody` is the
// only body rewrite that exists — so these two assertions together cover the effective
// request configuration for every unaffected model.
describe("proven narrators and non-narrator agents are unchanged", () => {
  it("keeps each proven narrator's provider options exactly as they were", () => {
    expect(narrativeProviderOptions("aion-labs/aion-2.0")).toEqual({ openrouter: { reasoning: { effort: "low" } } });
    expect(narrativeProviderOptions("z-ai/glm-5.2")).toEqual({
      openrouter: { provider: { ignore: ["deepinfra"] }, reasoning: { effort: "low" } },
    });
    // Aion 3.0 deliberately sends NO reasoning knob (reverted 2026-07-09).
    expect(narrativeProviderOptions("aion-labs/aion-3.0")).toBeUndefined();
    expect(narrativeProviderOptions("~deepseek/deepseek-v4-flash-latest")).toBeUndefined();
    expect(narrativeProviderOptions("anthracite-org/magnum-v4-72b")).toBeUndefined();
    expect(narrativeProviderOptions("google/gemini-3.5-flash")).toBeUndefined();
    expect(narrativeProviderOptions("x-ai/grok-4.5")).toBeUndefined();
    expect(narrativeProviderOptions("nousresearch/hermes-4-70b")).toBeUndefined();
  });

  it("keeps the state-agent and scene-composer routing exactly as it was", () => {
    // The state/agent call: `generateChecked` builds its OpenRouter block from
    // `providerRouting` on the resolved agent model.
    expect(providerRouting(stateModelId())).toBeUndefined();
    // The scene composer's own model keeps its cheap-endpoint preference order.
    expect(providerRouting("deepseek/deepseek-v4-flash-0731")).toEqual({
      order: ["gmicloud/fp8", "deepinfra/fp8"],
      allow_fallbacks: true,
    });
    expect(providerRouting(sceneComposerModelId())).toEqual(
      providerRouting(DEFAULT_SCENE_COMPOSER_MODEL_ID),
    );
  });
});

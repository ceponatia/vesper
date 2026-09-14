import { TEXT_MODEL_ADAPTERS, adapterForTextModel } from "@vesper/text-models";
import { afterEach, describe, expect, it } from "vitest";
import { NARRATIVE_MODELS } from "@/lib/narrative-models";
import {
  ASMODEUS_24B_V3_ID,
  DARKIDOL_QWEN38_ID,
  FABLE_FUSION_711_ID,
  F451_ULTRA_PRO_WRITER_ID,
  boundTextModelHost,
  narratorHiddenRetryModel,
  narratorRetryFloor,
  prepareTextRequestBody,
  selectedTextModelHost,
  textModelCall,
  transportTextModelHost,
} from "./model-adapters";
import { narrativeProviderOptions, sceneComposerModelId, stateModelId } from "./provider";

/**
 * The ONE join where an exact-model adapter becomes a real call — the seam that
 * replaced the transport-level `FEATHERLESS_MODEL_POLICY` table.
 *
 * Every defect below is silent at runtime. A call still goes out, a model still
 * answers, and the only symptom is prose that changed for a reason nobody can
 * attribute:
 *
 * - **A lane default outranking exact-model evidence**, so a Featherless
 *   narrator's measured baseline is quietly replaced by whatever temperature the
 *   call site happened to pass.
 * - **A per-call layer losing to the adapter**, so the retry's minimum-token
 *   floor never applies and the silent-stop retry repeats the silent stop.
 *   Or the mirror: an absent key in a later layer ERASING an earlier one, which
 *   an ordinary object spread does and this join must not.
 * - **A bound body field riding a call setting**, where the OpenAI-compatible
 *   transport drops `topK` with a warning — the knob the author tuned hardest,
 *   never applied, with every assertion about the adapter still green.
 * - **The adapter's body clobbering the lane's OpenRouter block**, or the
 *   reverse. Both travel under `providerOptions`, and a plain spread at either
 *   call site silently drops whichever was written first.
 * - **An unadapted model paying for the join.** Most narrators have no adapter;
 *   if the join added so much as an empty provider-options key to them, "this
 *   change is byte-identical for every other model" would be false.
 * - **Host selection creating a transport.** Binding the KoboldCpp dialect for a
 *   model served over an OpenAI-compatible endpoint would send `rep_pen` and
 *   `max_length` to a host that documents neither, and Featherless silently
 *   drops every undocumented field — 200, no error, no effect.
 *
 * The wire bodies these settings actually serialize into are asserted through
 * both real lanes in `featherless-wire.test.ts`; this file owns the join's own
 * arithmetic.
 */

/**
 * The narrator lanes' shared temperature (`engine/constants.ts`
 * NARRATIVE_TEMPERATURE), spelled here so the fixtures read like real calls: it
 * is the value an adapter has to outrank to be worth anything.
 */
const LANE_TEMPERATURE = 0.85;

/**
 * A curated Featherless row with no adapter, read off the catalog crossed with
 * the registry rather than named — the isolation claim is about whichever row
 * is currently unmeasured, not about one particular id.
 */
const UNADAPTED_FEATHERLESS_ID =
  NARRATIVE_MODELS.find((option) => option.provider === "featherless" && adapterForTextModel(option.id) === null)?.id ??
  "";

/** One narrator call as a lane would build it: the lane's temperature and nothing else. */
function laneCall(modelId: string) {
  return textModelCall(modelId, { laneDefaults: { temperature: LANE_TEMPERATURE } });
}

describe("the registry and the narrator catalog agree", () => {
  it("has an unadapted Featherless row to prove isolation against", () => {
    expect(UNADAPTED_FEATHERLESS_ID).not.toBe("");
  });

  // The one failure an exact-id registry cannot detect for itself: an id
  // misspelled in the package resolves to no adapter, which is indistinguishable
  // from a model that was never measured. Crossing the two lists is what catches
  // it, and it has to happen here because the package may not import the app.
  it("registers only curated narrator rows, each under the host that actually serves it", () => {
    const adapters = Object.values(TEXT_MODEL_ADAPTERS);
    expect(adapters.length).toBeGreaterThan(0);
    for (const adapter of adapters) {
      expect(
        NARRATIVE_MODELS.some((option) => option.id === adapter.id),
        `${adapter.id} has an adapter but is not a curated narrator row`,
      ).toBe(true);
      expect(transportTextModelHost(adapter.id)).toBe(adapter.host);
    }
  });
});

describe("textModelCall applies the merge law", () => {
  it("lets the adapter's measured profile outrank the lane's default", () => {
    const call = laneCall(FABLE_FUSION_711_ID);

    // 0.7 is this checkpoint's own recommended non-thinking baseline; 0.85 is
    // what every unadapted narrator is asked with. The adapter wins.
    expect(call.settings).toEqual({ temperature: 0.7, topP: 0.8, presencePenalty: 1.5 });
    // `top_k` and `repetition_penalty` ride the RAW BODY: the OpenAI-compatible
    // transport drops `topK` as an unsupported setting and has no argument for
    // `repetition_penalty` at all.
    expect(call.settings.topK).toBeUndefined();
    expect(call.providerOptions).toEqual({ featherless: { top_k: 20, repetition_penalty: 1 } });
    // The thinking suppression is NOT here, and that is the design: a chat
    // template argument is a request preparer, so it reaches every call this
    // model receives rather than the ones a lane opted in as narration.
    expect(call.providerOptions?.featherless).not.toHaveProperty("chat_template_kwargs");
  });

  it("lets an explicit per-call layer outrank the adapter", () => {
    const call = textModelCall(ASMODEUS_24B_V3_ID, {
      laneDefaults: { temperature: LANE_TEMPERATURE },
      perCall: { temperature: 0.4, maxTokens: 256 },
    });

    expect(call.settings.temperature).toBe(0.4);
    expect(call.settings.maxOutputTokens).toBe(256);
  });

  // The defect an ordinary spread produces: a layer that does not name a key
  // must not blank the layer below it. Neither the adapter nor the per-call
  // layer names an output budget here, so the lane's survives all the way down.
  it("never lets a later layer's silence erase an earlier layer's value", () => {
    const call = textModelCall(FABLE_FUSION_711_ID, {
      laneDefaults: { temperature: LANE_TEMPERATURE, maxTokens: 2_000 },
      perCall: { minTokens: 48 },
    });

    expect(call.settings).toEqual({
      temperature: 0.7,
      topP: 0.8,
      presencePenalty: 1.5,
      maxOutputTokens: 2_000,
    });
  });

  // Asmodeus is the case where the direction is the other way round and is meant
  // to be: its author-published 1,024-token cap deliberately overrides the
  // successor lane's 2,000, because the cap buys prompt window at the host's
  // admission check rather than holding a runaway completion back.
  it("lets the adapter's own output cap override the successor lane's budget", () => {
    const call = textModelCall(ASMODEUS_24B_V3_ID, {
      laneDefaults: { temperature: LANE_TEMPERATURE, maxTokens: 2_000 },
    });

    expect(call.settings).toEqual({ temperature: 1, topP: 1, presencePenalty: 0, maxOutputTokens: 1_024 });
  });

  // Both halves travel under `providerOptions`, so this is the assertion that
  // stops either from being written with a plain spread.
  it("merges the lane's OpenRouter block with the adapter's body instead of replacing either", () => {
    const openrouterOptions = narrativeProviderOptions("z-ai/glm-5.2");
    const call = textModelCall("z-ai/glm-5.2", {
      laneDefaults: { temperature: LANE_TEMPERATURE },
      ...(openrouterOptions === undefined ? {} : { providerOptions: openrouterOptions }),
    });

    // An OpenRouter narrator has no adapter, so its routing and reasoning knobs
    // come back exactly as the lane built them — and under one key, not two.
    expect(call.providerOptions).toEqual({
      openrouter: { provider: { ignore: ["deepinfra"] }, reasoning: { effort: "low" } },
    });
    expect(Object.keys(call.providerOptions ?? {})).toEqual(["openrouter"]);
    expect(call.settings).toEqual({ temperature: LANE_TEMPERATURE });
  });
});

describe("a model with no adapter is asked exactly as its lane asked", () => {
  // Derived from the catalog crossed with the registry: every narrator Vesper
  // has not measured, in one sweep, so a future adapter cannot quietly widen its
  // reach to a row nobody registered.
  it("adds no setting, no body field and no provider-options key to any unadapted narrator", () => {
    const unadapted = NARRATIVE_MODELS.filter((option) => adapterForTextModel(option.id) === null);
    expect(unadapted.length).toBeGreaterThan(0);

    for (const option of unadapted) {
      const call = laneCall(option.id);
      expect(call.settings, option.id).toEqual({ temperature: LANE_TEMPERATURE });
      expect(call.providerOptions, option.id).toBeUndefined();
      expect(call.withheld, option.id).toEqual([]);
    }
  });

  it("treats an id no list names as unadapted rather than as an error", () => {
    const call = laneCall("SomeOwner/Some-Other-Merge");

    expect(call.settings).toEqual({ temperature: LANE_TEMPERATURE });
    expect(call.providerOptions).toBeUndefined();
    expect(call.withheld).toEqual([]);
  });
});

/**
 * Withheld values are the EXPECTED answer for a model whose author tuned it on a
 * local runtime, not a failure. The defect in both directions is expensive: a
 * withheld value that reached the wire is a field Featherless silently drops
 * (200, no error, no effect) or 400s on, and a withheld value that vanished
 * without a record makes the adapter and the request disagree at exactly the
 * moment somebody is comparing two models.
 */
describe("withheld values are diagnostic, not an error", () => {
  it("reports Asmodeus's local-runtime half and still builds the whole call", () => {
    const call = laneCall(ASMODEUS_24B_V3_ID);

    expect(call.withheld.map((entry) => entry.feature)).toEqual([
      "topNsigma",
      "repetitionPenaltyRange",
      "repetitionPenaltySlope",
      "dryMultiplier",
      "dryBase",
      "dryAllowedLength",
      "dryRange",
      "xtcProbability",
      "xtcThreshold",
      "dynatempMin",
      "dynatempMax",
    ]);
    for (const entry of call.withheld) expect(entry.reason).toContain("featherless does not serve");

    // The call proceeds, carrying exactly the seven fields this host serves.
    expect(call.settings).toEqual({ temperature: 1, topP: 1, presencePenalty: 0, maxOutputTokens: 1_024 });
    expect(call.providerOptions).toEqual({ featherless: { top_k: 100, min_p: 0.1, repetition_penalty: 1.08 } });

    // And not one withheld value reached either column under any spelling —
    // top-n-sigma above all, which is the author's headline pairing with
    // temperature and the one Featherless accepts and then ignores.
    const sent = [...Object.values(call.settings), ...Object.values(call.providerOptions?.featherless ?? {})];
    for (const withheldValue of [1.25, 360, 320, 1.75, 0.65, 1.35]) {
      expect(sent, `withheld value ${withheldValue} reached the request`).not.toContain(withheldValue);
    }
  });

  it("reports nothing withheld for a profile its host serves whole", () => {
    expect(laneCall(FABLE_FUSION_711_ID).withheld).toEqual([]);
    expect(laneCall(DARKIDOL_QWEN38_ID).withheld).toEqual([]);
  });
});

/**
 * The hidden empty-reply retry, and the floor it asks for. Both are EXACT-MODEL:
 * each was earned by a measured intermittent empty on that one checkpoint, and a
 * retry that spread by family or by host would spend its latency against a
 * hazard the evidence says those models do not have.
 */
describe("the hidden empty-reply retry is exact-model", () => {
  it("is on for both probed DavidAU rows, with their floor stated as feature values", () => {
    for (const modelId of [FABLE_FUSION_711_ID, F451_ULTRA_PRO_WRITER_ID]) {
      expect(narratorHiddenRetryModel(modelId), modelId).toBe(true);
      // A PROFILE, not a wire body: the lane hands this to the join and the host
      // dialect spells it, so no application file writes `min_tokens`.
      expect(narratorRetryFloor(modelId), modelId).toEqual({ minTokens: 48 });
    }
  });

  it("carries that floor as the host's own field, above the model's own profile", () => {
    const floor = narratorRetryFloor(FABLE_FUSION_711_ID);
    const call = textModelCall(FABLE_FUSION_711_ID, {
      laneDefaults: { temperature: LANE_TEMPERATURE },
      ...(floor === undefined ? {} : { perCall: floor }),
    });

    expect(call.providerOptions).toEqual({
      featherless: { top_k: 20, repetition_penalty: 1, min_tokens: 48 },
    });
  });

  // Derived over the whole catalog: every narrator except the two measured rows,
  // Featherless neighbours included.
  it("is off for every other narrator on the list", () => {
    const measured: readonly string[] = [FABLE_FUSION_711_ID, F451_ULTRA_PRO_WRITER_ID];
    const others = NARRATIVE_MODELS.filter((option) => !measured.includes(option.id));
    expect(others.length).toBeGreaterThan(0);

    for (const option of others) {
      expect(narratorHiddenRetryModel(option.id), option.id).toBe(false);
      expect(narratorRetryFloor(option.id), option.id).toBeUndefined();
    }
  });

  // Named outright as well as swept: the other Featherless rows — two adapted,
  // one deliberately not — are the ones most exposed to inheriting a host-mate's
  // behaviour, and DarkIdol is the nearest neighbour of all (same author's base
  // family, asked in the opposite reasoning configuration).
  it("is off for the other Featherless rows, adapted or not", () => {
    for (const modelId of [ASMODEUS_24B_V3_ID, DARKIDOL_QWEN38_ID, UNADAPTED_FEATHERLESS_ID]) {
      expect(narratorHiddenRetryModel(modelId), modelId).toBe(false);
      expect(narratorRetryFloor(modelId), modelId).toBeUndefined();
    }
  });

  it("is off for the agent and composer models — they are not narrators", () => {
    expect(narratorHiddenRetryModel(stateModelId())).toBe(false);
    expect(narratorHiddenRetryModel(sceneComposerModelId())).toBe(false);
    expect(narratorRetryFloor(stateModelId())).toBeUndefined();
  });
});

/**
 * Host selection (owner ruling 2026-09-04, #473): a field its host does not
 * honour is deactivated by SELECTION, never by deleting the value. The hard rule
 * this suite protects is the other half of that — **selecting a host does not
 * create a transport for it**, so a selection naming any host but the one
 * serving the model changes nothing about the request.
 */
describe("VESPER_TEXT_MODEL_HOST", () => {
  const original = process.env.VESPER_TEXT_MODEL_HOST;

  afterEach(() => {
    if (original === undefined) delete process.env.VESPER_TEXT_MODEL_HOST;
    else process.env.VESPER_TEXT_MODEL_HOST = original;
  });

  /** The Fable call as the ordinary deployment builds it, with nothing selected. */
  function unselectedFableCall() {
    delete process.env.VESPER_TEXT_MODEL_HOST;
    return laneCall(FABLE_FUSION_711_ID);
  }

  it("binds the transport's own host when the deployment names none", () => {
    delete process.env.VESPER_TEXT_MODEL_HOST;

    expect(selectedTextModelHost()).toBeNull();
    expect(boundTextModelHost(FABLE_FUSION_711_ID)).toBe("featherless");
    expect(boundTextModelHost("z-ai/glm-5.2")).toBe("openrouter");
  });

  it("honours a selection that names the host already serving the model", () => {
    const baseline = unselectedFableCall();
    process.env.VESPER_TEXT_MODEL_HOST = "featherless";

    expect(selectedTextModelHost()).toBe("featherless");
    expect(boundTextModelHost(FABLE_FUSION_711_ID)).toBe("featherless");
    // It changes nothing, and saying so is the point.
    expect(laneCall(FABLE_FUSION_711_ID)).toEqual(baseline);
  });

  // The assertion that matters: binding OpenRouter's dialect would move `topK`
  // out of the raw body and into a call setting, which this transport then drops
  // with an "unsupported setting" warning — the knob silently stops applying.
  // Binding the self-hosted placeholder would spell `rep_pen` and `max_length`
  // at an OpenAI-compatible endpoint that documents neither.
  it.each(["openrouter", "self-hosted"])(
    "ignores a selection of %s for a model Featherless serves, leaving the request untouched",
    (selection) => {
      const baseline = unselectedFableCall();
      process.env.VESPER_TEXT_MODEL_HOST = selection;

      expect(boundTextModelHost(FABLE_FUSION_711_ID)).toBe("featherless");
      expect(laneCall(FABLE_FUSION_711_ID)).toEqual(baseline);
    },
  );

  it("ignores a selection of featherless for a model OpenRouter serves", () => {
    delete process.env.VESPER_TEXT_MODEL_HOST;
    const baseline = laneCall("z-ai/glm-5.2");
    process.env.VESPER_TEXT_MODEL_HOST = "featherless";

    expect(boundTextModelHost("z-ai/glm-5.2")).toBe("openrouter");
    expect(laneCall("z-ai/glm-5.2")).toEqual(baseline);
  });

  // A typo in a deployment variable must not take narration down, and must not
  // silently mean something either.
  it.each(["kobold", "Featherless", "   "])("degrades an unusable selection (%s) to no selection at all", (selection) => {
    const baseline = unselectedFableCall();
    process.env.VESPER_TEXT_MODEL_HOST = selection;

    expect(selectedTextModelHost()).toBeNull();
    expect(boundTextModelHost(FABLE_FUSION_711_ID)).toBe("featherless");
    expect(laneCall(FABLE_FUSION_711_ID)).toEqual(baseline);
  });
});

/**
 * The transport's `transformRequestBody` hook: the model-specific rewrite that
 * runs on the fully assembled body, after the SDK has spelled the call settings
 * and spread the provider options.
 *
 * Two defects: a preparer that appends on each pass sends a body no reviewer
 * ever read (a caller may prepare while planning a call and again on the way
 * out), and a hook that rewrote a body it was not written for would make one
 * client's shared transport change every model on the host.
 */
describe("prepareTextRequestBody", () => {
  // This hook is where EVERY chat-template argument now lives, for both models
  // that need one. That is the placement the fix turned on: it runs at the model
  // boundary on every request, so a call that opted out of the sampler profile
  // still cannot send a DavidAU row into its thinking mode.
  const templateArguments: [string, Record<string, unknown>][] = [
    [DARKIDOL_QWEN38_ID, { reasoning_effort: "medium" }],
    [FABLE_FUSION_711_ID, { enable_thinking: false }],
    [F451_ULTRA_PRO_WRITER_ID, { enable_thinking: false }],
  ];

  it.each(templateArguments)("applies %s's own template argument and no other model's", (modelId, kwargs) => {
    expect(prepareTextRequestBody({ model: modelId, messages: [], temperature: 1 })).toEqual({
      model: modelId,
      messages: [],
      temperature: 1,
      chat_template_kwargs: kwargs,
    });
  });

  it.each([DARKIDOL_QWEN38_ID, FABLE_FUSION_711_ID])(
    "is idempotent for %s — preparing a prepared body changes nothing",
    (modelId) => {
      const once = prepareTextRequestBody({ model: modelId, messages: [] });

      expect(prepareTextRequestBody(once)).toEqual(once);
    },
  );

  it.each([
    // Asmodeus 400s on `chat_template_kwargs`; nothing may add one.
    ASMODEUS_24B_V3_ID,
    "z-ai/glm-5.2",
    "aion-labs/aion-2.0",
    "SomeOwner/Some-Other-Merge",
  ])("hands %s's body back by identity, not merely by value", (modelId) => {
    const body: Record<string, unknown> = { model: modelId, messages: [], temperature: 0.85 };

    expect(prepareTextRequestBody(body)).toBe(body);
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it("passes a body with no model through rather than guessing which model it is for", () => {
    const body: Record<string, unknown> = { messages: [] };

    expect(prepareTextRequestBody(body)).toBe(body);
  });
});

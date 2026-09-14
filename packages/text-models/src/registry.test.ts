import { describe, expect, it } from "vitest";
import type { TextModelAdapter } from "./composer";
import { ASMODEUS_24B_V3_ID } from "./families/mistral-24b/asmodeus-24b-v3";
import { FABLE_FUSION_711_ID, F451_ULTRA_PRO_WRITER_ID } from "./families/qwen3-6-27b/davidau-non-thinking";
import { DARKIDOL_QWEN38_ID } from "./families/qwen3-8-27b/darkidol-qwen3-8-27b-v1-1";
import { TEXT_MODEL_ADAPTERS, adapterForTextModel } from "./registry";

/**
 * The registry: which models are claimed to have been measured, and what the
 * claim says.
 *
 * Merely importing this module composes every registered definition, so a
 * profile value outside its feature's band, a profile key naming no composed
 * feature, or two quirks fighting over one hook fails this suite at import —
 * that is `defineTextModel`'s refusal doing its job on the real registry rather
 * than on a fixture, and it is why no test here re-states those rules.
 *
 * What the tests below kill is narrower and cannot be caught by composition:
 *
 * - **An adapter filed under a key that is not its own id.** The lookup is
 *   exact and unnormalized, so a mistyped key reads as "this model has no
 *   adapter" — a model asked at lane defaults, silently, with every assertion
 *   about the adapter still passing.
 * - **The two DavidAU rows drifting apart.** They exist in the catalog to be
 *   compared; a sampler difference between them would confound the only
 *   question the comparison asks.
 * - **A chat-template argument turning back into a profile value.** A profile
 *   says how a model should be SAMPLED when it narrates, and an application is
 *   free to decide a call is not narration and ask at its own settings. A
 *   template argument is not that: it changes how the prompt is rendered, and a
 *   model that must be told not to think must be told on every call it gets. A
 *   preparer runs for all of them; a profile value does not.
 * - **Asmodeus's approved value set changing.** The owner ruled that exact set
 *   (2026-09-04), so the literal IS the contract here and is pinned as one —
 *   including the two values that are a hard host constraint rather than a
 *   preference: the explicit output cap, and the absence of any way for this
 *   model to be sent `chat_template_kwargs`.
 * - **A miss becoming something other than null.** Null is the ordinary answer
 *   for every unmeasured model; a lookup that threw, logged, or fell back to a
 *   sibling by name would make every unadapted narrator either fail or answer
 *   with somebody else's measurements.
 */

/** The adapter for a registered id, refusing rather than returning null so a miss names itself. */
function registered(id: string): TextModelAdapter {
  const adapter = adapterForTextModel(id);
  if (adapter === null) throw new Error(`${id} is expected to be registered and is not.`);
  return adapter;
}

describe("TEXT_MODEL_ADAPTERS", () => {
  // Derived from the registry rather than a copied member list: an adapter
  // added tomorrow is held to this the day it lands, which is the only moment
  // the key and the id can be made to disagree.
  it("files every adapter under its own exact id, and resolves each one back", () => {
    expect(Object.keys(TEXT_MODEL_ADAPTERS).length).toBeGreaterThan(0);
    for (const [key, adapter] of Object.entries(TEXT_MODEL_ADAPTERS)) {
      expect(adapter.id).toBe(key);
      expect(adapterForTextModel(key)).toBe(adapter);
    }
  });

  // One shared definition serves both rows; this is what says so from the
  // outside. Probed independently and identically — both fail the same way with
  // the thinking flag left on.
  it("asks the two DavidAU Qwen3.6 rows identically, differing by id alone", () => {
    const fable = registered(FABLE_FUSION_711_ID);
    const writer = registered(F451_ULTRA_PRO_WRITER_ID);

    // The preparers are compared by what they DO rather than by reference: one
    // shared definition still builds a fresh closure per row, so two functions
    // that behave identically are two different objects.
    const { prepareRequest: writerPrepare, ...writerRest } = writer;
    const { prepareRequest: fablePrepare, ...fableRest } = fable;

    expect(writer.id).not.toBe(fable.id);
    expect({ ...writerRest, id: fable.id }).toEqual(fableRest);
    const body = { model: writer.id, messages: [] };
    expect(writerPrepare?.(body)).toEqual(fablePrepare?.(body));
    expect(fable.executionHints).toEqual({ hiddenEmptyRetry: true, retryMinTokens: 48 });
  });

  /**
   * Thinking off is not a preference and not a sampler — it is the difference
   * between a narrator that answers and one that returns nothing. Measured on
   * both rows 2026-08-17: with the template's thinking mode on and a bounded
   * output budget, 298 and 299 completion tokens of chain and zero characters of
   * content.
   *
   * It is a PREPARER, and that placement is the claim. A profile value reaches
   * only the calls a lane opted into as narration; this has to reach every call
   * the model receives, which is exactly the hole a profile-borne version left
   * in the successor deliberator.
   */
  it("suppresses thinking on both DavidAU rows through a preparer, with exactly one key", () => {
    for (const id of [FABLE_FUSION_711_ID, F451_ULTRA_PRO_WRITER_ID]) {
      const adapter = registered(id);
      expect(adapter.prepareRequest, id).toBeTypeOf("function");

      const prepared = adapter.prepareRequest?.({ model: id, messages: [] });
      // `toEqual` is exact all the way down, so this pins the rest of the body
      // through untouched AND pins `chat_template_kwargs` to ONE key. One is
      // what was measured: the host normalizes `enable_thinking` / `thinking` /
      // `do_reasoning` to the same switch and each was probed alone on this
      // exact model, so sending the other two would be redundancy against a
      // hazard the evidence says does not exist.
      expect(prepared, id).toEqual({ model: id, messages: [], chat_template_kwargs: { enable_thinking: false } });
      // The contract every preparer owes: a caller may prepare while planning a
      // call and again on the way out, and the body must not grow each pass.
      expect(adapter.prepareRequest?.(prepared ?? { model: id }), id).toEqual(prepared);
    }
  });

  // Not a feature, on any host: the sampler vocabulary describes how tokens are
  // drawn, and nothing in a profile can put this key on a wire any more.
  it("states the thinking suppression nowhere in the profile", () => {
    for (const id of [FABLE_FUSION_711_ID, F451_ULTRA_PRO_WRITER_ID]) {
      expect(registered(id).capabilities, id).toEqual([
        "temperature",
        "topP",
        "topK",
        "presencePenalty",
        "repetitionPenalty",
      ]);
      expect(registered(id).profile.thinking, id).toBeUndefined();
    }
  });

  // The owner-ruled value set, pinned as a literal because the set IS the
  // contract: every number here was published by the author and approved whole
  // (ruling 2026-09-04), and the host decides which half travels.
  it("carries Asmodeus's whole approved author profile, hosted half and withheld half alike", () => {
    expect(registered(ASMODEUS_24B_V3_ID).profile).toEqual({
      temperature: 1.0,
      topP: 1.0,
      topK: 100,
      minP: 0.1,
      repetitionPenalty: 1.08,
      presencePenalty: 0,
      maxTokens: 1024,
      topNsigma: 1.25,
      repetitionPenaltyRange: 360,
      repetitionPenaltySlope: 0.7,
      dryMultiplier: 0.8,
      dryBase: 1.75,
      dryAllowedLength: 2,
      dryRange: 320,
      xtcProbability: 0.1,
      xtcThreshold: 0.08,
      dynatempMin: 0.65,
      dynatempMax: 1.35,
    });
  });

  // `chat_template_kwargs` 400s on this model's Mistral tokenizer, empty object
  // included. A request preparer is now the ONLY thing in the package that can
  // put that key on a wire — no feature binds it on any host — so this adapter
  // having none is the whole guarantee, and it is worth stating outright next to
  // two host-mates that both have one.
  it("gives Asmodeus no route to chat_template_kwargs at all", () => {
    const asmodeus = registered(ASMODEUS_24B_V3_ID);

    expect(asmodeus.prepareRequest).toBeUndefined();
    expect(asmodeus.profile.thinking).toBeUndefined();
  });

  // Absence measured is recorded as absence: nine of nine probe calls returned
  // prose on a warm tier, so an empty-reply retry or a startup budget here would
  // be latency spent against a hazard the evidence says does not exist.
  it("records only the host facts Asmodeus earned — context and concurrency, no retry, no startup budget", () => {
    expect(registered(ASMODEUS_24B_V3_ID).executionHints).toEqual({ contextLength: 32_768, concurrencyCost: 2 });
  });

  // DarkIdol is the opposite of the DavidAU rows on reasoning — it keeps its
  // short planning pass — and both say so through the same hook, which is the
  // point: one mechanism for template arguments, whatever they ask for.
  it("keeps DarkIdol's reasoning pass on, through the same preparer hook and not a profile value", () => {
    const darkidol = registered(DARKIDOL_QWEN38_ID);

    expect(darkidol.capabilities).toEqual(["temperature", "minP"]);
    expect(darkidol.prepareRequest?.({ model: DARKIDOL_QWEN38_ID })).toEqual({
      model: DARKIDOL_QWEN38_ID,
      chat_template_kwargs: { reasoning_effort: "medium" },
    });
    expect(darkidol.executionHints).toBeUndefined();
  });

  // Neither model gets the other's, and neither key is ever both: the two rows
  // share a host and a base template family and are asked in opposite reasoning
  // configurations, which is the case exact-id keying exists for.
  it("gives each adapted row its own template argument and no neighbour's", () => {
    const davidau = registered(FABLE_FUSION_711_ID).prepareRequest?.({ model: FABLE_FUSION_711_ID });
    const darkidol = registered(DARKIDOL_QWEN38_ID).prepareRequest?.({ model: DARKIDOL_QWEN38_ID });

    expect(davidau?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(darkidol?.chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
  });
});

describe("adapterForTextModel", () => {
  it.each([
    // The curated Featherless row whose probe found nothing model-specific to
    // say. Unadapted is the correct answer for it, not a gap.
    "Naphula/Slimaki-Tavern-24B-v1.3",
    // An OpenRouter narrator, and a model selection that has not been made yet.
    "z-ai/glm-5.2",
    "",
  ])("answers null for %s, which is the ordinary no-special-behavior case", (id) => {
    expect(adapterForTextModel(id)).toBeNull();
  });

  // Exact, with no normalization of any kind (owner ruling 2026-08-17). A
  // lookup that lowercased, trimmed a suffix, or fell back to a shared prefix
  // would hand a model somebody else's measurements and report nothing.
  it.each([
    FABLE_FUSION_711_ID.toLowerCase(),
    FABLE_FUSION_711_ID.split("/")[0] ?? "",
    `${FABLE_FUSION_711_ID}-Q6`,
    ` ${FABLE_FUSION_711_ID}`,
  ])("does not resolve %s to a neighbour's profile", (id) => {
    expect(adapterForTextModel(id)).toBeNull();
  });
});

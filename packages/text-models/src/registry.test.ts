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

    expect(writer.id).not.toBe(fable.id);
    expect({ ...writer, id: fable.id }).toEqual(fable);
    // Stated outright as well as structurally: the thinking suppression is the
    // difference between a narrator that answers and one that returns nothing.
    expect(fable.profile.thinking).toBe(false);
    expect(writer.profile.thinking).toBe(false);
    expect(fable.executionHints).toEqual({ hiddenEmptyRetry: true, retryMinTokens: 48 });
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
  // included, and the only two things that could put that key on its wire are a
  // composed `thinking` feature and a request preparer. Neither exists, and this
  // is the assertion that keeps it that way.
  it("gives Asmodeus no route to chat_template_kwargs at all", () => {
    const asmodeus = registered(ASMODEUS_24B_V3_ID);

    expect(asmodeus.capabilities).not.toContain("thinking");
    expect(asmodeus.profile.thinking).toBeUndefined();
    expect(asmodeus.prepareRequest).toBeUndefined();
  });

  // Absence measured is recorded as absence: nine of nine probe calls returned
  // prose on a warm tier, so an empty-reply retry or a startup budget here would
  // be latency spent against a hazard the evidence says does not exist.
  it("records only the host facts Asmodeus earned — context and concurrency, no retry, no startup budget", () => {
    expect(registered(ASMODEUS_24B_V3_ID).executionHints).toEqual({ contextLength: 32_768, concurrencyCost: 2 });
  });

  // DarkIdol is the opposite of the DavidAU rows on reasoning, and it says so
  // through a preparer rather than the thinking toggle — the vocabulary's
  // boolean cannot spell "medium".
  it("keeps DarkIdol's reasoning pass on, as a request preparer rather than a profile value", () => {
    const darkidol = registered(DARKIDOL_QWEN38_ID);

    expect(darkidol.capabilities).toEqual(["temperature", "minP"]);
    expect(darkidol.prepareRequest).toBeTypeOf("function");
    expect(darkidol.executionHints).toBeUndefined();
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

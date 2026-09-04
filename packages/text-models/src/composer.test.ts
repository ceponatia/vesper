import { describe, expect, it } from "vitest";
import {
  defineTextModel,
  mergeTextCallSettings,
  type TextModelDefinition,
  type TextModelQuirk,
} from "./composer";
import { temperatureFeature, topKFeature, topNsigmaFeature } from "./features";

/**
 * The definition-time contract.
 *
 * Four defects are worth permanent tests here, and every one of them is silent
 * at the moment it is written and expensive at the moment it matters:
 *
 * - **A profile trimmed to what the host serves.** The owner's ruling is that
 *   an adapter carries its author's WHOLE profile and the host decides what
 *   travels. A composer that dropped the unhosted half at definition time would
 *   look identical in every hosted assertion and would have destroyed the
 *   record the ruling exists to keep.
 * - **A value outside its band accepted.** A temperature of 3 or a top-p of 0
 *   is not a bold setting, it is a typo that reaches the wire and changes every
 *   reply, with nothing anywhere saying so.
 * - **A profile key that names no composed feature accepted.** It reads as a
 *   setting that is being sent and is in fact inert — the worst kind of
 *   configuration, because the author will tune against it.
 * - **A quirk's hook quietly overwritten by another quirk's.** A last-wins
 *   merge produces an adapter that looks composed and behaves as if one of its
 *   quirks was never written.
 *
 * Nothing here re-tests the adapter's TypeScript shape — `tsc` owns that, in
 * this package's own project.
 */

function definition(overrides: Partial<TextModelDefinition> = {}): TextModelDefinition {
  return {
    id: "author/fixture-24b-v1",
    family: "fixture-24b",
    host: "featherless",
    chatTemplate: "mistral-tekken",
    features: [temperatureFeature(), topKFeature(), topNsigmaFeature()],
    profile: { temperature: 1, topK: 100, topNsigma: 1.25 },
    ...overrides,
  };
}

describe("defineTextModel", () => {
  it("keeps every declared value, including one no host in the profile's own dialect serves", () => {
    const adapter = defineTextModel(definition());

    expect(adapter.capabilities).toEqual(["temperature", "topK", "topNsigma"]);
    // `topNsigma` is served by no upstream Vesper reaches. It stays on the
    // adapter regardless: withholding is the binder's job, not the composer's.
    expect(adapter.profile).toEqual({ temperature: 1, topK: 100, topNsigma: 1.25 });
    expect(adapter.id).toBe("author/fixture-24b-v1");
    expect(adapter.chatTemplate).toBe("mistral-tekken");
    // A definition that claims no quirk gets no inert hooks: a caller reading a
    // hook it did not compose must see absence, not a function that never acts.
    expect(adapter.prepareRequest).toBeUndefined();
    expect(adapter.validateRequest).toBeUndefined();
    expect(adapter.executionHints).toBeUndefined();
  });

  it("refuses a profile value outside its feature's band, naming the feature and the band", () => {
    const define = (): unknown => defineTextModel(definition({ profile: { temperature: 3 } }));

    expect(define).toThrow(/temperature/);
    expect(define).toThrow(/values from 0 through 2/);
  });

  it("refuses a profile key that names no composed feature", () => {
    expect(() => defineTextModel(definition({ profile: { minP: 0.1 } }))).toThrow(/minP/);
  });

  it("refuses the same feature composed twice", () => {
    // `capabilities` is read as a set of claims; a repeated entry claims one
    // knob twice, which means nothing and hides a copy-paste.
    expect(() =>
      defineTextModel(definition({ features: [temperatureFeature(), temperatureFeature()], profile: {} })),
    ).toThrow(/temperature/);
  });

  it("takes each exclusive hook from the one quirk that claims it, and accumulates every quirk's refusals", () => {
    const budget: TextModelQuirk = { id: "context-budget", validateRequest: () => ["the history does not fit"] };
    const floor: TextModelQuirk = {
      id: "empty-reply",
      validateRequest: () => ["this model needs a completion floor"],
      executionHints: { hiddenEmptyRetry: true, retryMinTokens: 48 },
    };

    const adapter = defineTextModel(definition({ quirks: [budget, floor] }));

    // Both refusals survive, in declaration order: a caller must see every
    // reason a call cannot proceed, not the first one somebody happened to list.
    expect(adapter.validateRequest?.({ estimatedInputTokens: 40_000 })).toEqual([
      "the history does not fit",
      "this model needs a completion floor",
    ]);
    expect(adapter.executionHints).toEqual({ hiddenEmptyRetry: true, retryMinTokens: 48 });
  });

  it("refuses two quirks claiming the same overriding hook, naming both", () => {
    const define = (): unknown =>
      defineTextModel(
        definition({
          quirks: [
            { id: "house-shape", prepareRequest: (body) => body },
            { id: "model-shape", prepareRequest: (body) => ({ ...body, extra: true }) },
          ],
        }),
      );

    expect(define).toThrow(/house-shape/);
    expect(define).toThrow(/model-shape/);
    expect(define).toThrow(/prepareRequest/);
  });
});

/**
 * The merge law: lane default, then the adapter's profile, then the explicit
 * per-call option.
 *
 * The defect is an inverted or partial order — a lane default that outranks
 * exact-model evidence, or a retry's minimum-token floor that the adapter's
 * profile silently wins over. Both produce a call that runs, answers, and is
 * asked with settings nobody chose.
 */
describe("mergeTextCallSettings", () => {
  it("lets each layer outrank the one before it, and never lets an absent value erase a present one", () => {
    const merged = mergeTextCallSettings(
      { temperature: 0.85, maxOutputTokens: 1_024 },
      { temperature: 1, topK: 100 },
      { maxOutputTokens: 300, temperature: undefined },
    );

    // The adapter's profile beats the lane default; the per-call option beats
    // both; `undefined` spelled out in a later layer is absence, not an erasure.
    expect(merged).toEqual({ temperature: 1, topK: 100, maxOutputTokens: 300 });
  });
});

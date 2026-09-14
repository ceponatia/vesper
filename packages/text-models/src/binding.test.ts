import { describe, expect, it } from "vitest";
import {
  bindTextModelProfile,
  bindTextProfileValues,
  defineTextModel,
  type TextModelAdapter,
} from "./composer";
// The whole vocabulary as one object, so the completeness check below reads the
// package's exports instead of a list this file would have to maintain.
import * as features from "./features";
import { bindingFor, hostsServing } from "./hosts";

/**
 * Binding a declared profile for the host that will actually carry it.
 *
 * The defects worth permanent tests all live in the gap between "declared" and
 * "sent", and none of them raises anything at runtime:
 *
 * - **A value the host does not serve reaching the request.** It is either
 *   ignored (a setting that was tuned and never applied) or rejected (a call
 *   that fails for a reason nobody can read from the adapter).
 * - **A value the host does not serve vanishing without a record.** Silently
 *   dropping it makes the adapter and the wire disagree, and the disagreement
 *   is invisible at exactly the moment someone is comparing two models.
 * - **`topK` sent as a call setting on an OpenAI-compatible transport.** That
 *   transport drops it with a warning, so the knob the author tuned hardest
 *   never applies while every assertion about the adapter still passes. The
 *   host that DOES model it takes it as a setting, which is why the split is
 *   per-dialect rather than a package-wide rule.
 * - **A value one host serves and another does not being treated as a property
 *   of the PROFILE.** `minTokens` is a Featherless body field and nothing at
 *   all on OpenRouter; the same declared profile has to carry it on one and
 *   report it on the other, or moving a model between hosts stops being one
 *   argument.
 *
 * Chat-template arguments are deliberately absent from all of this. They are
 * not features and never bind: a model that needs one states it as a quirk's
 * request preparer, so it reaches every call rather than the ones a lane calls
 * narration (`registry.test.ts` owns that claim).
 */

const adapter: TextModelAdapter = defineTextModel({
  id: "author/fixture-24b-v1",
  family: "fixture-24b",
  host: "featherless",
  chatTemplate: "mistral-tekken",
  features: [
    features.temperatureFeature(),
    features.topKFeature(),
    features.minPFeature(),
    features.minTokensFeature(),
    features.topNsigmaFeature(),
  ],
  profile: { temperature: 1, topK: 100, minP: 0.1, minTokens: 48, topNsigma: 1.25 },
});

describe("bindTextModelProfile", () => {
  it("splits the featherless profile into SDK settings and raw body fields", () => {
    const bound = bindTextModelProfile(adapter);

    expect(bound.settings).toEqual({ temperature: 1 });
    expect(bound.body).toEqual({ top_k: 100, min_p: 0.1, min_tokens: 48 });
  });

  it("withholds a value the host does not serve, with a reason, and sends it nowhere", () => {
    const bound = bindTextModelProfile(adapter);

    expect(bound.withheld).toEqual([
      { feature: "topNsigma", reason: "featherless does not serve topNsigma, so the profile's value for it is not sent." },
    ]);
    expect(Object.values(bound.settings)).not.toContain(1.25);
    expect(Object.values(bound.body)).not.toContain(1.25);
    // The value is withheld from the wire, not from the adapter: the record of
    // how the author meant this model to be asked has to survive the host.
    expect(adapter.profile.topNsigma).toBe(1.25);
  });

  it("binds the same adapter differently for another host, without touching the adapter", () => {
    const bound = bindTextModelProfile(adapter, "openrouter");

    // OpenRouter's provider models top-k as a real call setting, so the same
    // declared value moves columns. This is the whole point of the host
    // parameter: a lane that switches hosts changes an argument, not a table.
    expect(bound.settings).toEqual({ temperature: 1, topK: 100 });
    expect(bound.body).toEqual({ min_p: 0.1 });
    // And a value this host has no field for at all is reported rather than
    // respelled — `minTokens` travels on Featherless and nowhere here.
    expect(bound.withheld.map((entry) => entry.feature)).toEqual(["minTokens", "topNsigma"]);
  });

  it("still binds for a placeholder host, which serves nothing and withholds nothing", () => {
    // Serving and spelling are different questions, and only the first one
    // `placeholder` answers. A placeholder has no transport, so `hostsServing`
    // leaves it out — but binding for it still works, because "what would this
    // profile look like over there?" is worth asking about a lane that does not
    // exist yet. A change that made `bindingFor` placeholder-aware would break
    // exactly this and nothing else.
    expect(bindTextModelProfile(adapter, "self-hosted").withheld).toEqual([]);
  });
});

/**
 * The same law applied to values that belong to ONE CALL rather than to a
 * model: the minimum-token floor a lane asks for on a single retry.
 *
 * The defect this kills is an application that spells the wire field itself.
 * Before this function existed the chat lane held `{ featherless: { min_tokens:
 * 48 } }` as a literal, so "wire spellings live in the dialects alone" was true
 * of profiles and false of per-call knobs — and the day that model moved hosts,
 * the profile would have followed and the floor would not.
 */
describe("bindTextProfileValues", () => {
  it("spells a per-call value with the host's own dialect, on the same column split as a profile", () => {
    // Featherless documents `min_tokens` and the OpenAI-compatible transport has
    // no argument for it, so the floor rides the raw body — which is the entire
    // reason the lane may not simply pass it as a call setting.
    expect(bindTextProfileValues({ minTokens: 48 }, "featherless")).toEqual({
      settings: {},
      body: { min_tokens: 48 },
      withheld: [],
    });
  });

  it("withholds a per-call value the host does not serve instead of inventing a field for it", () => {
    // OpenRouter documents no minimum-generation floor at all. A caller that
    // asked for one there gets it reported, not silently spelled as something
    // else — and the call still goes, because a withheld value is never an error.
    expect(bindTextProfileValues({ minTokens: 48 }, "openrouter")).toEqual({
      settings: {},
      body: {},
      withheld: [
        { feature: "minTokens", reason: "openrouter does not serve minTokens, so the profile's value for it is not sent." },
      ],
    });
  });

  it("binds nothing from an empty layer, so a lane with no defaults adds no key", () => {
    expect(bindTextProfileValues({}, "featherless")).toEqual({ settings: {}, body: {}, withheld: [] });
  });
});

/**
 * The placeholder dialect is the vocabulary's completeness check: it names
 * every knob, including the ones no reachable host serves, so a sampler that is
 * present in the vocabulary and off everywhere still has one place that spells
 * it. A feature added without that row breaks the claim silently — everywhere
 * else it reads as a host that simply refuses the knob.
 */
describe("the vocabulary and the placeholder dialect", () => {
  // Read off the module rather than listed: the feature factories are the
  // package's zero-argument exports, so a knob added tomorrow is held to this
  // rule on the day it lands.
  it("names every knob in the vocabulary, so none of them is spelled nowhere", () => {
    const vocabulary = Object.values(features)
      .filter((value): value is () => features.TextModelFeature => typeof value === "function" && value.length === 0)
      .map((factory) => factory());

    // A sanity floor on the filter itself: if it ever stopped matching the
    // factories, the loop below would pass by examining nothing.
    expect(vocabulary.length).toBeGreaterThan(30);
    for (const feature of vocabulary) {
      // The placeholder names every knob, so a feature it does NOT name is one
      // whose dialect key was misspelled or forgotten — which reads, everywhere
      // else, as a host that simply refuses the knob.
      expect(bindingFor("self-hosted", feature.id), feature.id).not.toBeNull();
    }
  });
});

describe("hostsServing", () => {
  it("derives availability from the dialect tables, counting only hosts that have a transport", () => {
    expect(hostsServing("temperature")).toEqual(["featherless", "openrouter"]);
    expect(hostsServing("minTokens")).toEqual(["featherless"]);
    expect(hostsServing("topA")).toEqual(["openrouter"]);
  });

  // The vocabulary carries no chat-template argument at all any more, on any
  // host: `thinking` was composed by nobody once both models that needed one
  // moved to a request preparer, and a member no profile sets is an unproven
  // claim. An id no dialect names answers empty, which is what this is.
  it("names no chat-template argument, because none of them is a feature", () => {
    expect(hostsServing("thinking")).toEqual([]);
  });

  it("answers with an empty list for a knob present in the vocabulary and off everywhere", () => {
    // The declared-but-unhosted set. The self-hosted placeholder spells
    // top-n-sigma and no transport reaches it, so naming it there is a spelling
    // rather than an availability — counting the placeholder would report this
    // knob as reachable and a lane would be entitled to send it nowhere. A
    // later host turns this answer non-empty by adding one dialect row.
    expect(hostsServing("topNsigma")).toEqual([]);
    // The two knobs the vocabulary grew for an author who set them and it could
    // not state. Both are spelled only by the placeholder, which is why a
    // profile that declares them has them withheld rather than sent.
    expect(hostsServing("repetitionPenaltySlope")).toEqual([]);
    expect(hostsServing("dryRange")).toEqual([]);
  });

  it("answers with an empty list for a feature id no dialect names", () => {
    // The case that catches a dialect key misspelled, which would otherwise
    // read as a host that simply refuses the knob.
    expect(hostsServing("guidanceRescale")).toEqual([]);
  });
});

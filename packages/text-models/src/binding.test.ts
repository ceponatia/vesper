import { describe, expect, it } from "vitest";
import { bindTextModelProfile, defineTextModel, type TextModelAdapter } from "./composer";
import { minPFeature, temperatureFeature, thinkingFeature, topKFeature, topNsigmaFeature } from "./features";
import { hostsServing } from "./hosts";

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
 * - **The thinking toggle sent as three keys or as a bare boolean.** One
 *   normalized key inside `chat_template_kwargs` is the measured shape.
 */

const adapter: TextModelAdapter = defineTextModel({
  id: "author/fixture-24b-v1",
  family: "fixture-24b",
  host: "featherless",
  chatTemplate: "mistral-tekken",
  features: [temperatureFeature(), topKFeature(), minPFeature(), thinkingFeature(), topNsigmaFeature()],
  profile: { temperature: 1, topK: 100, minP: 0.1, thinking: false, topNsigma: 1.25 },
});

describe("bindTextModelProfile", () => {
  it("splits the featherless profile into SDK settings and raw body fields", () => {
    const bound = bindTextModelProfile(adapter);

    expect(bound.settings).toEqual({ temperature: 1 });
    expect(bound.body).toEqual({
      top_k: 100,
      min_p: 0.1,
      chat_template_kwargs: { enable_thinking: false },
    });
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
    expect(bound.withheld.map((entry) => entry.feature)).toEqual(["thinking", "topNsigma"]);
  });
});

describe("hostsServing", () => {
  it("derives availability from the dialect tables rather than a second list", () => {
    expect(hostsServing("temperature")).toEqual(["featherless", "openrouter", "self-hosted"]);
    expect(hostsServing("thinking")).toEqual(["featherless", "self-hosted"]);
    expect(hostsServing("topA")).toEqual(["openrouter", "self-hosted"]);
  });

  it("answers with an empty list for a feature id no dialect names", () => {
    // The honest answer for a knob that has been added to the vocabulary and
    // not yet bound anywhere — and the answer that catches a dialect key
    // misspelled, which would otherwise read as a host that simply refuses it.
    expect(hostsServing("guidanceRescale")).toEqual([]);
  });
});

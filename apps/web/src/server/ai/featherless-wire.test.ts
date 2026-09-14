import { adapterForTextModel } from "@vesper/text-models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { NARRATIVE_MODELS } from "@/lib/narrative-models";
import { streamCharacterChat } from "@/server/engine";
import { generateChecked } from "./generate-checked";
import {
  ASMODEUS_24B_V3_ID,
  DARKIDOL_QWEN38_ID,
  FABLE_FUSION_711_ID,
  F451_ULTRA_PRO_WRITER_ID,
} from "./model-adapters";
import type { NarratorCompletion } from "./narrator-completion";

/**
 * Proof that each exact-model adapter actually reaches the wire, on BOTH
 * narrator lanes, with no network call.
 *
 * The join is unit-tested next door (`model-adapters.test.ts`), but a correct
 * merge is only half the claim. The other half is that the bound settings really
 * do become SDK arguments, that the bound raw fields really do survive the
 * transport's provider-options spread, that the request preparer really is
 * installed as `transformRequestBody`, and that BOTH narrator call paths go
 * through that transport. That link is exactly what breaks silently — a profile
 * resolved and never applied looks identical to a profile that works, right up
 * until a model returns nothing.
 *
 * `globalThis.fetch` is replaced with a stub that captures the outgoing body and
 * answers with a minimal OpenAI-compatible response, so every assertion below is
 * against the real serialized request the provider would have sent.
 *
 * The two lanes, and why each is asserted rather than inferred from the other:
 *
 * - **The successor narrator** reaches Featherless through `generateChecked`
 *   (`engine/sim-narrator.ts` → `renderCommittedCut` / `renderSoloNarration`),
 *   which calls `generateText` and brings its own lane settings — temperature
 *   0.85 and a 2,000-token budget — for the adapter to outrank.
 * - **The chat lane** reaches it through `streamCharacterChat`
 *   (`engine/character-chat.ts`), which calls `streamText` with the lane
 *   temperature and no budget at all. `doGenerate` and `doStream` build their
 *   bodies independently in the AI SDK, so neither is evidence for the other.
 *
 * Both lanes are driven through their real entry points on purpose: a test that
 * called `streamText({ model: textModel(id) })` directly would assert nothing
 * about this change, because the profile no longer rides the transport.
 */

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

const captured: CapturedRequest[] = [];
let originalFetch: typeof globalThis.fetch;
/** Set by a test to answer with a failure instead of a completion. */
let respondWith: (() => Response) | null = null;

/** Featherless's cold-start answer for an idle model, verbatim in shape. */
function capacityExhausted(): Response {
  return new Response(
    JSON.stringify({
      error: { message: `${FABLE_FUSION_711_ID} is temporarily at capacity. Please try again shortly.`, code: "capacity_exhausted" },
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

/** A minimal non-streaming OpenAI-compatible chat completion. */
function jsonCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl-test",
      created: 1_760_000_000,
      model: FABLE_FUSION_711_ID,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 34, completion_tokens: 32 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A minimal SSE stream carrying one content delta and a finish. */
function sseCompletion(content: string): Response {
  const frames = [
    { choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 34, completion_tokens: 32 } },
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "cmpl-test", model: FABLE_FUSION_711_ID, ...frame })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  captured.length = 0;
  respondWith = null;
  // generateChecked short-circuits in demo mode; these two are what take it live.
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.AI_FAKE = "";
  process.env.FEATHERLESS_API_TOKEN = "test-token";
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(raw) as Record<string, unknown>;
    captured.push({ url, body });
    if (respondWith) return respondWith();
    return body.stream === true ? sseCompletion("She waits.") : jsonCompletion('{"prose":"She waits."}');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.AI_FAKE = "1";
});

const FEATHERLESS_URL = "https://api.featherless.ai/v1/chat/completions";

/**
 * The transport plumbing every request carries whatever model it names. Removing
 * it leaves EXACTLY what this model is asked with, which is what lets the
 * assertions below be `toEqual` rather than `toMatchObject` — an extra sampler
 * nobody intended is a wire change, and it has to fail here.
 */
const TRANSPORT_KEYS: ReadonlySet<string> = new Set(["model", "messages", "stream", "stream_options"]);

/** Everything the captured request asks the model for, plumbing removed. */
function samplerFields(request: CapturedRequest | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(request?.body ?? {}).filter(([key]) => !TRANSPORT_KEYS.has(key)));
}

/** One chat-lane turn through the real narrator stream; returns what reached the player. */
async function chatLane(modelId: string): Promise<string> {
  let text = "";
  for await (const delta of streamCharacterChat({
    system: "narrate",
    history: [{ role: "user", content: "hello" }],
    name: "Mira",
    names: { speakers: ["Mira"], plain: ["Brian"] },
    model: modelId,
  })) {
    text += delta;
  }
  return text;
}

/**
 * One successor-lane RENDER, with that lane's own settings and its opt-in
 * (`engine/sim-narrator.ts` → `liveRenderSeam` / `liveSoloSeam`).
 *
 * `applyModelProfile` is what says "this leg is the narration". Without it
 * `generateChecked` asks at its own settings, which is what every other caller
 * of this helper — the post-turn agents, intake, the scene composer, vision,
 * successor deliberation — needs and gets.
 */
async function successorLane(modelId: string): Promise<{ prose: string } | null> {
  const result = await generateChecked({
    schema: z.object({ prose: z.string() }),
    system: "narrate",
    prompt: "the cut",
    modelId,
    temperature: 0.85,
    maxOutputTokens: 2_000,
    applyModelProfile: true,
    code: "sim.narrator",
  });
  return result.value;
}

/**
 * One successor DELIBERATION call, shaped as `buildLiveDeliberation` shapes it:
 * the chat's narrator model, a classifier's temperature, a 300-token ceiling,
 * and no opt-in. The schema is this file's own — what is being asserted is the
 * request, not the parse.
 */
async function deliberationLane(modelId: string): Promise<void> {
  await generateChecked({
    schema: z.object({ prose: z.string() }),
    system: "choose one option",
    prompt: "CANDIDATES: a | b",
    modelId,
    temperature: 0.2,
    maxOutputTokens: 300,
    code: "sim.deliberator",
  });
}

/**
 * The DavidAU rows' measured non-thinking baseline, exactly as it has always
 * reached Featherless — and it reaches it through two different mechanisms,
 * which is the whole reason this file asserts the serialized body rather than
 * the lane's arguments.
 *
 * `top_k` and `repetition_penalty` are the bound PROFILE's raw half: the
 * OpenAI-compatible transport has no argument for either (it drops `topK` with
 * an "unsupported setting" warning). `chat_template_kwargs` is not a sampler at
 * all — it is a chat-template argument applied by the adapter's request
 * PREPARER at the model boundary, so it travels on every call this model
 * receives rather than only the ones a lane opted in as narration. Both of its
 * alternatives (`reasoning_effort: "none"`, a `/no_think` token in the prompt)
 * were probed on these exact models and silently ignored.
 */
const DAVIDAU_SAMPLERS = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  presence_penalty: 1.5,
  repetition_penalty: 1,
  chat_template_kwargs: { enable_thinking: false },
};

/**
 * Asmodeus's approved profile as Featherless carries it — seven of the eighteen
 * declared values, the other eleven withheld by host selection rather than
 * deleted. The owner ruled this exact set (2026-09-04, plus the output cap on
 * 2026-09-14), so the literal is the contract rather than a convenience.
 */
const ASMODEUS_SAMPLERS = {
  temperature: 1,
  top_p: 1,
  top_k: 100,
  min_p: 0.1,
  repetition_penalty: 1.08,
  presence_penalty: 0,
  max_tokens: 1_024,
};

describe("the DavidAU non-thinking profile on the wire", () => {
  // Measured on the live endpoint 2026-08-17 and re-reproduced the same day:
  // with the thinking template ON and a bounded output budget these models
  // return an EMPTY reply (`finish_reason: "length"`, ~298 completion tokens,
  // zero characters of content) and first prose at ~61s — past the chat lane's
  // 50s first-token watchdog. With it OFF: `stop`, prose, zero reasoning, ~2.4s.
  it("reaches the successor narrator's generateChecked call, keeping that lane's budget", async () => {
    expect(await successorLane(FABLE_FUSION_711_ID)).toEqual({ prose: "She waits." });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(FEATHERLESS_URL);
    // The call site's own temperature is outranked by the model's profile; its
    // output budget is left alone, because this adapter declares no cap.
    expect(samplerFields(captured[0])).toEqual({ ...DAVIDAU_SAMPLERS, max_tokens: 2_000 });
  });

  it("reaches the chat lane's streamed call, which brings no budget of its own", async () => {
    expect(await chatLane(FABLE_FUSION_711_ID)).toBe("She waits.");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(FEATHERLESS_URL);
    expect(captured[0]?.body.stream).toBe(true);
    expect(samplerFields(captured[0])).toEqual(DAVIDAU_SAMPLERS);
  });

  // ONE key, not three. Featherless normalizes `enable_thinking` / `thinking` /
  // `do_reasoning` to the same switch and each was probed alone on this exact
  // model — all three produced `stop`, prose and zero reasoning — so the
  // confirmed-sufficient key is what ships, and redundancy against a hazard the
  // evidence says does not exist is what this assertion refuses.
  it("sends exactly one thinking-disable key, on both lanes", async () => {
    await successorLane(FABLE_FUSION_711_ID);
    await chatLane(FABLE_FUSION_711_ID);

    expect(captured).toHaveLength(2);
    for (const request of captured) {
      expect(Object.keys(request.body.chat_template_kwargs as object)).toEqual(["enable_thinking"]);
    }
  });

  // The two rows exist to be COMPARED — same author, same base family, same
  // quantization, same host economics — so a sampler difference between them
  // would confound the only question the comparison asks. Probed independently:
  // the second fails identically without the flag (`length`, 299 completion
  // tokens, zero content).
  it("asks the second DavidAU row with a byte-identical body apart from the model id", async () => {
    await chatLane(FABLE_FUSION_711_ID);
    await chatLane(F451_ULTRA_PRO_WRITER_ID);

    expect(captured).toHaveLength(2);
    expect(captured[1]?.body.model).toBe(F451_ULTRA_PRO_WRITER_ID);
    expect({ ...(captured[1]?.body ?? {}), model: FABLE_FUSION_711_ID }).toEqual(captured[0]?.body);
  });
});

/**
 * Asmodeus 24B v3 — the author's whole published profile, with Featherless
 * carrying the seven fields it serves.
 *
 * The assertion that matters most is an ABSENCE: `chat_template_kwargs` is
 * rejected outright on this model's Mistral tokenizer, with a 400, even when the
 * object is empty. Every other ADAPTED Featherless narrator sends that key — two
 * to suppress a chain, one to ask for a medium one — so "this one must not" is
 * precisely the claim an exact-id registry exists to hold, and precisely the one
 * a family- or host-shaped shortcut would break.
 */
describe("the Asmodeus profile on the wire", () => {
  it("asks the chat lane's streamed call with exactly the approved profile", async () => {
    expect(await chatLane(ASMODEUS_24B_V3_ID)).toBe("She waits.");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(FEATHERLESS_URL);
    expect(samplerFields(captured[0])).toEqual(ASMODEUS_SAMPLERS);
  });

  // The 1,024-token cap deliberately overrides the successor lane's 2,000. It is
  // not a stop condition — the model ends its own turns — it is an ADMISSION
  // control: with no `max_tokens` the host reserves 4,096 output tokens inside
  // the same 32,768-token window, which leaves ~28.7K of usable prompt instead
  // of ~31.7K (owner decision, 2026-09-14).
  it("overrides the successor lane's output budget with its own cap", async () => {
    expect(await successorLane(ASMODEUS_24B_V3_ID)).toEqual({ prose: "She waits." });

    expect(captured).toHaveLength(1);
    expect(samplerFields(captured[0])).toEqual(ASMODEUS_SAMPLERS);
    expect(captured[0]?.body.max_tokens).toBe(1_024);
  });

  it("sends no chat_template_kwargs on either lane — the field 400s this model", async () => {
    await successorLane(ASMODEUS_24B_V3_ID);
    await chatLane(ASMODEUS_24B_V3_ID);

    expect(captured).toHaveLength(2);
    for (const request of captured) expect(request.body).not.toHaveProperty("chat_template_kwargs");
  });

  // Featherless honours its documented parameter set and silently drops every
  // undocumented field — 200, no error, no effect — so a withheld value that
  // leaked would be untestable anywhere but here.
  it("sends none of the local-runtime samplers the author also published", async () => {
    await chatLane(ASMODEUS_24B_V3_ID);

    for (const field of [
      "top_nsigma",
      "nsigma",
      "dry_multiplier",
      "dry_base",
      "dry_allowed_length",
      "dry_penalty_last_n",
      "xtc_probability",
      "xtc_threshold",
      "dynatemp_min",
      "dynatemp_max",
      "rep_pen_range",
      "rep_pen_slope",
    ]) {
      expect(captured[0]?.body, field).not.toHaveProperty(field);
    }
  });
});

/**
 * DarkIdol asks for the OPPOSITE of its Qwen3.6 host-mates — a short planning
 * pass at medium effort, where they suppress their chain entirely — and both
 * requests reach the wire through the same mechanism: a chat-template argument
 * applied by a request preparer at the model boundary.
 *
 * This case and the DavidAU ones above are together the only proof that the
 * Featherless transport is still constructed with `prepareTextRequestBody` as
 * its `transformRequestBody` hook. A hook configured and never installed looks
 * identical to a hook that works.
 */
describe("DarkIdol's request preparer on the wire", () => {
  it("carries the medium reasoning effort and the author's supported samplers", async () => {
    expect(await chatLane(DARKIDOL_QWEN38_ID)).toBe("She waits.");

    expect(captured).toHaveLength(1);
    expect(samplerFields(captured[0])).toEqual({
      temperature: 1,
      min_p: 0.05,
      chat_template_kwargs: { reasoning_effort: "medium" },
    });
  });

  it("keeps the reasoning keyword through the successor lane too", async () => {
    await successorLane(DARKIDOL_QWEN38_ID);

    expect(samplerFields(captured[0])).toEqual({
      temperature: 1,
      min_p: 0.05,
      max_tokens: 2_000,
      chat_template_kwargs: { reasoning_effort: "medium" },
    });
  });
});

/**
 * `generateChecked` serves one narration leg and a dozen legs that are not
 * narration, so the profile is opt-in per call. This is the gate itself, at the
 * wire, on a model that HAS a profile — the only place the two answers can be
 * put side by side.
 *
 * The defect it kills was live: successor deliberation runs on the chat's
 * narrator model and asks for one strict JSON object at temperature 0.2 inside a
 * 300-token ceiling and a 4-second budget. Routed through the join it became
 * temperature 1.0 with a wide top-k — and `max_tokens` 1024, a caller's ceiling
 * RAISED by a profile, which is a direction nothing else in this design does.
 *
 * The gate has a matching hazard on the other side, and the last case here is
 * its pin: a model that must be told not to think must be told on EVERY call,
 * including the ones the gate holds back. Its suppression is therefore a
 * preparer rather than a profile value, and a version of this gate that took the
 * template argument with the samplers would hand the deliberator a DavidAU row
 * with its chain switched on — 298 completion tokens of reasoning, zero
 * characters of content, inside a 4-second budget.
 */
describe("the model profile is opt-in per generateChecked call", () => {
  it("asks an adapted model at the caller's own settings when the call is not narration", async () => {
    await deliberationLane(ASMODEUS_24B_V3_ID);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(FEATHERLESS_URL);
    expect(samplerFields(captured[0])).toEqual({ temperature: 0.2, max_tokens: 300 });
  });

  it("never lets a profile raise a non-narration caller's own ceiling", async () => {
    await deliberationLane(ASMODEUS_24B_V3_ID);

    // 300 is what this leg can afford inside its 4s budget; 1,024 is the
    // narration cap. A profile that lifted the first to the second would spend a
    // deliberation's whole budget on a completion nobody asked for.
    expect(captured[0]?.body.max_tokens).toBe(300);
  });

  it("applies the profile to the same model the moment the caller says it is narration", async () => {
    await deliberationLane(ASMODEUS_24B_V3_ID);
    await successorLane(ASMODEUS_24B_V3_ID);

    expect(captured).toHaveLength(2);
    expect(samplerFields(captured[0])).toEqual({ temperature: 0.2, max_tokens: 300 });
    expect(samplerFields(captured[1])).toEqual(ASMODEUS_SAMPLERS);
  });

  /**
   * The other half, and the one that was a live regression: what the gate holds
   * back is the SAMPLER PROFILE, never a chat-template argument.
   *
   * A DavidAU row asked without the opt-in keeps the caller's own temperature
   * and ceiling — none of its narration samplers appear — and still arrives with
   * its thinking mode switched off, because that is a preparer at the model
   * boundary rather than a profile value. Without it this exact call spends its
   * whole 300-token budget on a reasoning chain and returns zero characters,
   * which the deliberator can only report as a malformed reply.
   */
  it("keeps a DavidAU row's thinking suppression on a call that opted out of its profile", async () => {
    await deliberationLane(FABLE_FUSION_711_ID);

    expect(captured).toHaveLength(1);
    expect(samplerFields(captured[0])).toEqual({
      temperature: 0.2,
      max_tokens: 300,
      chat_template_kwargs: { enable_thinking: false },
    });
    // Stated separately because it is the regression itself: the caller's own
    // two settings survive, and the narration baseline is nowhere near them.
    expect(captured[0]?.body.temperature).toBe(0.2);
    expect(captured[0]?.body.max_tokens).toBe(300);
    for (const field of ["top_k", "top_p", "presence_penalty", "repetition_penalty"]) {
      expect(captured[0]?.body, field).not.toHaveProperty(field);
    }
  });
});

/**
 * The isolation guarantee at the wire: a curated Featherless row Vesper has NOT
 * measured must arrive with the lane's own settings and nothing else — no
 * sampler inherited from a host-mate, no thinking key, no `top_k`.
 *
 * The row is read off the catalog crossed with the registry rather than named,
 * so the claim follows whichever row is currently unadapted.
 */
describe("an unadapted Featherless row is shaped by its lane alone", () => {
  const unadaptedId =
    NARRATIVE_MODELS.find((option) => option.provider === "featherless" && adapterForTextModel(option.id) === null)
      ?.id ?? "";

  it("has an unadapted Featherless row on the catalog", () => {
    expect(unadaptedId).not.toBe("");
  });

  it("asks it with the chat lane's temperature and nothing else", async () => {
    await chatLane(unadaptedId);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(FEATHERLESS_URL);
    expect(samplerFields(captured[0])).toEqual({ temperature: 0.85 });
  });

  it("asks it with the successor lane's temperature and budget and nothing else", async () => {
    await successorLane(unadaptedId);

    expect(captured).toHaveLength(1);
    expect(samplerFields(captured[0])).toEqual({ temperature: 0.85, max_tokens: 2_000 });
  });
});

/**
 * The cold start, end to end through the real provider stack. This is the failure that
 * was being reported to players as "the narrator model finished without saying anything":
 * a `503 capacity_exhausted` does not throw out of `streamText` — the SDK reports it
 * through `onError` and ends `textStream` clean with zero deltas, so the chat pipeline's
 * catch never fires and the exchange looks like a silent model.
 *
 * Reproduced live on 2026-08-17 (the first probe call to an idle model: zero visible text,
 * `finishReason "error"`, 15.0s) and pinned here against a stubbed response so it stays
 * covered without a sleeping model or a billed call.
 */
describe("a Featherless cold start", () => {
  // Generous timeout on purpose: the SDK's own retry budget is part of what is asserted,
  // and it sleeps between attempts.
  it("ends the stream clean with an error finish rather than throwing", { timeout: 30_000 }, async () => {
    respondWith = capacityExhausted;
    const observed: { value: NarratorCompletion | null } = { value: null };
    let text = "";
    for await (const delta of streamCharacterChat({
      system: "narrate",
      history: [{ role: "user", content: "hello" }],
      name: "Mira",
      names: { speakers: ["Mira"], plain: ["Brian"] },
      model: FABLE_FUSION_711_ID,
      onCompletion: (value) => {
        observed.value = value;
      },
    })) {
      text += delta;
    }
    expect(text).toBe("");
    expect(observed.value?.finishReason).toBe("error");
    // …and it is recorded under the provider's own class and words, not as an empty reply.
    expect(observed.value?.providerError?.code).toBe("provider_error");
    expect(observed.value?.providerError?.detail).toContain("temporarily at capacity");
    // The hidden retry must not swallow a 503: a sleeping model is not an empty completion.
    expect(observed.value?.attempts).toBe(1);
    // The SDK's own retry budget (3 attempts) is what decides how long a cold start takes
    // to surface — measured at ~15s live, comfortably inside the 50s first-token watchdog.
    // Pinned here because a larger budget is what would turn this into a timeout instead.
    expect(captured).toHaveLength(3);
  });
});

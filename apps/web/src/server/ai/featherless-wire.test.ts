import { streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { streamCharacterChat } from "@/server/engine";
import { generateChecked } from "./generate-checked";
import type { NarratorCompletion } from "./narrator-completion";
import { FABLE_FUSION_711_ID, textModel } from "./provider";

/**
 * Proof that the exact-model Featherless policy actually reaches the wire, on BOTH
 * narrator lanes, with no network call.
 *
 * `featherlessRequestBody` is unit-tested next door, but a correct pure function is
 * only half the claim: the other half is that the transport really is built with it
 * as its `transformRequestBody` hook, and that both narrator call paths go through
 * that transport. That link is exactly what breaks silently — a policy configured
 * and never applied looks identical to a policy that works, right up until a model
 * returns nothing.
 *
 * `globalThis.fetch` is replaced with a stub that captures the outgoing body and
 * answers with a minimal OpenAI-compatible response, so this asserts the real
 * serialized request the provider would have sent.
 *
 * The two lanes:
 *
 * - **The successor narrator** reaches Featherless through `generateChecked`
 *   (`engine/sim-narrator.ts` → `renderCommittedCut` / `renderSoloNarration`), which
 *   calls `generateText`. That is the parity case: the successor gets the Fable
 *   policy for free because the policy rides the transport rather than a call site.
 * - **The chat lane** reaches it through `streamText` (`engine/character-chat.ts`).
 *   `doGenerate` and `doStream` apply the hook independently in the AI SDK, so both
 *   are asserted rather than one being taken as evidence for the other.
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

const EXPECTED_POLICY = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  presence_penalty: 1.5,
  repetition_penalty: 1,
  chat_template_kwargs: { enable_thinking: false },
};

describe("the Fable policy on the wire", () => {
  it("reaches the successor narrator's generateChecked call", async () => {
    const result = await generateChecked({
      schema: z.object({ prose: z.string() }),
      system: "narrate",
      prompt: "the cut",
      modelId: FABLE_FUSION_711_ID,
      // The successor narrator's own settings (engine/sim-narrator.ts).
      temperature: 0.85,
      maxOutputTokens: 2_000,
      code: "sim.narrator",
    });
    expect(result.value).toEqual({ prose: "She waits." });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://api.featherless.ai/v1/chat/completions");
    expect(captured[0]?.body).toMatchObject(EXPECTED_POLICY);
    // The call site's own temperature is overridden by the model's profile, and its
    // output budget is left alone.
    expect(captured[0]?.body.max_tokens).toBe(2_000);
  });

  it("reaches the chat lane's streamText call", async () => {
    const result = streamText({
      model: textModel(FABLE_FUSION_711_ID),
      system: "narrate",
      prompt: "hello",
      temperature: 0.85,
    });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe("She waits.");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({ ...EXPECTED_POLICY, stream: true });
  });

  // The isolation guarantee at the wire: a second Featherless row must arrive with the
  // call site's own settings and no thinking flag.
  it("leaves another Featherless model's request shaped by the call site alone", async () => {
    const result = streamText({
      model: textModel("SomeOwner/Some-Other-Merge"),
      system: "narrate",
      prompt: "hello",
      temperature: 0.85,
    });
    for await (const delta of result.textStream) void delta;
    expect(captured[0]?.body.temperature).toBe(0.85);
    expect(captured[0]?.body).not.toHaveProperty("top_k");
    expect(captured[0]?.body).not.toHaveProperty("repetition_penalty");
    expect(captured[0]?.body).not.toHaveProperty("chat_template_kwargs");
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

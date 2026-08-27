import { beforeEach, describe, expect, it, vi } from "vitest";
import { FABLE_FUSION_711_ID } from "@/server/ai";
import type { NarratorCompletion } from "@/server/ai";

/**
 * The narrator stream's completion metadata and the exact-model hidden
 * retry. `streamText` is scripted
 * attempt by attempt so every case runs with zero network: the questions here are
 * "how many attempts did it make", "what did it report", and "what reached the
 * player", none of which need a live provider.
 *
 * `./constants` is real, `../ai/provider` is taken out of demo mode (the pure suite
 * forces `AI_FAKE=1`) and its transports are stubbed to plain model objects — the
 * request-body policy those transports carry has its own test in
 * `server/ai/provider.test.ts`.
 */

interface ScriptedAttempt {
  /** Raw text deltas this attempt streams before Vesper's normalizers see them. */
  deltas: string[];
  finishReason?: string;
  rawFinishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    outputTokenDetails?: { textTokens?: number; reasoningTokens?: number };
  };
  /** Throw instead of streaming — the provider-exception path. */
  error?: Error;
  /**
   * Report a failure through the SDK's `onError` hook and finish clean instead of
   * throwing — the shape a Featherless cold-start 503 actually takes.
   */
  streamError?: Error;
}

const script = vi.hoisted(() => ({
  attempts: [] as ScriptedAttempt[],
  /** The options each `streamText` call was actually made with. */
  requests: [] as Record<string, unknown>[],
}));

vi.mock("../ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/provider")>();
  return {
    ...actual,
    isDemoMode: () => false,
    textModel: (modelId: string) => ({ modelId }),
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (options: Record<string, unknown>) => {
      script.requests.push(options);
      const next = script.attempts.shift();
      if (next === undefined) throw new Error("streamText was called more times than the script allows");
      const onError = options.onError as ((event: { error: unknown }) => void) | undefined;
      const textStream = (async function* () {
        if (next.error) throw next.error;
        // The SDK reports some provider failures through `onError` and ends the stream
        // cleanly rather than throwing — mirrored here so the pipeline path is real.
        if (next.streamError) onError?.({ error: next.streamError });
        for (const delta of next.deltas) yield delta;
      })();
      return {
        textStream,
        finishReason: Promise.resolve(next.finishReason ?? "stop"),
        rawFinishReason: Promise.resolve(next.rawFinishReason),
        totalUsage: Promise.resolve({
          inputTokens: next.usage?.inputTokens,
          outputTokens: next.usage?.outputTokens,
          outputTokenDetails: next.usage?.outputTokenDetails ?? {},
        }),
      };
    },
  };
});

const { streamCharacterChat } = await import("./character-chat");

const NAMES = { speakers: ["Mira"], plain: ["Brian"] };

/** Drain the stream, returning what reached the player plus the reported completion. */
async function run(options: {
  model: string;
  attempts: ScriptedAttempt[];
  signal?: AbortSignal;
}): Promise<{ text: string; completion: NarratorCompletion | null; calls: number }> {
  script.attempts = [...options.attempts];
  script.requests = [];
  let completion: NarratorCompletion | null = null;
  let text = "";
  for await (const delta of streamCharacterChat({
    system: "narrate",
    history: [{ role: "user", content: "hello" }],
    name: "Mira",
    names: NAMES,
    model: options.model,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onCompletion: (value) => {
      completion = value;
    },
  })) {
    text += delta;
  }
  return { text, completion, calls: script.requests.length };
}

beforeEach(() => {
  process.env.FEATHERLESS_API_TOKEN = "test-token";
  script.attempts = [];
  script.requests = [];
});

describe("narrator completion metadata", () => {
  it("reports the finish state, token counts and both text lengths", async () => {
    const { text, completion } = await run({
      model: FABLE_FUSION_711_ID,
      attempts: [
        {
          deltas: ["[Mira] She ", "opens the door."],
          finishReason: "stop",
          rawFinishReason: "eos",
          usage: {
            inputTokens: 10_712,
            outputTokens: 96,
            outputTokenDetails: { textTokens: 96, reasoningTokens: 0 },
          },
        },
      ],
    });
    expect(text).toBe("[Mira] She opens the door.");
    expect(completion).toEqual({
      provider: "featherless",
      modelId: FABLE_FUSION_711_ID,
      finishReason: "stop",
      rawFinishReason: "eos",
      inputTokens: 10_712,
      outputTokens: 96,
      textTokens: 96,
      reasoningTokens: 0,
      rawTextLength: 26,
      visibleTextLength: 26,
      visibleTextChars: 22,
      attempts: 1,
    });
  });

  it("omits a token subtype the provider did not report rather than calling it zero", async () => {
    // Featherless returns `completion_tokens` with no `completion_tokens_details`.
    const { completion } = await run({
      model: FABLE_FUSION_711_ID,
      attempts: [{ deltas: ["She waits."], usage: { inputTokens: 34, outputTokens: 32 } }],
    });
    expect(completion?.outputTokens).toBe(32);
    expect(completion).not.toHaveProperty("textTokens");
    expect(completion).not.toHaveProperty("reasoningTokens");
  });

  // The measurement that makes normalizer erasure detectable: raw length is taken
  // UPSTREAM of the strip/collapse chain, visible length downstream.
  it("separates raw provider text from the text that survived normalizing", async () => {
    const { text, completion } = await run({
      model: "aion-labs/aion-3.0",
      attempts: [{ deltas: ["<uncensored_response>", "She waits.", "</uncensored_response>"] }],
    });
    expect(text).toBe("She waits.");
    expect(completion?.rawTextLength).toBe(53);
    expect(completion?.visibleTextLength).toBe(10);
  });

  it("reports a zero-token completion with its finish reason intact", async () => {
    const { text, completion } = await run({
      model: "aion-labs/aion-3.0",
      attempts: [{ deltas: [], finishReason: "length", usage: { outputTokens: 298 } }],
    });
    expect(text).toBe("");
    expect(completion?.finishReason).toBe("length");
    expect(completion?.outputTokens).toBe(298);
    expect(completion?.rawTextLength).toBe(0);
  });
});

describe("the hidden empty-reply retry", () => {
  it("retries a clean empty Fable attempt once and streams only the second reply", async () => {
    const { text, completion, calls } = await run({
      model: FABLE_FUSION_711_ID,
      attempts: [
        { deltas: [], finishReason: "stop" },
        { deltas: ["[Mira] ", "She finally speaks."], finishReason: "stop" },
      ],
    });
    expect(calls).toBe(2);
    expect(text).toBe("[Mira] She finally speaks.");
    expect(completion?.attempts).toBe(2);
    expect(completion?.visibleTextChars).toBeGreaterThan(0);
  });

  it("puts the retry-only minimum-generation floor under a genuinely silent stop", async () => {
    await run({
      model: FABLE_FUSION_711_ID,
      attempts: [
        { deltas: [], finishReason: "stop" },
        { deltas: ["She speaks."], finishReason: "stop" },
      ],
    });
    expect(script.requests[0]?.providerOptions).toBeUndefined();
    expect(script.requests[1]?.providerOptions).toEqual({ featherless: { min_tokens: 48 } });
  });

  // An empty that burned tokens already generated plenty — just not prose. Forcing MORE
  // tokens would treat a configuration failure as a length problem.
  it("withholds the floor when the first attempt burned its budget without prose", async () => {
    await run({
      model: FABLE_FUSION_711_ID,
      attempts: [
        { deltas: [], finishReason: "length", usage: { outputTokens: 298 } },
        { deltas: ["She speaks."], finishReason: "stop" },
      ],
    });
    expect(script.requests).toHaveLength(2);
    expect(script.requests[1]?.providerOptions).toBeUndefined();
  });

  it("stops after exactly two attempts and reports the final empty truthfully", async () => {
    const { text, completion, calls } = await run({
      model: FABLE_FUSION_711_ID,
      attempts: [
        { deltas: [], finishReason: "stop" },
        { deltas: [], finishReason: "length", usage: { outputTokens: 2_000 } },
      ],
    });
    expect(calls).toBe(2);
    expect(text).toBe("");
    expect(completion?.attempts).toBe(2);
    expect(completion?.finishReason).toBe("length");
  });

  it("does not retry a content-filter finish — the same ask is refused again", async () => {
    const { completion, calls } = await run({
      model: FABLE_FUSION_711_ID,
      attempts: [{ deltas: [], finishReason: "content-filter" }],
    });
    expect(calls).toBe(1);
    expect(completion?.finishReason).toBe("content-filter");
  });

  it("does not retry a generation-error finish", async () => {
    const { calls } = await run({
      model: FABLE_FUSION_711_ID,
      attempts: [{ deltas: [], finishReason: "error" }],
    });
    expect(calls).toBe(1);
  });

  // The Featherless cold start, measured live 2026-08-17: the first call to an idle model
  // answers `503 capacity_exhausted`, the SDK reports it through `onError`, and the stream
  // ends clean with zero deltas. It must NOT be swallowed by the empty retry (a 503 is not
  // an empty completion) and it must carry the vendor's own words out.
  it("reports a cold-start 503 as a provider failure and does not retry it", async () => {
    const { completion, calls } = await run({
      model: FABLE_FUSION_711_ID,
      attempts: [
        {
          deltas: [],
          finishReason: "error",
          streamError: new Error("Fable Fusion 711 is temporarily at capacity. Please try again shortly."),
        },
      ],
    });
    expect(calls).toBe(1);
    expect(completion?.finishReason).toBe("error");
    expect(completion?.providerError?.detail).toContain("temporarily at capacity");
  });

  // Auth, credit, context-window, network and ordinary provider failures all arrive as a
  // thrown exception. None is retried: the exception propagates to the pipeline's own
  // classifier on the first attempt.
  it("does not retry a thrown provider failure — it propagates on the first attempt", async () => {
    script.attempts = [{ deltas: [], error: new Error("402 Payment required") }];
    script.requests = [];
    const stream = streamCharacterChat({
      system: "narrate",
      history: [{ role: "user", content: "hello" }],
      name: "Mira",
      names: NAMES,
      model: FABLE_FUSION_711_ID,
    });
    await expect(
      (async () => {
        for await (const delta of stream) void delta;
      })(),
    ).rejects.toThrow("402 Payment required");
    expect(script.requests).toHaveLength(1);
  });

  it("does not retry once the player has stopped the reply", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls } = await run({
      model: FABLE_FUSION_711_ID,
      attempts: [{ deltas: [], finishReason: "stop" }],
      signal: controller.signal,
    });
    expect(calls).toBe(1);
  });

  it("does not retry a Fable attempt that produced a partial reply", async () => {
    const { text, calls } = await run({
      model: FABLE_FUSION_711_ID,
      attempts: [{ deltas: ["[Mira] She turns"], finishReason: "length" }],
    });
    expect(calls).toBe(1);
    expect(text).toBe("[Mira] She turns");
  });

  // Whitespace is not a reply: the pipeline's own test is `full.trim()`, and the stream
  // has to agree or a blank bubble would count as success.
  it("treats an all-whitespace attempt as empty", async () => {
    const { calls } = await run({
      model: FABLE_FUSION_711_ID,
      attempts: [
        { deltas: ["  ", "\n"], finishReason: "stop" },
        { deltas: ["She speaks."], finishReason: "stop" },
      ],
    });
    expect(calls).toBe(2);
  });

  it("never retries a non-Fable narrator's empty reply", async () => {
    for (const modelId of ["aion-labs/aion-3.0", "z-ai/glm-5.2", "~deepseek/deepseek-v4-flash-latest"]) {
      const { calls, completion } = await run({
        model: modelId,
        attempts: [{ deltas: [], finishReason: "stop" }],
      });
      expect(calls).toBe(1);
      expect(completion?.attempts).toBe(1);
      expect(completion?.provider).toBe("openrouter");
    }
  });
});

describe("the proven narrators' requests are unchanged", () => {
  it("asks an OpenRouter narrator with the same temperature and provider options as before", async () => {
    await run({ model: "z-ai/glm-5.2", attempts: [{ deltas: ["She waits."] }] });
    const request = script.requests[0];
    expect(request?.temperature).toBe(0.85);
    expect(request?.providerOptions).toEqual({
      openrouter: { provider: { ignore: ["deepinfra"] }, reasoning: { effort: "low" } },
    });
    expect(request).not.toHaveProperty("maxOutputTokens");
  });

  it("sends no provider options at all for a narrator that has no knobs", async () => {
    await run({ model: "aion-labs/aion-3.0", attempts: [{ deltas: ["She waits."] }] });
    expect(script.requests[0]?.providerOptions).toBeUndefined();
  });

  // The Fable policy travels on the transport, not the call site — so its first call is
  // shaped exactly like any other narrator's.
  it("sends no OpenRouter block to the Featherless narrator", async () => {
    await run({ model: FABLE_FUSION_711_ID, attempts: [{ deltas: ["She waits."] }] });
    expect(script.requests[0]?.providerOptions).toBeUndefined();
    expect(script.requests[0]?.temperature).toBe(0.85);
  });
});

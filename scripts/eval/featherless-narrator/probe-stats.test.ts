import { isNarratorLengthStub, type NarratorCompletion } from "@/server/ai";
import { NARRATIVE_TEMPERATURE } from "@/server/engine";
import { describe, expect, it } from "vitest";
import {
  buildProbeSummary,
  createSseAccumulator,
  percentile,
  rawLengthStub,
  sanitizeHeaders,
  summarizeJsonCompletion,
  summarizeSseEvents,
  transformArmBody,
  wilsonInterval,
  type ProbeCallRecord,
} from "./probe-stats";

/**
 * The pure half of the #594 probe rebuild — every helper here runs with no
 * credential, no clock and no socket, so this is the coverage that actually
 * proves the arithmetic and the parsing before a tester spends anything.
 */

// ---------------------------------------------------------------------------
// percentile
// ---------------------------------------------------------------------------

describe("percentile", () => {
  it("returns null on an empty array", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("returns the single value for every percentile on a length-1 array", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 90)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it("reads an ACTUAL observed value on tiny arrays (nearest-rank), never an interpolation", () => {
    const values = [10, 30, 20];
    // Sorted: [10, 20, 30]. p50 -> rank ceil(0.5*3)=2 -> 20; p90 -> rank ceil(0.9*3)=3 -> 30.
    expect(percentile(values, 50)).toBe(20);
    expect(percentile(values, 90)).toBe(30);
    expect(percentile(values, 100)).toBe(30);
  });

  it("is the max at p100 on a two-element array", () => {
    expect(percentile([5, 1], 100)).toBe(5);
    expect(percentile([5, 1], 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// wilsonInterval
// ---------------------------------------------------------------------------

describe("wilsonInterval", () => {
  it("is {0, 0} for n=0", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
  });

  it("matches the closed-form symmetric case at p-hat=0.5, n=100", () => {
    // At phat=0.5 the Wilson interval has a clean closed form:
    //   low/high = [n + z² ∓ z·sqrt(n + z²)] / [2(n + z²)]
    // which for n=100, z=1.959963984540054 works out to ≈ (0.40383, 0.59617) —
    // the textbook 95% Wilson interval for 50/100, independently derivable from
    // the same formula this function implements.
    const { low, high } = wilsonInterval(50, 100);
    expect(low).toBeCloseTo(0.403832, 5);
    expect(high).toBeCloseTo(0.596168, 5);
  });

  it("keeps 0 successes near (but not below) zero, and bounds the interval to [0, 1]", () => {
    const { low, high } = wilsonInterval(0, 3);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeCloseTo(0, 6);
    expect(high).toBeCloseTo(0.561497, 5);
  });

  it("keeps n successes near (but not above) one, by the same symmetry", () => {
    const { low, high } = wilsonInterval(3, 3);
    expect(high).toBeLessThanOrEqual(1);
    expect(high).toBeCloseTo(1, 6);
    expect(low).toBeCloseTo(0.438503, 5);
  });
});

// ---------------------------------------------------------------------------
// transformArmBody — every arm
// ---------------------------------------------------------------------------

describe("transformArmBody", () => {
  /** A representative Asmodeus-shaped production body, as `featherless-wire.test.ts` pins it. */
  function productionBody(): Record<string, unknown> {
    return {
      model: "DarkArtsForge/Asmodeus-24B-v3",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 1,
      top_p: 1,
      top_k: 100,
      min_p: 0.1,
      repetition_penalty: 1.08,
      presence_penalty: 0,
      max_tokens: 1_024,
    };
  }

  it("profile: sends the production body unmodified", () => {
    const body = productionBody();
    expect(transformArmBody("profile", body, 0.85)).toEqual(body);
  });

  it("profile-uncapped: removes only max_tokens", () => {
    const result = transformArmBody("profile-uncapped", productionBody(), 0.85);
    expect(result).not.toHaveProperty("max_tokens");
    const expected = productionBody();
    delete expected.max_tokens;
    expect(result).toEqual(expected);
  });

  it("lane: keeps only messages/model/stream/stream_options plus the lane temperature, and no max_tokens", () => {
    const result = transformArmBody("lane", productionBody(), 0.85);
    expect(result).toEqual({
      model: "DarkArtsForge/Asmodeus-24B-v3",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.85,
    });
    expect(result).not.toHaveProperty("max_tokens");
    expect(result).not.toHaveProperty("top_p");
    expect(result).not.toHaveProperty("repetition_penalty");
  });

  it("lane omits stream_options when the captured body never carried one", () => {
    const body = productionBody();
    delete body.stream_options;
    const result = transformArmBody("lane", body, 0.85);
    expect(result).not.toHaveProperty("stream_options");
  });

  it("lane-capped: is `lane` plus max_tokens READ FROM the captured body, not hard-coded", () => {
    const body = productionBody();
    body.max_tokens = 777; // an arbitrary cap, to prove it is read rather than a literal 1024
    const result = transformArmBody("lane-capped", body, 0.85);
    expect(result).toEqual({
      model: "DarkArtsForge/Asmodeus-24B-v3",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.85,
      max_tokens: 777,
    });
  });

  it("lane-capped: sends no max_tokens when the captured body carried none", () => {
    const body = productionBody();
    delete body.max_tokens;
    const result = transformArmBody("lane-capped", body, 0.85);
    expect(result).not.toHaveProperty("max_tokens");
  });

  it("direct-stream: replays the captured profile body unmodified", () => {
    const body = productionBody();
    expect(transformArmBody("direct-stream", body, 0.85)).toEqual(body);
  });

  it("direct-json: sets stream:false and drops stream_options, keeping every sampler field", () => {
    const result = transformArmBody("direct-json", productionBody(), 0.85);
    expect(result.stream).toBe(false);
    expect(result).not.toHaveProperty("stream_options");
    expect(result.max_tokens).toBe(1_024);
    expect(result.top_p).toBe(1);
  });

  it("defaults narrativeTemperature to NARRATIVE_TEMPERATURE when the caller omits it", () => {
    // Every other case in this file passes the temperature explicitly to prove the
    // transform plumbs through WHATEVER value it is given; this one instead proves the
    // documented default parameter itself -- production's one caller (`probe.ts`) always
    // passes it explicitly, so a drifted default would break only a future direct call,
    // silently, with nothing else here to catch it.
    const result = transformArmBody("lane", productionBody());
    expect(result.temperature).toBe(NARRATIVE_TEMPERATURE);
  });
});

// ---------------------------------------------------------------------------
// sanitizeHeaders
// ---------------------------------------------------------------------------

describe("sanitizeHeaders", () => {
  it("lists every header name, but only prints values for the allowlisted names", () => {
    const result = sanitizeHeaders([
      ["Content-Type", "application/json"],
      ["X-Request-Id", "req_abc123"],
      ["CF-Ray", "8c1f0-DFW"],
      ["Server", "cloudflare"],
      ["Set-Cookie", "session=abc; HttpOnly"],
    ]);
    expect(result.names).toEqual(["cf-ray", "content-type", "server", "set-cookie", "x-request-id"]);
    expect(result.values).toEqual({
      "x-request-id": "req_abc123",
      "cf-ray": "8c1f0-DFW",
      server: "cloudflare",
    });
    expect(result.values).not.toHaveProperty("set-cookie");
    expect(result.values).not.toHaveProperty("content-type");
  });

  it("never prints an Authorization value even if it were somehow echoed back", () => {
    const result = sanitizeHeaders([["Authorization", "Bearer sk-live-should-never-appear"]]);
    expect(result.names).toEqual(["authorization"]);
    expect(result.values).toEqual({});
  });

  it("drops anything key- or secret-shaped even when it also looks like a routing header", () => {
    const result = sanitizeHeaders([["X-Api-Key-Server", "sk-should-not-print"]]);
    expect(result.values).toEqual({});
  });

  it("drops (never truncates) an allowlisted value longer than 120 characters", () => {
    const long = "x".repeat(200);
    const result = sanitizeHeaders([["X-Worker-Region", long]]);
    expect(result.names).toEqual(["x-worker-region"]);
    expect(result.values).not.toHaveProperty("x-worker-region");
  });

  it("keeps an allowlisted value at exactly 120 characters", () => {
    const exact = "x".repeat(120);
    const result = sanitizeHeaders([["X-Worker-Region", exact]]);
    expect(result.values["x-worker-region"]).toBe(exact);
  });

  it("excludes server-timing by name even though it contains \"server\"", () => {
    const result = sanitizeHeaders([["Server-Timing", "db;dur=53, app;dur=47.2"]]);
    expect(result.names).toEqual(["server-timing"]);
    expect(result.values).not.toHaveProperty("server-timing");
  });
});

// ---------------------------------------------------------------------------
// The SSE accumulator
// ---------------------------------------------------------------------------

describe("createSseAccumulator", () => {
  it("parses one whole frame per push", () => {
    const acc = createSseAccumulator();
    const events = acc.push(
      'data: {"id":"cmpl-1","model":"m","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.hasContent).toBe(true);
    expect(events[0]?.contentChars).toBe(2);
    expect(events[0]?.meta.id).toBe("cmpl-1");
  });

  it("survives a chunk boundary landing INSIDE a frame, including mid-string", () => {
    const acc = createSseAccumulator();
    // The content string "Hello" is split across two chunks, and the frame's
    // closing "\n\n" arrives only in the second chunk.
    const first = acc.push('data: {"choices":[{"delta":{"content":"Hel');
    expect(first).toHaveLength(0); // nothing to parse yet — no blank-line boundary seen
    const second = acc.push('lo"},"finish_reason":null}]}\n\n');
    expect(second).toHaveLength(1);
    expect(second[0]?.contentChars).toBe(5);
  });

  it("parses [DONE] as a done sentinel, not a JSON parse failure", () => {
    const acc = createSseAccumulator();
    const events = acc.push("data: [DONE]\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.done).toBe(true);
    expect(events[0]?.hasContent).toBe(false);
  });

  it("splits [DONE] itself across a chunk boundary and still parses it", () => {
    const acc = createSseAccumulator();
    acc.push("data: [DO");
    const events = acc.push("NE]\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.done).toBe(true);
  });

  it("carries the terminal finish_reason and usage on the last event, over several chunks", () => {
    const acc = createSseAccumulator();
    acc.push('data: {"choices":[{"delta":{"content":"She"},"finish_reason":null}]}\n\n');
    acc.push('data: {"choices":[{"delta":{"content":" waits."},"finish_reason":null}]}\n\n');
    acc.push(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":34,"completion_tokens":32}}\n\n',
    );
    acc.push("data: [DONE]\n\n");
    const summary = summarizeSseEvents(acc.all());
    expect(summary.contentEventCount).toBe(2);
    expect(summary.totalContentChars).toBe("She".length + " waits.".length);
    expect(summary.finishReason).toBe("stop");
    expect(summary.usage).toEqual({ promptTokens: 34, completionTokens: 32 });
  });

  it("flush() recovers a final frame that never got its trailing blank line", () => {
    const acc = createSseAccumulator();
    acc.push('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}');
    expect(acc.all()).toHaveLength(0);
    const flushed = acc.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.finishReason).toBe("stop");
  });

  it("normalises a CRLF frame boundary (\\r\\n\\r\\n) the same way as LF", () => {
    const acc = createSseAccumulator();
    const first = acc.push('data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\r\n\r\n');
    expect(first).toHaveLength(1);
    expect(first[0]?.hasContent).toBe(true);
    expect(first[0]?.contentChars).toBe(2);
    // A second event over a second CRLF-terminated frame, to prove the boundary
    // itself (not just an internal \r) is recognized.
    const second = acc.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n');
    expect(second).toHaveLength(1);
    expect(second[0]?.finishReason).toBe("stop");
  });

  it("normalises a bare CR line ending the same way", () => {
    const acc = createSseAccumulator();
    const events = acc.push('data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\r\r');
    expect(events).toHaveLength(1);
    expect(events[0]?.contentChars).toBe(2);
    expect(events[0]?.finishReason).toBe("stop");
  });
});

describe("summarizeJsonCompletion", () => {
  it("reads content length, finish reason and usage off a non-streaming body", () => {
    const body = JSON.stringify({
      id: "cmpl-test",
      model: "m",
      created: 1_760_000_000,
      choices: [{ index: 0, message: { role: "assistant", content: "She waits." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 34, completion_tokens: 32 },
    });
    const summary = summarizeJsonCompletion(body);
    expect(summary).not.toBeNull();
    expect(summary?.totalContentChars).toBe("She waits.".length);
    expect(summary?.finishReason).toBe("stop");
    expect(summary?.usage).toEqual({ promptTokens: 34, completionTokens: 32 });
    expect(summary?.meta.id).toBe("cmpl-test");
  });

  it("returns null for an unparseable body rather than throwing", () => {
    expect(summarizeJsonCompletion("not json")).toBeNull();
  });

  it("counts message.reasoning_content the same way the SSE path counts a reasoning delta", () => {
    const body = JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content: "", reasoning_content: "thinking…" }, finish_reason: "length" }],
    });
    const summary = summarizeJsonCompletion(body);
    expect(summary?.contentEventCount).toBe(1);
    expect(summary?.totalContentChars).toBe("thinking…".length);
  });
});

// ---------------------------------------------------------------------------
// rawLengthStub
// ---------------------------------------------------------------------------

describe("rawLengthStub", () => {
  it("is true for the pathological one-token length stub", () => {
    expect(
      rawLengthStub({ finishReason: "length", completionTokens: 1, contentChars: 1, maxTokens: 1_024 }),
    ).toBe(true);
  });

  it("is true when the host reported no completion count at all, but exactly one raw character arrived", () => {
    expect(
      rawLengthStub({ finishReason: "length", completionTokens: undefined, contentChars: 1, maxTokens: undefined }),
    ).toBe(true);
  });

  it("is false for a one-character reply that ends normally on stop", () => {
    expect(rawLengthStub({ finishReason: "stop", completionTokens: 1, contentChars: 1, maxTokens: 1_024 })).toBe(
      false,
    );
  });

  it("is false when the request deliberately capped generation at one token", () => {
    expect(rawLengthStub({ finishReason: "length", completionTokens: 1, contentChars: 1, maxTokens: 1 })).toBe(
      false,
    );
  });

  it("is false for a real reply that legitimately ran into a larger cap", () => {
    expect(
      rawLengthStub({ finishReason: "length", completionTokens: 512, contentChars: 2_000, maxTokens: 512 }),
    ).toBe(false);
  });

  it("believes the raw content over a suspicious zero count when they contradict", () => {
    // A long reply whose SDK usage conversion reported 0 completion tokens must not be
    // called a stub on the strength of that zero alone.
    expect(
      rawLengthStub({ finishReason: "length", completionTokens: 0, contentChars: 500, maxTokens: 1_024 }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rawLengthStub vs isNarratorLengthStub — a parity table
// ---------------------------------------------------------------------------

describe("rawLengthStub mirrors isNarratorLengthStub", () => {
  /** The minimum a `NarratorCompletion` needs beyond the fields each case varies. */
  function completion(overrides: Partial<NarratorCompletion> = {}): NarratorCompletion {
    return {
      provider: "featherless",
      modelId: "DarkArtsForge/Asmodeus-24B-v3",
      finishReason: "length",
      rawTextLength: 1,
      visibleTextLength: 1,
      visibleTextChars: 1,
      attempts: 1,
      ...overrides,
    };
  }

  const cases: {
    name: string;
    completion: NarratorCompletion;
    raw: Parameters<typeof rawLengthStub>[0];
    expected: boolean;
  }[] = [
    {
      name: "the pathological one-token length stub",
      completion: completion({ outputTokens: 1, maxOutputTokens: 1_024 }),
      raw: { finishReason: "length", completionTokens: 1, contentChars: 1, maxTokens: 1_024 },
      expected: true,
    },
    {
      name: "a one-character stop reply",
      completion: completion({ finishReason: "stop", outputTokens: 1, maxOutputTokens: 1_024 }),
      raw: { finishReason: "stop", completionTokens: 1, contentChars: 1, maxTokens: 1_024 },
      expected: false,
    },
    {
      name: "a deliberate one-token budget",
      completion: completion({ outputTokens: 1, maxOutputTokens: 1 }),
      raw: { finishReason: "length", completionTokens: 1, contentChars: 1, maxTokens: 1 },
      expected: false,
    },
    {
      name: "a missing count with 1 raw char",
      completion: completion({ rawTextLength: 1, maxOutputTokens: 1_024 }),
      raw: { finishReason: "length", completionTokens: undefined, contentChars: 1, maxTokens: 1_024 },
      expected: true,
    },
    {
      name: "a missing count with 7 raw chars",
      completion: completion({ rawTextLength: 7, maxOutputTokens: 1_024 }),
      raw: { finishReason: "length", completionTokens: undefined, contentChars: 7, maxTokens: 1_024 },
      expected: false,
    },
    {
      name: "a count of 0 with 40 raw chars (the SDK's missing-usage zero, contradicted by real text)",
      completion: completion({ outputTokens: 0, rawTextLength: 40, maxOutputTokens: 1_024 }),
      raw: { finishReason: "length", completionTokens: 0, contentChars: 40, maxTokens: 1_024 },
      expected: false,
    },
    {
      name: "a long reply that legitimately ran into its cap",
      completion: completion({ outputTokens: 512, rawTextLength: 2_000, maxOutputTokens: 512 }),
      raw: { finishReason: "length", completionTokens: 512, contentChars: 2_000, maxTokens: 512 },
      expected: false,
    },
  ];

  it.each(cases)("$name: both verdicts are $expected", ({ completion: c, raw, expected }) => {
    expect(isNarratorLengthStub(c)).toBe(expected);
    expect(rawLengthStub(raw)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// buildProbeSummary
// ---------------------------------------------------------------------------

describe("buildProbeSummary", () => {
  function defaultRaw(): NonNullable<ProbeCallRecord["raw"]> {
    return {
      status: 200,
      headers: { names: [], values: {} },
      meta: {},
      finishReason: "stop",
      promptTokens: 10,
      completionTokens: 20,
      contentChars: 40,
      contentEventCount: 5,
      firstByteMs: 50,
      firstContentMs: 60,
      stub: false,
    };
  }

  function defaultVisible(): NonNullable<ProbeCallRecord["visible"]> {
    return {
      finishReason: "stop",
      rawFinishReason: "stop",
      ttftMs: 70,
      rawTextLength: 40,
      visibleTextLength: 40,
      visibleTextChars: 40,
      inputTokens: 10,
      outputTokens: 20,
      textTokens: 20,
      reasoningTokens: null,
      maxOutputTokens: 1_024,
      attempts: 1,
      providerError: null,
      stub: false,
    };
  }

  function productionRow(overrides: Partial<ProbeCallRecord> = {}): ProbeCallRecord {
    return {
      arm: "profile",
      probeCase: "tiny",
      kind: "call",
      round: 1,
      position: 1,
      positionInRound: 1,
      startedAt: new Date(0).toISOString(),
      totalMs: 100,
      requestStartOffsetMs: 0,
      requestMaxTokens: 1_024,
      // Matches `defaultRaw()`'s promptTokens/completionTokens by default, as if
      // the row's one request priced cleanly — override explicitly to model a
      // multi-request (hidden-retry) or unpriced row.
      billedPromptTokens: 10,
      billedCompletionTokens: 20,
      unpricedRequests: 0,
      errored: false,
      timedOut: false,
      requestCount: 1,
      raw: defaultRaw(),
      visible: defaultVisible(),
      ...overrides,
    };
  }

  it("counts n, stub rate and its Wilson interval per arm x case cell", () => {
    const rows = [
      productionRow({ position: 1 }),
      productionRow({
        position: 2,
        raw: { ...defaultRaw(), stub: true },
        visible: { ...defaultVisible(), stub: true, finishReason: "length" },
      }),
      productionRow({ position: 3 }),
    ];
    const summary = buildProbeSummary(rows);
    expect(summary.cells).toHaveLength(1);
    const cell = summary.cells[0];
    expect(cell?.n).toBe(3);
    expect(cell?.stub.count).toBe(1);
    expect(cell?.stub.rate).toBeCloseTo(1 / 3, 6);
    expect(cell?.finishReasonTally).toEqual({ stop: 2, length: 1 });
  });

  it("cross-tabs the raw verdict against the completion verdict, and counts their disagreements", () => {
    const agree = productionRow();
    const rawOnly = productionRow({ position: 2, raw: { ...defaultRaw(), stub: true } });
    const completionOnly = productionRow({
      position: 3,
      visible: { ...defaultVisible(), stub: true, finishReason: "length" },
    });
    const summary = buildProbeSummary([agree, rawOnly, completionOnly]);
    expect(summary.stubCrossTab).toEqual({
      bothStub: 0,
      rawOnlyStub: 1,
      completionOnlyStub: 1,
      neitherStub: 1,
      disagreements: 2,
    });
  });

  it("sums BILLED prompt/completion tokens per arm across every row", () => {
    const rows = [productionRow(), productionRow({ position: 2, probeCase: "vesper-sized" })];
    const summary = buildProbeSummary(rows);
    expect(summary.tokenTotalsByArm.profile).toEqual({ promptTokens: 20, completionTokens: 40, unpricedRequests: 0 });
  });

  it("sums a TWO-REQUEST row's billed usage (both requests), not just the last one's raw values", () => {
    // A hidden-retry call: two underlying requests, 800+200=1000 prompt tokens and
    // 5+15=20 completion tokens billed in total, while `raw` (the last request
    // alone) reports only the second request's own smaller numbers — the stub and
    // timing verdicts still read `raw`, but the token total must read the sum.
    const retried = productionRow({
      requestCount: 2,
      billedPromptTokens: 1_000,
      billedCompletionTokens: 20,
      raw: { ...defaultRaw(), promptTokens: 200, completionTokens: 15 },
    });
    const summary = buildProbeSummary([retried]);
    expect(summary.tokenTotalsByArm.profile).toEqual({ promptTokens: 1_000, completionTokens: 20, unpricedRequests: 0 });
    expect(summary.tokenTotalsGrand).toEqual({ promptTokens: 1_000, completionTokens: 20, unpricedRequests: 0 });
    expect(summary.cells[0]?.promptTokensTotal).toBe(1_000);
    expect(summary.cells[0]?.completionTokensTotal).toBe(20);
  });

  it("contributes 0 (not a thrown error) and flags unpricedRequests when a row could not be priced", () => {
    const unpriced = productionRow({
      position: 2,
      billedPromptTokens: null,
      billedCompletionTokens: null,
      unpricedRequests: 1,
    });
    const summary = buildProbeSummary([productionRow(), unpriced]);
    // Only the priced row's 10/20 reach the total; the unpriced row contributes 0
    // and is named instead.
    expect(summary.tokenTotalsByArm.profile).toEqual({ promptTokens: 10, completionTokens: 20, unpricedRequests: 1 });
    expect(summary.cells[0]?.unpricedRequests).toBe(1);
  });

  it("treats a direct-arm row (no `visible`) by its raw-wire verdict alone", () => {
    const row = productionRow({ arm: "direct-json", visible: null, raw: { ...defaultRaw(), stub: true } });
    const summary = buildProbeSummary([row]);
    expect(summary.cells[0]?.stub.count).toBe(1);
    // A row with no completion has nothing to cross-tab against.
    expect(summary.stubCrossTab).toEqual({
      bothStub: 0,
      rawOnlyStub: 0,
      completionOnlyStub: 0,
      neitherStub: 0,
      disagreements: 0,
    });
  });

  // ---------------------------------------------------------------------------
  // Failed rows: excluded from the stub denominator
  // and from the latency stats, counted separately.
  // ---------------------------------------------------------------------------

  it("excludes a thrown/errored row from both the stub denominator and the latency stats", () => {
    const clean = productionRow();
    const thrown = productionRow({ position: 2, errored: true, errorMessage: "boom", raw: { ...defaultRaw(), stub: true } });
    const summary = buildProbeSummary([clean, thrown]);
    const cell = summary.cells[0];
    expect(cell?.n).toBe(2);
    expect(cell?.failed).toBe(1);
    // The stub denominator is n - failed = 1, and the thrown row's own (otherwise
    // stub-shaped) raw verdict never enters the count.
    expect(cell?.stub.count).toBe(0);
    expect(cell?.stub.rate).toBe(0);
    expect(cell?.rawFirstContentMs.count).toBe(1);
    expect(cell?.visibleFirstMs.count).toBe(1);
    expect(cell?.totalMs.count).toBe(1);
  });

  it("treats an HTTP status >= 400 as failed even when nothing threw", () => {
    const clean = productionRow();
    const httpFailure = productionRow({ position: 2, raw: { ...defaultRaw(), status: 503 } });
    const summary = buildProbeSummary([clean, httpFailure]);
    expect(summary.cells[0]?.failed).toBe(1);
    expect(summary.cells[0]?.n).toBe(2);
  });

  it("treats a finish of \"error\" as failed even when nothing threw and status is 200", () => {
    const clean = productionRow();
    const providerFailure = productionRow({
      position: 2,
      visible: { ...defaultVisible(), finishReason: "error" },
    });
    const summary = buildProbeSummary([clean, providerFailure]);
    expect(summary.cells[0]?.failed).toBe(1);
    // Failed rows still contribute to the finish-reason tally — it is evidence too.
    expect(summary.cells[0]?.finishReasonTally).toEqual({ stop: 1, error: 1 });
  });

  it("returns null latency stats (not zero) for a cell whose every row failed", () => {
    const allFailed = [productionRow({ errored: true, errorMessage: "boom" })];
    const summary = buildProbeSummary(allFailed);
    const cell = summary.cells[0];
    expect(cell?.failed).toBe(1);
    expect(cell?.rawFirstContentMs).toEqual({ count: 0, p50: null, p90: null, max: null });
    expect(cell?.stub).toEqual({ count: 0, rate: 0, wilson95: { low: 0, high: 0 } });
  });

  // ---------------------------------------------------------------------------
  // `kind`: only "call" rows enter the grid: token
  // totals still cover every kind.
  // ---------------------------------------------------------------------------

  it("excludes non-\"call\" kinds from the grid cells but still counts their tokens", () => {
    const gridRow = productionRow();
    const bootstrapRow = productionRow({
      kind: "bootstrap-call",
      round: 0,
      position: 0,
      positionInRound: 0,
      billedPromptTokens: 1_000,
      billedCompletionTokens: 5,
    });
    const summary = buildProbeSummary([gridRow, bootstrapRow]);
    expect(summary.cells).toHaveLength(1);
    expect(summary.cells[0]?.n).toBe(1);
    expect(summary.tokenTotalsByArm.profile).toEqual({ promptTokens: 1_010, completionTokens: 25, unpricedRequests: 0 });
    expect(summary.tokenTotalsByKind).toEqual({
      call: { promptTokens: 10, completionTokens: 20, unpricedRequests: 0 },
      "bootstrap-call": { promptTokens: 1_000, completionTokens: 5, unpricedRequests: 0 },
    });
    expect(summary.tokenTotalsGrand).toEqual({ promptTokens: 1_010, completionTokens: 25, unpricedRequests: 0 });
  });
});

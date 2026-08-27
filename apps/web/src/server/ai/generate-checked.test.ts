import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The gateway's SPEND accounting needs a call to measure, so this suite scripts
 * `generateText` response by response and takes the module out of demo mode
 * (`src/test/setup.ts` forces `AI_FAKE=1` for everything else). `../events` is
 * mocked because the degrade path records its failure fire-and-forget and a pure
 * suite has no database.
 */
const model = vi.hoisted(() => ({
  /** One scripted response per call, consumed in order. */
  script: [] as { text: string; usage?: Record<string, unknown>; providerMetadata?: unknown }[],
  /** The request options each call was actually made with. */
  requests: [] as Record<string, unknown>[],
}));

vi.mock("../events", () => ({ logEvent: () => Promise.resolve() }));

vi.mock("./provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider")>();
  return {
    ...actual,
    isDemoMode: () => false,
    openrouter: () => ({ chat: (id: string) => ({ modelId: id }) }),
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: (options: Record<string, unknown>) => {
      model.requests.push(options);
      const next = model.script.shift();
      if (next === undefined) throw new Error("generateText was called more times than the script allows");
      return Promise.resolve({
        text: next.text,
        usage: next.usage ?? {},
        providerMetadata: next.providerMetadata,
      });
    },
  };
});

import { extractJsonObject, generateChecked } from "./generate-checked";

// The text-mode parse seam: provider-side constrained decoding degenerated on
// some models, so generateChecked now reads plain text and extracts the object
// itself.
describe("extractJsonObject", () => {
  it("passes a bare JSON object through", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("strips markdown fences and surrounding prose", () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```\nHope that helps!')).toBe('{"a":1}');
  });

  it("keeps nested objects and braces inside strings intact", () => {
    const obj = '{"a":{"b":"{not a brace pair}"},"c":[{"d":2}]}';
    expect(extractJsonObject("```\n" + obj + "\n```")).toBe(obj);
    expect(JSON.parse(extractJsonObject(obj))).toEqual({ a: { b: "{not a brace pair}" }, c: [{ d: 2 }] });
  });

  it("throws (into the repair ladder) when no object is present", () => {
    expect(() => extractJsonObject("I cannot help with that.")).toThrow("no JSON object");
    expect(() => extractJsonObject("")).toThrow("no JSON object");
  });
});

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------

const SCHEMA = z.object({ ok: z.boolean() });

/** The base call: an explicit model id so provider routing adds no knobs of its own. */
function call(overrides: { usageAccounting?: boolean; repair?: boolean } = {}) {
  return generateChecked({
    schema: SCHEMA,
    system: "system",
    prompt: "prompt",
    modelId: "probe/model",
    code: "probe",
    ...overrides,
  });
}

/** OpenRouter's usage-accounting block as it arrives in `providerMetadata`. */
function accounting(cost: unknown): unknown {
  return { openrouter: { usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cost } } };
}

beforeEach(() => {
  model.script = [];
  model.requests = [];
});

describe("generateChecked — the usage-accounting request knob", () => {
  it("asks OpenRouter to price the call when the caller wants it priced", async () => {
    model.script.push({ text: '{"ok":true}' });
    await call({ usageAccounting: true });
    expect(model.requests[0]?.providerOptions).toEqual({ openrouter: { usage: { include: true } } });
  });

  it("sends nothing at all without the flag — an existing caller's request is byte-identical", async () => {
    model.script.push({ text: '{"ok":true}' });
    await call();
    expect(model.requests[0]?.providerOptions).toBeUndefined();
  });
});

describe("generateChecked — what the call spent", () => {
  it("reports the tokens the provider reported", async () => {
    model.script.push({ text: '{"ok":true}', usage: { inputTokens: 1_240, outputTokens: 38 } });
    const result = await call({ usageAccounting: true });
    expect(result.value).toEqual({ ok: true });
    expect(result.usage).toEqual({ inputTokens: 1_240, outputTokens: 38 });
  });

  it("SUMS both attempts — the repair round-trip is a second call, not a free retry", async () => {
    model.script.push({ text: "no object here", usage: { inputTokens: 100, outputTokens: 10 } });
    model.script.push({ text: '{"ok":true}', usage: { inputTokens: 140, outputTokens: 12 } });
    const result = await call({ usageAccounting: true, repair: true });
    expect(result.value).toEqual({ ok: true });
    expect(result.degraded).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 240, outputTokens: 22 });
  });

  it("keeps the spend of a call that completed and THEN failed the parse — it was still paid for", async () => {
    model.script.push({ text: "no object here", usage: { inputTokens: 90, outputTokens: 3 } });
    const result = await call({ usageAccounting: true, repair: false });
    expect(result.degraded).toBe(true);
    expect(result.value).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 90, outputTokens: 3 });
  });

  it("leaves the spend UNDEFINED when nothing reported it — unknown is not zero", async () => {
    model.script.push({ text: '{"ok":true}' });
    const result = await call({ usageAccounting: true });
    expect(result.usage).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
  });

  it("reads the cost out of the accounting block, summed across completed calls", async () => {
    model.script.push({ text: "no object here", usage: { inputTokens: 1, outputTokens: 1 }, providerMetadata: accounting(0.0002) });
    model.script.push({ text: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 }, providerMetadata: accounting(0.0003) });
    const result = await call({ usageAccounting: true, repair: true });
    expect(result.costUsd).toBeCloseTo(0.0005, 10);
  });

  it("degrades a metadata block it cannot narrow to no cost at all — never a throw", async () => {
    for (const providerMetadata of [
      undefined,
      {},
      { openrouter: {} },
      { openrouter: { usage: null } },
      { openrouter: { usage: [1, 2] } },
      { openrouter: { usage: "0.004" } },
      accounting("0.004"),
      accounting(undefined),
      accounting(Number.NaN),
      accounting(-1),
    ]) {
      model.script = [{ text: '{"ok":true}', usage: { inputTokens: 5, outputTokens: 1 }, providerMetadata }];
      const result = await call({ usageAccounting: true });
      expect(result.value).toEqual({ ok: true });
      expect(result.costUsd).toBeUndefined();
      // The token half is independent of the cost half — one unreadable block
      // must not cost the other measurement.
      expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 1 });
    }
  });
});

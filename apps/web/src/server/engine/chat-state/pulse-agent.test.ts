import { describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { makeProfile } from "@/server/test-support";
import type { GenerateCheckedOptions, GenerateCheckedResult } from "../../ai";

/** The telemetry object the pulse's own call actually handed to `withGenerateTimeout` (#637 correlation). */
const telemetrySeen = vi.hoisted(() => ({ last: undefined as { traceId?: string } | undefined }));

// Out of demo mode (the global `AI_FAKE=1` test setup would otherwise degrade
// before any telemetry is built at all) and with the model call stubbed to
// its OWN degraded-fallback shape — real, schema-shaped data the pulse
// already builds for its failure path — so these tests check only the
// telemetry object the pulse hands to `withGenerateTimeout`, never a real
// provider call or the `loadChatAgentReasoningProfile` DB read.
vi.mock("../../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai")>();
  return {
    ...actual,
    isDemoMode: () => false,
    loadChatAgentReasoningProfile: () => Promise.resolve("off" as const),
    generateChecked: <T,>(options: GenerateCheckedOptions<T>): Promise<GenerateCheckedResult<T>> =>
      Promise.resolve({ value: (options.fallback ? options.fallback() : ({} as T)), degraded: false }),
    withGenerateTimeout: <T,>(
      work: Promise<GenerateCheckedResult<T>>,
      _controller: AbortController,
      _timeoutMs: number,
      _timeoutCode: string,
      _sink: unknown,
      telemetry?: { traceId?: string },
    ): Promise<{ value: T | null; degraded: boolean }> => {
      telemetrySeen.last = telemetry;
      return work.then((result) => ({ value: result.value, degraded: result.degraded })).catch(() => ({ value: null, degraded: true }));
    },
  };
});

import {
  chatPulseWithIntimateSceneDiagnosisSchema,
  INTIMATE_SCENE_UNREADABLE_DIAGNOSTIC,
  reportIntimateSceneIfUnreadable,
  runChatPulse,
  type ChatPulseWithIntimateSceneDiagnosis,
} from "./pulse-agent";
import { seedChatState } from "./seed";

/**
 * `chatPulseSchema`'s own `.catch(null)` on `intimateScene` (correct resilience
 * for the persisted contract) makes an ABSENT value and a PRESENT-but-invalid
 * one indistinguishable — both silently become `null`. This local diagnosis
 * schema (used only by `runChatPulse`, ahead of the fix requested in review of
 * #301 acceptance item 3) tells the two apart via `intimateSceneUnreadable`
 * without changing the resolved `ChatPulse` shape or degrading any other field.
 */
describe("chatPulseWithIntimateSceneDiagnosisSchema", () => {
  const base = { playerAct: null, mindNote: "", feeling: null, sentPhoto: false };

  it("a genuinely absent intimateScene stays silent", () => {
    const parsed = chatPulseWithIntimateSceneDiagnosisSchema.parse(base);
    expect(parsed.intimateScene).toBeNull();
    expect(parsed.intimateSceneUnreadable).toBe(false);
  });

  it("an explicit null (a legal 'no scene' value) stays silent", () => {
    const parsed = chatPulseWithIntimateSceneDiagnosisSchema.parse({ ...base, intimateScene: null });
    expect(parsed.intimateScene).toBeNull();
    expect(parsed.intimateSceneUnreadable).toBe(false);
  });

  it("keeps a valid 'active'/'completed' value and stays silent", () => {
    expect(chatPulseWithIntimateSceneDiagnosisSchema.parse({ ...base, intimateScene: "active" })).toMatchObject({
      intimateScene: "active",
      intimateSceneUnreadable: false,
    });
    expect(chatPulseWithIntimateSceneDiagnosisSchema.parse({ ...base, intimateScene: "completed" })).toMatchObject({
      intimateScene: "completed",
      intimateSceneUnreadable: false,
    });
  });

  it("a PRESENT but invalid intimateScene resolves to null AND flags intimateSceneUnreadable — the case that was silent before", () => {
    const parsed = chatPulseWithIntimateSceneDiagnosisSchema.parse({ ...base, intimateScene: "workout" });
    expect(parsed.intimateScene).toBeNull();
    expect(parsed.intimateSceneUnreadable).toBe(true);
  });

  it("flags a wrong-typed intimateScene (a number, not a string) the same way", () => {
    const parsed = chatPulseWithIntimateSceneDiagnosisSchema.parse({ ...base, intimateScene: 1 });
    expect(parsed.intimateScene).toBeNull();
    expect(parsed.intimateSceneUnreadable).toBe(true);
  });

  it("every other pulse field keeps its own resilient parse, independent of intimateScene", () => {
    const parsed = chatPulseWithIntimateSceneDiagnosisSchema.parse({
      playerAct: "not-an-object", // malformed — self-heals to null, same as chatPulseSchema alone
      mindNote: "warmer now",
      feeling: null,
      sentPhoto: true,
      intimateScene: "workout", // simultaneously unreadable
    });
    expect(parsed.playerAct).toBeNull();
    expect(parsed.mindNote).toBe("warmer now");
    expect(parsed.sentPhoto).toBe(true);
    expect(parsed.intimateScene).toBeNull();
    expect(parsed.intimateSceneUnreadable).toBe(true);
  });
});

describe("reportIntimateSceneIfUnreadable — the pulse-boundary diagnostic (#301 acceptance item 3)", () => {
  const pulse = (intimateSceneUnreadable: boolean): ChatPulseWithIntimateSceneDiagnosis => ({
    playerAct: null,
    mindNote: "",
    feeling: null,
    sentPhoto: false,
    intimateScene: null,
    intimateSceneUnreadable,
  });

  it("pushes the named diagnostic when the raw value was present but failed its schema", () => {
    const sink = new DiagnosticCollector();
    reportIntimateSceneIfUnreadable(pulse(true), sink);
    expect(sink.items.some((d) => d.code === INTIMATE_SCENE_UNREADABLE_DIAGNOSTIC)).toBe(true);
  });

  it("stays silent for a genuinely absent/valid value (never a false alarm)", () => {
    const sink = new DiagnosticCollector();
    reportIntimateSceneIfUnreadable(pulse(false), sink);
    expect(sink.items).toHaveLength(0);
  });

  it("tolerates no sink at all", () => {
    expect(() => reportIntimateSceneIfUnreadable(pulse(true))).not.toThrow();
  });
});

describe("runChatPulse threads the caller's traceId into its telemetry (#637)", () => {
  it("hands the pulse's own call the caller's traceId", async () => {
    telemetrySeen.last = undefined;
    const state = seedChatState(makeProfile());
    await runChatPulse({
      state,
      profile: makeProfile(),
      characterName: "Mara",
      playerName: "Theo",
      exchange: { player: "hi", assistant: "[Mara] \"hi\"" },
      activeSocialCards: [],
      trace: { chatId: "chat-1", messageId: "msg-1", traceId: "trace-pulse-1" },
      clockMinutes: 0,
    });
    // Widening read: `telemetrySeen.last` was reset to the
    // literal `undefined` above, and TS's control-flow narrowing doesn't see
    // the mock's reassignment across the awaited call, so reading the
    // property directly here would (wrongly) type as `never` (#637 CI fix).
    const telemetry = telemetrySeen.last as { traceId?: string } | undefined;
    expect(telemetry?.traceId).toBe("trace-pulse-1");
  });

  it("leaves the telemetry traceId absent when the caller has none", async () => {
    telemetrySeen.last = undefined;
    const state = seedChatState(makeProfile());
    await runChatPulse({
      state,
      profile: makeProfile(),
      characterName: "Mara",
      playerName: "Theo",
      exchange: { player: "hi", assistant: "[Mara] \"hi\"" },
      activeSocialCards: [],
      trace: { chatId: "chat-1", messageId: "msg-1" },
      clockMinutes: 0,
    });
    const telemetry = telemetrySeen.last as { traceId?: string } | undefined;
    expect(telemetry?.traceId).toBeUndefined();
  });
});

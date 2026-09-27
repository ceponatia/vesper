import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  chatPulseWithIntimateSceneDiagnosisSchema,
  INTIMATE_SCENE_UNREADABLE_DIAGNOSTIC,
  reportIntimateSceneIfUnreadable,
  type ChatPulseWithIntimateSceneDiagnosis,
} from "./pulse-agent";

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

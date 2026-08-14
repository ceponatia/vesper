import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { narrativeModelId, sceneComposerModelId, toolModelId } from "../ai";
import { sceneSpecSchema } from "./prompts-scene-composer";

/**
 * The composer's model seam and its refusal fallback (scene-composition.plan.md slice 2,
 * owner ruling 2026-08-10).
 *
 * `generateChecked` is stubbed rather than reached: what is under test is the LADDER — which
 * model is asked first, what makes the second model be asked at all, and that the terminal
 * degrade is still the deterministic heuristic spec — none of which a network call would
 * make clearer, and all of which a network call would make flaky.
 */

const seam = vi.hoisted(() => ({
  calls: [] as Array<{ modelId?: string; hasFallback: boolean }>,
  results: [] as Array<{ value: unknown; degraded: boolean }>,
}));

vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return {
    ...actual,
    // The seam under test only exists outside demo mode — demo degrades every call by design.
    isDemoMode: () => false,
    generateChecked: (opts: { modelId?: string; fallback?: () => unknown }) => {
      seam.calls.push({ modelId: opts.modelId, hasFallback: typeof opts.fallback === "function" });
      return Promise.resolve(seam.results.shift() ?? { value: null, degraded: true });
    },
  };
});

const { composeSceneSpec } = await import("./scene");

const composed = (pose: string): unknown => sceneSpecSchema.parse({ focalCharacter: "Mira", pose });

const context = {
  present: [{ name: "Mira", wornVisible: [], posture: "curled in an armchair", activity: "reading" }],
};

beforeEach(() => {
  seam.calls.length = 0;
  seam.results.length = 0;
});

describe("sceneComposerModelId", () => {
  it("is the composer's own seam — not the tool default it used to ride", () => {
    expect(sceneComposerModelId()).toBe("aion-labs/aion-3.0");
    expect(sceneComposerModelId()).not.toBe(toolModelId());
  });

  it("differs from the approved refusal fallback, or the retry would be the same model twice", () => {
    expect(sceneComposerModelId()).not.toBe(narrativeModelId());
  });
});

describe("composeSceneSpec model ladder", () => {
  it("asks the composer model first, with no fallback, and stops there when it answers", async () => {
    const sink = new DiagnosticCollector();
    seam.results.push({ value: composed("standing at the window"), degraded: false });
    const plan = await composeSceneSpec({ ...context, sink });
    expect(seam.calls).toEqual([{ modelId: sceneComposerModelId(), hasFallback: false }]);
    expect(plan.focal?.action).toBe("standing at the window");
    expect(sink.items.map((item) => item.code)).not.toContain("images.scene_composer.model_fallback");
  });

  it("retries once on the narrative model when the composer model degrades, and says which two", async () => {
    const sink = new DiagnosticCollector();
    seam.results.push({ value: null, degraded: true });
    seam.results.push({ value: composed("half-turned toward the door"), degraded: false });
    const plan = await composeSceneSpec({ ...context, sink });
    expect(seam.calls).toEqual([
      { modelId: sceneComposerModelId(), hasFallback: false },
      // The retry carries the heuristic, so the ladder's last rung is deterministic.
      { modelId: narrativeModelId(), hasFallback: true },
    ]);
    expect(plan.focal?.action).toBe("half-turned toward the door");
    const fallback = sink.items.find((item) => item.code === "images.scene_composer.model_fallback");
    expect(fallback?.severity).toBe("info");
    expect(fallback?.context).toEqual({ primary: sceneComposerModelId(), fallback: narrativeModelId() });
  });

  it("treats a schema-defaulted answer as a degrade — an empty spec must not look like a composition", async () => {
    const sink = new DiagnosticCollector();
    seam.results.push({ value: sceneSpecSchema.parse({}), degraded: true });
    seam.results.push({ value: composed("kneeling by the hearth"), degraded: false });
    await composeSceneSpec({ ...context, sink });
    expect(seam.calls).toHaveLength(2);
  });

  it("lands on the deterministic heuristic when both models fail — never a failed render", async () => {
    const sink = new DiagnosticCollector();
    const plan = await composeSceneSpec({ ...context, sink });
    expect(seam.calls).toHaveLength(2);
    expect(plan.focal?.name).toBe("Mira");
    expect(plan.focal?.action).toBe("curled in an armchair; reading");
  });
});

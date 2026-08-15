import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { DEFAULT_SCENE_COMPOSER_MODEL_ID, SCENE_COMPOSER_MODELS } from "@/lib/composer-models";
import { composerFallbackModelId, narrativeModelId, sceneComposerModelId, toolModelId } from "../ai";
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

  it("honours a curated per-chat override — the whole point of the admin picker", () => {
    expect(sceneComposerModelId("~deepseek/deepseek-v4-flash-latest")).toBe("~deepseek/deepseek-v4-flash-latest");
  });

  it("treats absent / empty / whitespace as no override", () => {
    for (const value of [undefined, null, "", "   "]) {
      expect(sceneComposerModelId(value)).toBe(DEFAULT_SCENE_COMPOSER_MODEL_ID);
    }
  });

  it("REFUSES an uncurated id — this value reaches OpenRouter on the deployment's key", () => {
    expect(sceneComposerModelId("openai/o3-pro")).toBe(DEFAULT_SCENE_COMPOSER_MODEL_ID);
  });
});

describe("composerFallbackModelId", () => {
  it("is the narrator for the shipped default — a model already trusted with this text", () => {
    expect(composerFallbackModelId(DEFAULT_SCENE_COMPOSER_MODEL_ID)).toBe(narrativeModelId());
  });

  it("never returns the primary, for ANY curated composer — including the narrator itself", () => {
    // Aion 2.0 is both the session narrator and a curated composer option, so the naive
    // `narrativeModelId()` retry would have asked the refusing model a second time.
    for (const option of SCENE_COMPOSER_MODELS) {
      expect(composerFallbackModelId(option.id)).not.toBe(option.id);
    }
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

  it("asks the chat's overridden model, and keeps the two rungs distinct", async () => {
    seam.results.push({ value: null, degraded: true });
    seam.results.push({ value: composed("at the window"), degraded: false });
    // The narrator's own id as the override — the collision case the fallback rung exists for.
    await composeSceneSpec({ ...context, composerModel: narrativeModelId() });
    expect(seam.calls[0]?.modelId).toBe(narrativeModelId());
    expect(seam.calls[1]?.modelId).not.toBe(narrativeModelId());
  });

  it("degrades an uncurated override to the default rather than billing it", async () => {
    seam.results.push({ value: composed("at the window"), degraded: false });
    await composeSceneSpec({ ...context, composerModel: "some/unbilled-model" });
    expect(seam.calls).toEqual([{ modelId: sceneComposerModelId(), hasFallback: false }]);
  });
});

import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { sceneGenStateSchema } from "@/contracts/state/scene-gen";
import type { ProviderRenderResult, SceneAttemptId } from "@vesper/image-core";
import { composeSceneSpec, executeSceneChain, shouldGenerateScene } from "./scene";

describe("shouldGenerateScene", () => {
  const state = (overrides: Record<string, unknown>) => sceneGenStateSchema.parse(overrides);

  it("never fires when the interval is 0 (scenes off), even for director moments", () => {
    expect(shouldGenerateScene(state({ interval: 0 }), 10, true)).toBe(false);
  });

  it("never stacks onto an in-flight generation", () => {
    expect(shouldGenerateScene(state({ interval: 1, status: "generating" }), 10, true)).toBe(false);
  });

  it("fires on the director's imageMoment flag regardless of cadence", () => {
    expect(shouldGenerateScene(state({ interval: 10, lastGeneratedTurn: 9 }), 10, true)).toBe(true);
  });

  it("fires every N turns and not before", () => {
    const s = state({ interval: 5, lastGeneratedTurn: 10 });
    expect(shouldGenerateScene(s, 14, false)).toBe(false);
    expect(shouldGenerateScene(s, 15, false)).toBe(true);
    // never generated yet: due once `interval` turns have elapsed
    expect(shouldGenerateScene(state({ interval: 5 }), 5, false)).toBe(true);
    expect(shouldGenerateScene(state({ interval: 5 }), 4, false)).toBe(false);
  });
});

describe("composeSceneSpec (demo mode = degraded fallback path)", () => {
  it("builds a heuristic plan from the present roster with outfits forced from wardrobe state, and records the diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const plan = await composeSceneSpec({
      present: [
        {
          name: "Mira",
          activity: "reading",
          posture: "curled in an armchair",
          wornVisible: [
            { name: "linen shirt", visibility: "visible" },
            { name: "silk camisole", visibility: "hinted" },
          ],
        },
        {
          name: "Sayed",
          activity: "shelving books",
          wornVisible: [{ name: "wool coat", visibility: "visible" }],
        },
      ],
      locationName: "The Drowned Library",
      locationDescription: "Shelves sag under waterlogged tomes.",
      timeOfDay: "night",
      recentNarration: ["Sayed lit a lamp.", "Mira wore a ballgown of impossible gold."], // prose lies — must not reach the outfit
      sink,
    });
    expect(plan.focal?.name).toBe("Mira"); // mentioned in the newest narration
    expect(plan.focal?.outfitSummary).toBe("linen shirt; hints of silk camisole beneath");
    expect(plan.focal?.outfitSummary).not.toContain("ballgown");
    expect(plan.focal?.action).toBe("curled in an armchair; reading");
    expect(plan.others.map((o) => o.name)).toEqual(["Sayed"]);
    expect(plan.others[0]?.outfitSummary).toBe("wool coat");
    expect(plan.setting).toContain("The Drowned Library");
    expect(plan.lighting).toBe("dim night-time lighting"); // daylight band feeds the heuristic lighting
    expect(sink.items.some((d) => d.code === "images.scene_composer.degraded")).toBe(true);
  });

  it("an empty room degrades to a location-only plan — a legitimate output, with the diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const plan = await composeSceneSpec({
      present: [],
      locationName: "Atrium",
      locationDescription: "Glass and rain.",
      sink,
    });
    expect(plan.focal).toBeNull();
    expect(plan.others).toEqual([]);
    expect(plan.setting).toContain("Atrium");
    expect(sink.items.some((d) => d.code === "images.scene_composer.degraded")).toBe(true);
  });

  it("a present NPC with no wardrobe state keeps an empty outfit summary", async () => {
    const plan = await composeSceneSpec({ present: [{ name: "Mira", wornVisible: [] }] });
    expect(plan.focal?.name).toBe("Mira");
    expect(plan.focal?.outfitSummary).toBe("");
  });

  it("a free-text outfitDescription overrides the wardrobe summary (character chat — no equippable items)", async () => {
    const plan = await composeSceneSpec({
      present: [{ name: "Mira", wornVisible: [], outfitDescription: "a loose silk robe and bare feet" }],
    });
    expect(plan.focal?.outfitSummary).toBe("a loose silk robe and bare feet");
  });
});

const okResult = (): ProviderRenderResult => ({ ok: true, image: Buffer.from("img") });
const failResult = (
  reason: "transient" | "content_rejection" | "other",
  message: string = reason,
): ProviderRenderResult => ({
  ok: false,
  failure: { reason, message },
});

describe("executeSceneChain (degradation ladder + reason-keyed retry, spec §8.3)", () => {
  it("a content rejection never retries — it falls straight to the next rung with a diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const calls: SceneAttemptId[] = [];
    const run = async (id: SceneAttemptId): Promise<ProviderRenderResult> => {
      calls.push(id);
      return id === "edit" ? failResult("content_rejection", "Sexual Content") : okResult();
    };
    const outcome = await executeSceneChain(["edit", "generate"], run, sink);
    expect(outcome?.attemptId).toBe("generate");
    expect(calls).toEqual(["edit", "generate"]); // the edit rung tried exactly once (no retry)
    expect(
      sink.items.some((d) => d.code === "images.scene_render.provider_fallback" && d.context?.reason === "content_rejection"),
    ).toBe(true);
  });

  it("a transient failure retries once on the same provider before succeeding", async () => {
    const sink = new DiagnosticCollector();
    let editCalls = 0;
    const run = async (id: SceneAttemptId): Promise<ProviderRenderResult> => {
      if (id !== "edit") return okResult();
      editCalls += 1;
      return editCalls === 1 ? failResult("transient", "ETIMEDOUT") : okResult();
    };
    const outcome = await executeSceneChain(["edit", "generate"], run, sink);
    expect(outcome?.attemptId).toBe("edit");
    expect(editCalls).toBe(2);
    expect(sink.items.some((d) => d.code === "images.scene_render.retry")).toBe(true);
  });

  it("every rung failing transiently returns null and warns of a possible outage", async () => {
    const sink = new DiagnosticCollector();
    const outcome = await executeSceneChain(["edit", "generate"], async () => failResult("transient"), sink);
    expect(outcome).toBeNull();
    expect(sink.items.some((d) => d.code === "images.scene_render.service_outage" && d.severity === "warn")).toBe(true);
  });

  it("non-transient failures across the chain return null with an all_failed diagnostic, not an outage warning", async () => {
    const sink = new DiagnosticCollector();
    const outcome = await executeSceneChain(["edit", "generate"], async () => failResult("content_rejection"), sink);
    expect(outcome).toBeNull();
    expect(sink.items.some((d) => d.code === "images.scene_render.service_outage")).toBe(false);
    expect(sink.items.some((d) => d.code === "images.scene_render.all_failed" && d.severity === "warn")).toBe(true);
  });

  it("a single-rung identity-locked edit that content-rejects is never silent — it pushes all_failed with the cause", async () => {
    // Fail-visible character-chat path: routeSceneAttempts has already dropped
    // the bare-prompt rung (the model is edit-only, or a reference exists), so a
    // rejected edit has no fallback hop to log; the terminal diagnostic is the
    // only record of WHY the character image failed.
    const sink = new DiagnosticCollector();
    const outcome = await executeSceneChain(["edit"], async () => failResult("content_rejection", "Sexual Content"), sink);
    expect(outcome).toBeNull();
    const terminal = sink.items.find((d) => d.code === "images.scene_render.all_failed");
    expect(terminal?.message).toContain("Sexual Content");
    expect(terminal?.context?.reason).toBe("content_rejection");
  });
});

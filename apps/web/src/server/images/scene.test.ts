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
  predictionId?: string | null,
): ProviderRenderResult => ({
  ok: false,
  failure: { reason, message, ...(predictionId !== undefined ? { predictionId } : {}) },
});

describe("executeSceneChain (degradation ladder + reason-keyed retry)", () => {
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

  /**
   * PROTECTS (#685): a rung's FINAL failure that already declares provider
   * work on THIS attempt was paid for ends the chain outright — no fallback,
   * no provider_fallback diagnostic, and not the generic all_failed/
   * service_outage terminal — because a fallback would risk a second paid
   * render racing a workflow that may still be running or may still deliver.
   */
  it("an undelivered-output failure (civitai_output_undelivered; retry=reconcile) stops the chain on rung 1 of 3, with the workflow id on the paid-stop diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const calls: SceneAttemptId[] = [];
    const run = async (id: SceneAttemptId): Promise<ProviderRenderResult> => {
      calls.push(id);
      return failResult(
        "other",
        "Civitai output download failed (civitai_output_undelivered; retry=reconcile). The workflow succeeded and was already paid for, but its output could not be downloaded after 3 attempts. It can be recovered from that output without rendering again.",
        "wf-123",
      );
    };
    const outcome = await executeSceneChain(["multi_edit", "edit", "generate"], run, sink);
    expect(outcome).toBeNull();
    expect(calls).toEqual(["multi_edit"]); // run exactly once — edit and generate never tried
    const paidStop = sink.items.find((d) => d.code === "images.scene_render.paid_attempt_stop");
    expect(paidStop?.context).toMatchObject({ rung: "multi_edit", workflowId: "wf-123" });
    expect(sink.items.some((d) => d.code === "images.scene_render.provider_fallback")).toBe(false);
    expect(sink.items.some((d) => d.code === "images.scene_render.all_failed")).toBe(false);
    expect(sink.items.some((d) => d.code === "images.scene_render.service_outage")).toBe(false);
  });

  it("a civitai_submit_unconfirmed failure stops the chain with no known workflow id (workflowId null)", async () => {
    const sink = new DiagnosticCollector();
    const calls: SceneAttemptId[] = [];
    const run = async (id: SceneAttemptId): Promise<ProviderRenderResult> => {
      calls.push(id);
      return failResult(
        "other",
        "Civitai submit failed (civitai_submit_unconfirmed; retry=deliberate). The submit's own answer was lost as civitai_http_503, and no workflow in the list carried this externalId after 2 lookup rounds. Civitai may still accept, or may already have accepted, this workflow under externalId=abc-123 — check the workflow list for it before starting one deliberate replacement.",
        null,
      );
    };
    const outcome = await executeSceneChain(["edit", "generate"], run, sink);
    expect(outcome).toBeNull();
    expect(calls).toEqual(["edit"]);
    const paidStop = sink.items.find((d) => d.code === "images.scene_render.paid_attempt_stop");
    expect(paidStop?.context).toMatchObject({ rung: "edit", workflowId: null });
  });

  it("the post-submit catch-all's appended retry=reconcile sentence stops the chain the same way", async () => {
    const sink = new DiagnosticCollector();
    const run = async (): Promise<ProviderRenderResult> =>
      failResult(
        "other",
        "Civitai returned a different workflow while polling Civitai workflow wf-999 was already submitted (retry=reconcile). Refresh workflow status before deciding whether to replace it.",
        "wf-999",
      );
    const outcome = await executeSceneChain(["edit", "generate"], run, sink);
    expect(outcome).toBeNull();
    const paidStop = sink.items.find((d) => d.code === "images.scene_render.paid_attempt_stop");
    expect(paidStop?.context).toMatchObject({ rung: "edit", workflowId: "wf-999" });
  });

  it("Vesper's own poll deadline on a submitted workflow (civitai_async_timeout; retry=reconcile) stops the chain", async () => {
    // The workflow was billed and may still finish (#687 review): a fallback
    // here would pay for a second render racing the first.
    const sink = new DiagnosticCollector();
    const calls: SceneAttemptId[] = [];
    const run = async (id: SceneAttemptId): Promise<ProviderRenderResult> => {
      calls.push(id);
      return failResult(
        "other",
        "Civitai workflow status failed (civitai_async_timeout; retry=reconcile). Refresh workflow status before deciding whether to replace it.",
        "wf-slow",
      );
    };
    const outcome = await executeSceneChain(["multi_edit", "edit"], run, sink);
    expect(outcome).toBeNull();
    expect(calls).toEqual(["multi_edit"]);
    const paidStop = sink.items.find((d) => d.code === "images.scene_render.paid_attempt_stop");
    expect(paidStop?.context).toMatchObject({ rung: "multi_edit", workflowId: "wf-slow" });
  });

  it("a preflight retry=never refusal is not a paid stop — falls through to the next rung, unchanged", async () => {
    const sink = new DiagnosticCollector();
    const run = async (id: SceneAttemptId): Promise<ProviderRenderResult> =>
      id === "edit"
        ? failResult("other", "Civitai preflight failed (civitai_http_400; retry=never). Do not repeat this request with the same input.")
        : okResult();
    const outcome = await executeSceneChain(["edit", "generate"], run, sink);
    expect(outcome?.attemptId).toBe("generate");
    expect(sink.items.some((d) => d.code === "images.scene_render.paid_attempt_stop")).toBe(false);
    expect(sink.items.some((d) => d.code === "images.scene_render.provider_fallback")).toBe(true);
  });

  it("a preflight retry=deliberate refusal (the one automatic repeat already spent, nothing paid) is not a paid stop — falls through", async () => {
    const sink = new DiagnosticCollector();
    const run = async (id: SceneAttemptId): Promise<ProviderRenderResult> =>
      id === "edit"
        ? failResult(
            "other",
            "Civitai preflight failed (civitai_http_503; retry=deliberate). Vesper already reposted this preflight once automatically; that retry is spent, so start one deliberate replacement only after reviewing the request.",
          )
        : okResult();
    const outcome = await executeSceneChain(["edit", "generate"], run, sink);
    expect(outcome?.attemptId).toBe("generate");
    expect(sink.items.some((d) => d.code === "images.scene_render.paid_attempt_stop")).toBe(false);
  });
});

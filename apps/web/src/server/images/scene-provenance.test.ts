import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  imageReferencePolicySchema,
  parseImagePromptProgramProvenance,
  IMAGE_PROMPT_PROGRAM_META_KEY,
  type ResolvedImageAttempt,
  type ResolvedImageProfile,
  type SceneVisualReference,
} from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  identityProvenanceFixture as record,
  LANE_PROBE_IMAGE_ID,
  LANE_PROBE_NAME,
  LANE_PROBE_SECOND_IMAGE_ID,
  LANE_PROBE_SECOND_NAME,
  LANE_PROBE_SECOND_SUBJECT_ID,
  LANE_PROBE_THIRD_NAME,
  LANE_PROBE_THIRD_SUBJECT_ID,
  laneProbeCastSceneRender,
} from "@/server/test-support";

/**
 * `meta.identityReferences` honesty (identity packs 5B, codex review): the row
 * records provenance ONLY for identity references that actually reached the
 * provider. A refused render (failedPrecondition) records none — the row is
 * failed before anything is sent — and a capacity trim or a fallback rung drops
 * the entries whose bytes never travelled.
 *
 * Every case renders the probe's two-person scene over a REAL compiled program,
 * on an endpoint bound for the scene task: a rung that compiles no program is
 * dropped from the chain, so an unbound fixture would never reach the intent.
 * That also makes this the one end-to-end suite that reads a compiled scene
 * prompt beside the references its rung actually sent, which is where the
 * reference-payload invariant at the bottom lives.
 */

vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, isDemoMode: vi.fn(), classifyImageFailure: vi.fn() };
});
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});
vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>();
  return { ...actual, runImagePipeline: vi.fn() };
});
vi.mock("./render-intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-intent")>();
  return { ...actual, renderImageIntent: vi.fn() };
});
vi.mock("@/server/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logDiagnostics: vi.fn(),
}));

import { classifyImageFailure, isDemoMode } from "../ai";
import { db } from "../db";
import { runImagePipeline, type ImagePipelineOptions, type ImageProduceResult, type ImageRow } from "./assets";
import { renderImageIntent } from "./render-intent";
import { renderResolvedScene, type RenderResolvedSceneInput } from "./scene";

const mockPipeline = vi.mocked(runImagePipeline);
const mockIntent = vi.mocked(renderImageIntent);

const pipelineCalls: ImagePipelineOptions[] = [];
/** Each `db().select()...limit()` answers from here, in call order. */
const rowQueue: unknown[][] = [];
/** Every `db().update().set(payload)` lands here — the meta-correction writes. */
const updateCalls: Record<string, unknown>[] = [];

const MODEL_SLUG = "qwen/qwen-image-edit-2511";

/**
 * The bound scene endpoint — Qwen Edit 2511, a numbered-image dialect — as an
 * edit-capable model of the given reference capacity, so `multi_edit → edit` is
 * the real chain. The policy allows identity references and nothing else, which
 * is what lets planning drop a reference the lane offered.
 */
function sceneProfile(maxReferences: number): ResolvedImageProfile {
  return {
    model: imageModelSchema.parse({
      id: "mdl-2511",
      slug: MODEL_SLUG,
      label: "Qwen Image Edit 2511",
      canGenerate: false,
      canEdit: true,
      editKind: "instruction_edit",
      identityPreservation: "strong",
      referenceArity: "array",
      maxReferences,
    }),
    profile: imageModelProfileSchema.parse({
      id: "prf",
      imageModelId: "mdl-2511",
      key: "scene-standard",
      label: "scene",
      task: "scene",
      operation: "edit",
      promptStrategy: "instruction_edit",
      referencePolicy: imageReferencePolicySchema.parse({ requiredRoles: ["identity"] }),
    }),
  };
}

const profile = sceneProfile(2);

/** A third person's anchor — nobody in the cast, so it only ever competes for a slot. */
const strangerRef = (imageId: string): SceneVisualReference => ({
  kind: "character",
  name: "Wren",
  role: "other",
  allowForIntimate: true,
  imageId,
  source: "generated",
});

/** The place's anchor, behind the people the way the queue orders it. */
const placeRef = (imageId: string): SceneVisualReference => ({
  kind: "location",
  name: "the study",
  role: "location",
  allowForIntimate: true,
  imageId,
  source: "generated",
});

const baseInput = (overrides: Partial<RenderResolvedSceneInput>): RenderResolvedSceneInput => ({
  ...laneProbeCastSceneRender(),
  mode: "multi",
  profile,
  linkage: { ownerId: "user1" },
  logResult: vi.fn(),
  ...overrides,
});

/** The probe scene plus one more reference and its bytes. */
function withExtraReference(extra: SceneVisualReference, bytes: string): Partial<RenderResolvedSceneInput> {
  const scene = laneProbeCastSceneRender();
  return {
    references: [...scene.references, extra],
    referenceBuffers: new Map([...scene.referenceBuffers, [extra.imageId ?? "", Buffer.from(bytes)]]),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  pipelineCalls.length = 0;
  rowQueue.length = 0;
  updateCalls.length = 0;
  vi.mocked(isDemoMode).mockReturnValue(false);
  vi.mocked(classifyImageFailure).mockReturnValue("other");
  vi.mocked(db).mockImplementation(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rowQueue.shift() ?? []),
      insert: () => chain,
      values: () => Promise.resolve([]),
      update: () => chain,
      set: (payload: Record<string, unknown>) => {
        updateCalls.push(payload);
        return { where: () => Promise.resolve([]) };
      },
    };
    return chain as unknown as ReturnType<typeof db>;
  });
  // The reserve → precondition → produce shell, minus the database. afterReserve
  // is deliberately not invoked — reference-row writes are not under test here.
  mockPipeline.mockImplementation(async (opts) => {
    pipelineCalls.push(opts);
    if ((opts.failedPrecondition ?? null) !== null) return { imageId: "img1", status: "failed" };
    const produced = await opts.produce({ id: "img1" } as unknown as ImageRow);
    return { imageId: "img1", status: produced.ok ? "ready" : "failed" };
  });
});

describe("renderResolvedScene identity provenance", () => {
  it("a refused render (failedPrecondition) records NO identityReferences — nothing was sent", async () => {
    await renderResolvedScene(
      baseInput({
        identityProvenance: [record("canonical_identity", LANE_PROBE_IMAGE_ID)],
        failedPrecondition: "identity references unavailable for Ilsa",
      }),
    );
    expect(mockIntent).not.toHaveBeenCalled();
    const meta = pipelineCalls[0]?.asset.meta;
    expect(meta && "identityReferences" in meta).toBe(false);
  });

  it("the primary attempt's send set is what persists — a capacity-trimmed anchor's provenance is dropped", async () => {
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    await renderResolvedScene(
      baseInput({
        // Three anchors on a two-reference model: imgC never travels.
        ...withExtraReference(strangerRef("imgC"), "c"),
        identityProvenance: [record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID), record("canonical_identity", "imgC")],
      }),
    );
    const meta = pipelineCalls[0]?.asset.meta;
    expect(meta?.identityReferences).toEqual([record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID)]);
    expect(updateCalls).toHaveLength(0); // primary rung won — the reserve-time record stands
  });

  it("a fallback to the single-reference rung rewrites the row to what that rung actually sent", async () => {
    // multi_edit fails outright (non-transient), the edit rung succeeds sending
    // only the primary anchor — whose provenance is not pack-sourced here.
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom" })
      .mockResolvedValueOnce({ ok: true, image: Buffer.from("rendered") });
    rowQueue.push([
      { meta: { model: `replicate/${MODEL_SLUG}`, identityReferences: [record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID)] } },
    ]);

    await renderResolvedScene(
      baseInput({ identityProvenance: [record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID)] }),
    );
    // Reserved against the multi_edit plan: the second anchor was going to travel.
    expect(pipelineCalls[0]?.asset.meta?.identityReferences).toEqual([record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID)]);
    // The surviving edit rung sent the primary anchor alone, so the correction removes the claim.
    const corrected = updateCalls[0];
    expect(corrected).toBeDefined();
    const correctedMeta = corrected?.meta as Record<string, unknown>;
    expect("identityReferences" in correctedMeta).toBe(false);
  });

  it("an exhausted chain still records the LAST rung's attempt on the failed row", async () => {
    // The failure the row's error text describes is the last rung's — its
    // prediction id is what an operator traces, so the failed row keeps it.
    const attempt = (predictionId: string): ResolvedImageAttempt => ({
      modelId: "mdl-2511",
      modelSlug: MODEL_SLUG,
      profileId: "prf",
      task: "scene",
      promptStrategy: "instruction_edit",
      requestedVersionId: null,
      seed: null,
      appliedControls: {},
      droppedControls: [],
      sentReferenceRoles: ["identity"],
      predictionId,
      executedVersionId: null,
    });
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom", attempt: attempt("pred-multi") })
      .mockResolvedValueOnce({ ok: false, error: "edit boom", attempt: attempt("pred-edit") });
    // Capture what produce hands the pipeline — the failed row's meta channel.
    let produced: ImageProduceResult | undefined;
    mockPipeline.mockImplementation(async (opts) => {
      pipelineCalls.push(opts);
      produced = await opts.produce({ id: "img1" } as unknown as ImageRow);
      return { imageId: "img1", status: produced.ok ? "ready" : "failed" };
    });

    await renderResolvedScene(baseInput({}));
    expect(produced?.ok).toBe(false);
    // The deeper `edit` rung's attempt, not the primary `multi_edit` plan's.
    expect((produced?.meta?.render as ResolvedImageAttempt | undefined)?.predictionId).toBe("pred-edit");
  });

  /**
   * Codex P1 (PR #381), carried over to the cutover: the reserve-time row
   * records the PRIMARY rung's compiled program, and the fallback correction
   * rewrites the row to the winning rung — so it must replace that provenance
   * too. A row that kept the primary's `meta.promptProgram` beside the winning
   * rung's prompt would claim a world state and a program fingerprint that
   * describe a different render, which is exactly what provenance exists to
   * prevent. Pinned as: the corrected prompt differs from the reserved one, the
   * corrected row carries parseable program provenance, and the stale fragment
   * that was on the row did not survive the merge.
   *
   * It is also this file's end-to-end multi-subject scene (#256): a cast of two,
   * each realized from their own committed cut, folded into one digest and
   * compiled into one prompt. A seam that could only carry the focal would fail
   * here rather than silently describing one woman for a payload carrying two
   * faces.
   */
  it("a fallback correction replaces the reserve-time program provenance with the winning rung's", async () => {
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom" })
      .mockResolvedValueOnce({ ok: true, image: Buffer.from("rendered") });
    rowQueue.push([
      {
        meta: {
          model: `replicate/${MODEL_SLUG}`,
          [IMAGE_PROMPT_PROGRAM_META_KEY]: { stale: true },
        },
      },
    ]);

    await renderResolvedScene(baseInput({}));

    // Reserved beside the primary (multi_edit) rung's compiled prompt.
    const reservedPrompt = pipelineCalls[0]?.asset.prompt as string;
    expect(
      parseImagePromptProgramProvenance(pipelineCalls[0]?.asset.meta?.[IMAGE_PROMPT_PROGRAM_META_KEY]),
    ).not.toBeNull();
    // Both people are in the one prompt — the whole cast compiled, not the focal.
    expect(reservedPrompt).toContain(LANE_PROBE_NAME);
    expect(reservedPrompt).toContain(LANE_PROBE_SECOND_NAME);

    // The corrected row describes the WINNING rung: a different compiled prompt,
    // its own parseable provenance, and no trace of the stale fragment.
    const corrected = updateCalls[0];
    expect(corrected).toBeDefined();
    const correctedPrompt = corrected?.prompt as string;
    expect(correctedPrompt).not.toBe(reservedPrompt);
    const correctedMeta = corrected?.meta as Record<string, unknown>;
    const provenance = parseImagePromptProgramProvenance(correctedMeta[IMAGE_PROMPT_PROGRAM_META_KEY]);
    expect(provenance).not.toBeNull();
    expect(correctedMeta[IMAGE_PROMPT_PROGRAM_META_KEY]).not.toMatchObject({ stale: true });
  });

  it("a pack-sourced PRIMARY anchor keeps its provenance across the same fallback", async () => {
    mockIntent
      .mockResolvedValueOnce({ ok: false, error: "multi boom" })
      .mockResolvedValueOnce({ ok: true, image: Buffer.from("rendered") });
    rowQueue.push([{ meta: { model: `replicate/${MODEL_SLUG}` } }]);

    await renderResolvedScene(
      baseInput({
        identityProvenance: [
          record("canonical_identity", LANE_PROBE_IMAGE_ID),
          record("canonical_identity", LANE_PROBE_SECOND_IMAGE_ID),
        ],
      }),
    );
    const correctedMeta = updateCalls[0]?.meta as Record<string, unknown>;
    expect(correctedMeta.identityReferences).toEqual([record("canonical_identity", LANE_PROBE_IMAGE_ID)]);
  });
});

/**
 * The one-reference-path invariant at the lane's transport seam: the references
 * a rung hands `renderImageIntent` are exactly the slots its compiled prompt
 * numbers — the same images, in the prompt's order, and nothing the prompt does
 * not account for.
 *
 * Falsified against the rung's previous send, which re-derived a list from the
 * lane's own order and left every drop to the transport: offered a place the
 * profile's policy disallows, it handed the intent three references under a
 * prompt that numbered two. The transport then planned the three down to the
 * same two, which is exactly why nothing noticed — the agreement was a
 * coincidence of two call sites reducing the same list. The rung now sends the
 * program's own planned list, and this pins the payload as a property of the
 * prompt rather than of that coincidence.
 */
describe("renderResolvedScene reference payload", () => {
  it("sends the multi rung exactly the slots its prompt numbers, in the prompt's order", async () => {
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    await renderResolvedScene(
      baseInput({
        // Capacity for all three, so only the policy can leave one out.
        profile: sceneProfile(3),
        ...withExtraReference(placeRef("img-place"), "place"),
      }),
    );

    const prompt = pipelineCalls[0]?.asset.prompt as string;
    const numbered = [...prompt.matchAll(/Image (\d+) shows ([A-Za-z]+)/g)].map((match) => [Number(match[1]), match[2]]);
    expect(numbered).toEqual([
      [1, LANE_PROBE_NAME],
      [2, LANE_PROBE_SECOND_NAME],
    ]);

    const sent = mockIntent.mock.calls[0]?.[0].references ?? [];
    expect(sent.map((reference) => reference.sourceImageId)).toEqual([LANE_PROBE_IMAGE_ID, LANE_PROBE_SECOND_IMAGE_ID]);
    expect(sent.map((reference) => reference.role)).toEqual(["identity", "identity"]);
  });
});

/**
 * The route's intimate reveal, per rung. A committed cut never carries intimate
 * anatomy — the visual-state selection keeps its consent gate shut in every
 * lane — so it reaches a compiled prompt only through the scene route's typed
 * projection, and only on a rung whose anchors permit it. Pinned at the lane
 * because the permission is the lane's: the seam projects whatever it is told,
 * and what it is told is `allowForIntimate` on the anchors.
 *
 * Falsified against the cutover's compiled path, which stated no intimate
 * anatomy on any rung — the uncensored rung drew a bare torso from nothing —
 * and against the naive fix of projecting the reveal into the cut itself, which
 * would state it on the moderated rung too.
 */
describe("renderResolvedScene intimate reveal", () => {
  it("states the exposed anatomy on a permitting rung and withholds a covered subject's skin", async () => {
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    await renderResolvedScene(baseInput({ ...laneProbeCastSceneRender({ bareFocal: true }) }));
    const prompt = pipelineCalls[0]?.asset.prompt as string;
    expect(prompt).toContain("Nyx has nipples: puffy."); // torso bare → skin stated
    expect(prompt).toContain("Nyx has breast size: ample."); // shape reads through regardless
    expect(prompt).not.toContain("inverted"); // Ilsa's torso is covered → her skin is withheld
  });

  it("compiles the cut alone on a rung whose anchors forbid intimate detail", async () => {
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    const scene = laneProbeCastSceneRender({ bareFocal: true });
    await renderResolvedScene(
      baseInput({
        ...scene,
        references: scene.references.map((reference) => ({ ...reference, allowForIntimate: false })),
      }),
    );
    const prompt = pipelineCalls[0]?.asset.prompt as string;
    expect(prompt).not.toContain("nipples");
    expect(prompt).not.toContain("breast size");
    // Coverage is the wardrobe's truth, not intimate detail: stated on every rung.
    expect(prompt).toContain("bare at the torso");
  });
});

/**
 * Cast integrity: the cast a render compiles IS the cast it draws — the same
 * people, once each. The two lists arrive from different places (the cuts from
 * the visual assembly, the references from the lane's roster) and everything
 * downstream is derived from one or the other: the digest's subjects and
 * `subjectCount` from the cuts, the identity bindings from the references.
 *
 * Falsified against the render this replaces, which compiled whatever cuts it
 * was handed: a scene one cut short compiled a world digest one person short,
 * asserted that smaller `subjectCount`, and still sent the missing member's
 * identity reference — an internally inconsistent render that looks like a
 * successful picture of a different scene. The mirror faults are pinned beside
 * it because a one-way check would pass them: a cut nobody drew adds a body and
 * an identity lock the payload cannot honor, and a duplicated cut counts one
 * person twice.
 *
 * Pinned as: the refusal lands before provider spend, it names exactly the
 * people who disagree, and the reserved row stores no prompt for a cast that was
 * never going to be sent.
 */
describe("renderResolvedScene cast integrity", () => {
  it("refuses a two-person render whose second member has no committed cut", async () => {
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    const scene = laneProbeCastSceneRender();
    const sink = new DiagnosticCollector();

    await renderResolvedScene(baseInput({ ...scene, cast: scene.cast.slice(0, 1), sink }));

    expect(mockIntent).not.toHaveBeenCalled();
    expect(pipelineCalls[0]?.failedPrecondition).toContain(LANE_PROBE_SECOND_NAME);
    // The one-person prompt was never compiled, so the failed row carries none.
    expect(pipelineCalls[0]?.asset.prompt).toBe("");
    const refused = sink.items.filter((entry) => entry.code === "images.scene_render.cast_mismatch");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.severity).toBe("error");
    expect(refused[0]?.context).toMatchObject({
      intended: 2,
      compiled: 1,
      missing: [LANE_PROBE_SECOND_SUBJECT_ID],
      extra: [],
      duplicated: [],
    });
  });

  it("refuses a three-person render missing the MIDDLE member's cut, blaming only them", async () => {
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    const scene = laneProbeCastSceneRender({ size: 3 });
    const sink = new DiagnosticCollector();
    // Nyx and Tobrek keep their cuts; Ilsa's is gone — a loss a check comparing
    // list lengths, or trusting cast order, would report against the wrong person.
    const cast = scene.cast.filter((slice) => slice.subjectId !== LANE_PROBE_SECOND_SUBJECT_ID);

    await renderResolvedScene(baseInput({ ...scene, cast, sink }));

    expect(mockIntent).not.toHaveBeenCalled();
    const precondition = pipelineCalls[0]?.failedPrecondition ?? "";
    expect(precondition).toContain(LANE_PROBE_SECOND_NAME);
    expect(precondition).not.toContain(LANE_PROBE_NAME);
    expect(precondition).not.toContain(LANE_PROBE_THIRD_NAME);
    expect(pipelineCalls[0]?.asset.prompt).toBe("");
    const refused = sink.items.filter((entry) => entry.code === "images.scene_render.cast_mismatch");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.context).toMatchObject({
      intended: 3,
      compiled: 2,
      missing: [LANE_PROBE_SECOND_SUBJECT_ID],
      extra: [],
      duplicated: [],
    });
  });

  it("refuses a committed cut for a subject no reference draws", async () => {
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    const scene = laneProbeCastSceneRender({ size: 3 });
    const sink = new DiagnosticCollector();
    // Three cuts, two references: the prompt would describe Tobrek and assert a
    // cast of three while the payload carries two faces. Every INTENDED member
    // still has a cut, so a one-way check sees nothing wrong here.
    const references = scene.references.filter((reference) => reference.entityId !== LANE_PROBE_THIRD_SUBJECT_ID);

    await renderResolvedScene(baseInput({ ...scene, references, sink }));

    expect(mockIntent).not.toHaveBeenCalled();
    expect(pipelineCalls[0]?.failedPrecondition).toContain(LANE_PROBE_THIRD_NAME);
    expect(pipelineCalls[0]?.asset.prompt).toBe("");
    const refused = sink.items.filter((entry) => entry.code === "images.scene_render.cast_mismatch");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.context).toMatchObject({
      intended: 2,
      compiled: 3,
      missing: [],
      extra: [LANE_PROBE_THIRD_SUBJECT_ID],
      duplicated: [],
    });
  });

  it("refuses a cast carrying two committed cuts for one person", async () => {
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    const scene = laneProbeCastSceneRender();
    const sink = new DiagnosticCollector();
    // Ilsa twice. Every intended member has a cut and no cut is a stranger, so
    // the fault is visible only to a check that matches the two lists person by
    // person: the digest would carry an extra body and the count would claim it.
    const cast = [...scene.cast, ...scene.cast.slice(1, 2)];

    await renderResolvedScene(baseInput({ ...scene, cast, sink }));

    expect(mockIntent).not.toHaveBeenCalled();
    expect(pipelineCalls[0]?.failedPrecondition).toContain(LANE_PROBE_SECOND_NAME);
    expect(pipelineCalls[0]?.asset.prompt).toBe("");
    const refused = sink.items.filter((entry) => entry.code === "images.scene_render.cast_mismatch");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.context).toMatchObject({
      intended: 2,
      compiled: 3,
      missing: [],
      extra: [],
      duplicated: [LANE_PROBE_SECOND_SUBJECT_ID],
    });
  });
});

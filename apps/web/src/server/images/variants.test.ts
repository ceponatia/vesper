import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ImageLoraRenderBinding,
  imageModelProfileSchema,
  imageModelSchema,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_MODEL_SLUG } from "@/contracts/images/intimate-scene-lora";
import { IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT } from "@/contracts/images/subject-reveal";
import type { PortraitVariantKind } from "@/contracts/images/portrait-variant";
import {
  attr,
  identityCandidateFixture as candidate,
  identityProvenanceFixture as record,
  LANE_PROBE_NAME,
  LANE_PROBE_SUBJECT_ID,
  laneProbeProfile,
  laneProbeVariantCut,
  resolvedImageProfileFixture,
} from "@/server/test-support";

/*
 * The `activeVariantProgram` suite below is pure: it calls nothing these mocks
 * replace. They serve the lane suite at the end of the file, which drives
 * `generateVariant` with its IO mocked — the profile resolver, the character
 * read, the wardrobe read, the identity pack, the pipeline shell and the render
 * seam — while the intimate route (`nsfw-lora.ts`) and the age rule run for
 * real, over mocked model-registry and LoRA-library reads.
 */
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, isDemoMode: vi.fn(() => false) };
});
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});
vi.mock("../events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../events")>();
  return { ...actual, logEvent: vi.fn() };
});
vi.mock("./model-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-profiles")>();
  return { ...actual, resolveImageProfileForTask: vi.fn() };
});
vi.mock("./avatar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./avatar")>();
  return { ...actual, loadDefaultWardrobeWithRevisions: vi.fn() };
});
vi.mock("./identity-pack-consume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity-pack-consume")>();
  return { ...actual, identityPackRenderReferences: vi.fn() };
});
vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>();
  return { ...actual, runImagePipeline: vi.fn() };
});
vi.mock("./render-intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-intent")>();
  return { ...actual, renderImageIntent: vi.fn() };
});
vi.mock("./models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models")>();
  return { ...actual, loadImageModels: vi.fn() };
});
vi.mock("./image-loras", () => ({ resolveImageLoraForRender: vi.fn() }));
vi.mock("@/server/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logDiagnostics: vi.fn(),
}));

import { db } from "../db";
import type { ImageRow } from "./asset-storage";
import { runImagePipeline, type ImagePipelineOptions } from "./assets";
import { loadDefaultWardrobeWithRevisions } from "./avatar";
import { isCharacterPromptCompiled, type CharacterPromptProgram } from "./character-prompt-program";
import { identityPackRenderReferences, type IdentityPackRenderReferencesResult } from "./identity-pack-consume";
import { resolveImageLoraForRender } from "./image-loras";
import { resolveImageProfileForTask } from "./model-profiles";
import { loadImageModels } from "./models";
import { renderImageIntent } from "./render-intent";
import {
  activeVariantProgram,
  generateVariant,
  NSFW_TEST_AGE_REFUSAL,
  NSFW_TEST_VARIANT_KIND,
  VARIANT_NSFW_TEST_AGE_GATED,
} from "./variants";

/**
 * THE `nsfw_test` BENCH'S MISSING INPUT (issue #430).
 *
 * `activeVariantProgram` compiled the bench kind through the shared character
 * seam without ever passing `intimateReveal`, so a successfully paired
 * anatomy-LoRA route stated coverage exactly like an ordinary variant and
 * never asked the compiled prompt for the exposed anatomy the LoRA test
 * exists to evaluate. The fix threads `intimateReveal: true` through the seam
 * only for a SUCCESSFULLY resolved `nsfw_test` route
 * (`inputs.nsfwRoute?.ok`), which projects the cut's applicable exposed
 * anatomy as typed `subject.intimate_anatomy` facts
 * (`subjectIntimateRevealFacts`, `contracts/images/subject-reveal.ts`) beside
 * the compiled text — the same mechanism the scene lane
 * (`scene.ts` `intimateReveal: allowIntimateFor(id)`) and the staged bench
 * (`image-lab-staged.ts`) already use. The cut's own `intimateAllowed` stays
 * `false` throughout (docs/images/pipelines/portrait-variants.md §The cut) —
 * this is a route-level projection beside the digest, never a change to what
 * the digest itself may carry.
 *
 * `activeVariantProgram` is exported (module-private otherwise) so this suite
 * can call it directly with hand-built `VariantProgramInputs`: pure data in,
 * a `CharacterPromptProgramResult` out, no database and nothing it calls
 * mocked.
 * Binding resolution runs on the REAL production Qwen 2511 `variant-standard`
 * row (`packs-qwen-2511.ts`, imported for its registration side effect by
 * `character-prompt-program.ts`), exactly as `character-prompt-program.test.ts`
 * resolves the variant lane.
 */

/** The resolved profile every case compiles on — the real bound Qwen 2511 variant row. */
const RESOLVED_PROFILE = resolvedImageProfileFixture({
  slug: "qwen/qwen-image-edit-2511",
  task: "variant",
  key: "variant-standard",
});

/** A paired LoRA binding, shaped as `pairProfileWithNsfwLora` hands one back. */
const NSFW_LORA_BINDING: ImageLoraRenderBinding = {
  id: "imglorqwennsfwallinclv20",
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locator: "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor",
  scale: 1,
  promptPrefix: null,
  promptSuffix: null,
  triggerWords: [],
};

/**
 * The probe sheet plus the three re-tiered surface facts, in disjoint words —
 * the same fixture `character-prompt-program.test.ts`'s "breast detail a
 * covered torso cannot show" suite builds, reused here rather than
 * re-authored.
 */
const SURFACE_PROFILE = laneProbeProfile({
  attributes: [
    ...laneProbeProfile().attributes,
    attr("breasts.shape", "teardrop", "base"),
    attr("breasts.augmentation", "obviously_augmented", "base"),
    attr("breasts.fullness", "plump", "base"),
  ],
});

const SURFACE_WORDS = [/teardrop/i, /augment/i, /plump/i];

/** The bare-torso variant cut — wardrobe `[]` — over the surface profile above. */
const BARE_TORSO_CUT = laneProbeVariantCut([], SURFACE_PROFILE);

const CHARACTER = { name: LANE_PROBE_NAME, updatedAt: new Date("2026-08-30T00:00:00.000Z") };

const PACK_BUFFER = Buffer.from("lane-probe-identity-bytes");

/** One resolved identity-pack selection — the only pack shape `activeVariantProgram` reads. */
function packSelection(): Extract<IdentityPackRenderReferencesResult, { ok: true }> {
  return {
    ok: true,
    references: [
      {
        reference: {
          role: "identity",
          required: true,
          priority: 1,
          sourceImageId: "img-probe-nyx",
          buffer: PACK_BUFFER,
        },
        provenance: record("canonical_identity", "img-probe-nyx"),
        candidate: candidate("canonical_identity", true, "img-probe-nyx"),
        source: "uploaded",
        // An uploaded portrait carries no appearance stamp (issue #551), which
        // is what every pre-contract reference compares as: `unknown`.
        appearanceRevision: null,
      },
    ],
    provenance: [record("canonical_identity", "img-probe-nyx")],
  };
}

/**
 * One `activeVariantProgram` call over the shared bare-torso cut, varying only
 * the variant kind and the bench route's answer — the two inputs the seam's
 * `intimateReveal` decision is gated on. A successful route carries the anatomy
 * LoRA unless `withLora: false` asks for the no-LoRA route a model the
 * intimate-route policy lists takes.
 */
function programFor(
  kind: PortraitVariantKind,
  nsfwRoute: null | { readonly ok: true; readonly withLora?: boolean } | { readonly ok: false; readonly error: string },
) {
  return activeVariantProgram({
    character: CHARACTER,
    resolved: RESOLVED_PROFILE,
    cut: BARE_TORSO_CUT,
    nsfwRoute:
      nsfwRoute === null
        ? null
        : nsfwRoute.ok
          ? nsfwRoute.withLora === false
            ? {
                ok: true,
                profile: RESOLVED_PROFILE,
                binding: null,
                provenance: { lora: null, reason: "no_anatomy_lora_curated" },
              }
            : {
                ok: true,
                profile: RESOLVED_PROFILE,
                binding: NSFW_LORA_BINDING,
                provenance: { lora: NSFW_LORA_BINDING.id, reason: "anatomy_lora" },
              }
          : { ok: false, error: nsfwRoute.error },
    packSelection: packSelection(),
    input: {
      characterId: LANE_PROBE_SUBJECT_ID,
      userId: "user-probe",
      kind,
      instruction: "the studio's fixed bench instruction",
    },
    revisions: [],
  });
}

function compiled(result: ReturnType<typeof programFor>): CharacterPromptProgram {
  if (result === null || !isCharacterPromptCompiled(result)) {
    throw new Error(`expected a compiled program, got ${result === null ? "null" : result.kind}`);
  }
  return result;
}

describe("the nsfw_test bench asks the seam for the anatomy it tests (#430)", () => {
  it("compiles typed subject.intimate_anatomy facts and the surface words over a bare-torso cut", () => {
    const program = compiled(programFor(NSFW_TEST_VARIANT_KIND, { ok: true }));

    const facts = program.subjects.flatMap((subject) => subject.facts);
    expect(facts.some((fact) => fact.concept === IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT)).toBe(true);
    for (const word of SURFACE_WORDS) expect(program.prompt).toMatch(word);
  });

  it("leaves an ordinary pose variant over the SAME cut with no intimate facts or surface words", () => {
    const program = compiled(programFor("pose", null));

    const facts = program.subjects.flatMap((subject) => subject.facts);
    expect(facts.some((fact) => fact.concept === IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT)).toBe(false);
    for (const word of SURFACE_WORDS) expect(program.prompt).not.toMatch(word);
    // The ordinary-route exception: breast SIZE reads through clothing (and
    // through no clothing) regardless of the bench route — only the surface
    // detail above is gated on it.
    expect(program.prompt).toMatch(/an ample bust/i);
  });

  it("asks for the same anatomy on a route with no LoRA — the allowance is the route's, never the weights'", () => {
    // A model the intimate-route policy lists renders the bench on itself with
    // no LoRA (owner ruling 2026-10-01). Reveal keyed on a binding instead of
    // the route would compile that bench as an ordinary variant: the tame
    // prompt for a render whose whole point is the anatomy.
    const withLora = compiled(programFor(NSFW_TEST_VARIANT_KIND, { ok: true }));
    const withoutLora = compiled(programFor(NSFW_TEST_VARIANT_KIND, { ok: true, withLora: false }));

    const facts = withoutLora.subjects.flatMap((subject) => subject.facts);
    expect(facts.some((fact) => fact.concept === IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT)).toBe(true);
    expect(withoutLora.prompt).toBe(withLora.prompt);
  });

  it("returns null for a FAILED bench route, unchanged from before this fix", () => {
    const program = programFor(NSFW_TEST_VARIANT_KIND, {
      ok: false,
      error: "the NSFW test LoRA is unavailable (model): no active row",
    });

    expect(program).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The bench's age gate (owner ruling 2026-10-01)
// ---------------------------------------------------------------------------

const mockPipeline = vi.mocked(runImagePipeline);
const mockIntent = vi.mocked(renderImageIntent);
const mockPack = vi.mocked(identityPackRenderReferences);
const mockModels = vi.mocked(loadImageModels);
const mockResolveLora = vi.mocked(resolveImageLoraForRender);

const pipelineCalls: ImagePipelineOptions[] = [];

/** The `variant` default on Civitai Qwen Image 2.1 — a model the intimate-route policy lists. */
const QWEN21_VARIANT: ResolvedImageProfile = {
  model: imageModelSchema.parse({
    id: "imgmdlcivqwen21aaaaaaaa",
    slug: CIVITAI_QWEN_IMAGE_21_SLUG,
    label: "Qwen Image 2.1 (Civitai)",
    canGenerate: true,
    canEdit: true,
    editKind: "multi_reference_compose",
    identityPreservation: "strong",
    referenceField: "images",
    referenceArity: "array",
    maxReferences: 10,
    probedVersionId: "3352534",
  }),
  profile: imageModelProfileSchema.parse({
    id: "imgprfqwen21variantaaaa",
    imageModelId: "imgmdlcivqwen21aaaaaaaa",
    key: "variant-standard",
    label: "Variant Standard",
    task: "variant",
    operation: "edit",
    promptStrategy: "instruction_edit",
  }),
};

/** The intimate model's REGISTERED row, carrying the two probed LoRA controls the pairing needs. */
const INTIMATE_MODEL = imageModelSchema.parse({
  id: "imgmdlqwen2511aaaaaaaaaa",
  slug: INTIMATE_SCENE_LORA_MODEL_SLUG,
  label: "Qwen Image Edit 2511",
  canGenerate: false,
  canEdit: true,
  editKind: "instruction_edit",
  identityPreservation: "strong",
  referenceField: "image",
  referenceArity: "array",
  maxReferences: 3,
  probedVersionId: "a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729",
  advancedCapabilities: {
    controls: {
      loraWeights: { field: "lora_weights", type: "string" },
      loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
    },
  },
});

/** The probe sheet with its apparent-age band replaced, or removed when `band` is null. */
function sheetAged(band: string | null) {
  const base = laneProbeProfile();
  return {
    ...base,
    attributes:
      band === null
        ? base.attributes.filter((entry) => entry.id !== "identity.apparent_age")
        : base.attributes.map((entry) => (entry.id === "identity.apparent_age" ? { ...entry, value: band } : entry)),
  };
}

function stubCharacter(profile: ReturnType<typeof sheetAged>): void {
  const row = { id: LANE_PROBE_SUBJECT_ID, name: LANE_PROBE_NAME, profile, updatedAt: CHARACTER.updatedAt };
  vi.mocked(db).mockImplementation(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve([row]),
    };
    return chain as unknown as ReturnType<typeof db>;
  });
}

async function bench(picked: ResolvedImageProfile, band: string | null, sink = new DiagnosticCollector()) {
  vi.mocked(resolveImageProfileForTask).mockResolvedValue(picked);
  stubCharacter(sheetAged(band));
  await generateVariant({
    characterId: LANE_PROBE_SUBJECT_ID,
    userId: "user-probe",
    kind: NSFW_TEST_VARIANT_KIND,
    instruction: "the studio's fixed bench instruction",
    sink,
  });
  const call = pipelineCalls[0];
  if (call === undefined) throw new Error("the bench reserved no row");
  return { call, sink };
}

describe("the nsfw_test bench's age gate, on every model", () => {
  let savedToken: string | undefined;

  afterEach(() => {
    if (savedToken === undefined) delete process.env.CIVITAI_API_TOKEN;
    else process.env.CIVITAI_API_TOKEN = savedToken;
  });

  beforeEach(() => {
    // Cleared, not reset: the `../ai` stub keeps its deployment answer.
    vi.clearAllMocks();
    pipelineCalls.length = 0;
    savedToken = process.env.CIVITAI_API_TOKEN;
    process.env.CIVITAI_API_TOKEN = "civitai-test-token-value";
    vi.mocked(loadDefaultWardrobeWithRevisions).mockResolvedValue({ wardrobe: [], revisions: [] });
    mockPack.mockResolvedValue(packSelection());
    mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
    mockModels.mockResolvedValue([INTIMATE_MODEL]);
    mockResolveLora.mockResolvedValue({ ok: true, binding: NSFW_LORA_BINDING });
    // The shell's own order: a precondition fails the row before `produce` runs.
    mockPipeline.mockImplementation(async (opts) => {
      pipelineCalls.push(opts);
      if ((opts.failedPrecondition ?? null) !== null) return { imageId: "img-variant", status: "failed" };
      const produced = await opts.produce({ id: "img-variant" } as unknown as ImageRow);
      return { imageId: "img-variant", status: produced.ok ? "ready" : "failed" };
    });
  });

  it.each([
    ["a minor band on Qwen Image 2.1", QWEN21_VARIANT, "teen"],
    ["no resolvable age on Qwen Image 2.1", QWEN21_VARIANT, null],
    ["a minor band on 2511's pairing", RESOLVED_PROFILE, "teen"],
    ["no resolvable age on 2511's pairing", RESOLVED_PROFILE, null],
  ])("refuses %s before any route, pack or provider", async (_label, picked, band) => {
    const { call, sink } = await bench(picked, band);

    expect(call.failedPrecondition).toBe(NSFW_TEST_AGE_REFUSAL);
    // Nothing past the gate ran: no intimate model, no LoRA, no pack, no render.
    expect(mockModels).not.toHaveBeenCalled();
    expect(mockResolveLora).not.toHaveBeenCalled();
    expect(mockPack).not.toHaveBeenCalled();
    expect(mockIntent).not.toHaveBeenCalled();
    const meta = call.asset.meta ?? {};
    expect("lora" in meta).toBe(false);
    expect("intimateRoute" in meta).toBe(false);
    const gated = sink.items.find((item) => item.code === VARIANT_NSFW_TEST_AGE_GATED);
    expect(gated?.severity).toBe("warn");
  });

  it.each([
    ["Qwen Image 2.1", QWEN21_VARIANT, { lora: null, reason: "no_anatomy_lora_curated" }],
    ["2511's pairing", RESOLVED_PROFILE, { lora: INTIMATE_SCENE_LORA_ID, reason: "anatomy_lora" }],
  ])("lets a resolved adult through on %s — the control", async (_label, picked, route) => {
    const { call, sink } = await bench(picked, "late_twenties");

    expect(call.failedPrecondition).not.toBe(NSFW_TEST_AGE_REFUSAL);
    expect(call.asset.meta?.intimateRoute).toEqual(route);
    expect(sink.items.some((item) => item.code === VARIANT_NSFW_TEST_AGE_GATED)).toBe(false);
  });

  it("never gates an ordinary variant kind, whatever the character's age", async () => {
    vi.mocked(resolveImageProfileForTask).mockResolvedValue(RESOLVED_PROFILE);
    stubCharacter(sheetAged("teen"));
    const sink = new DiagnosticCollector();
    await generateVariant({
      characterId: LANE_PROBE_SUBJECT_ID,
      userId: "user-probe",
      kind: "pose",
      instruction: "sitting by the window",
      sink,
    });

    expect(pipelineCalls[0]?.failedPrecondition).not.toBe(NSFW_TEST_AGE_REFUSAL);
    expect(sink.items.some((item) => item.code === VARIANT_NSFW_TEST_AGE_GATED)).toBe(false);
    expect(mockModels).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Qwen Image 2.1's nudity clause follows the route, not the coverage
// ---------------------------------------------------------------------------

/**
 * THE 2.1 DIALECT STATES NUDITY ONLY ON A PERMITTED ROUTE (owner rulings
 * 2026-10-01). Over the same fully bare cut — an empty wardrobe, so torso and
 * pelvis both read bare — the production seam compiles the explicit clause
 * ("naked", "nude", "no clothes") only when the lane's route permits the
 * intimate reveal. Bare coverage alone, which is what a minor's wardrobe, an
 * ordinary variant of a character with no saved outfit, or a non-intimate
 * scene presents, must compile the exposure sentences and nothing more. The
 * lanes never grant the permission to a minor (their age gates are tested
 * above and in the scene and reference-view suites); this pins that the
 * dialect cannot reach the words without it.
 */
describe("Qwen Image 2.1 states nudity only where the route permits the intimate reveal", () => {
  const NUDITY = /naked|nude|no clothes/i;

  /** The bench's successful no-LoRA route on 2.1 — the permission, granted. */
  const PERMITTED_ROUTE = {
    ok: true as const,
    profile: QWEN21_VARIANT,
    binding: null,
    provenance: { lora: null, reason: "no_anatomy_lora_curated" as const },
  };

  function qwen21Program(kind: PortraitVariantKind, permitted: boolean, cut = BARE_TORSO_CUT) {
    return compiled(
      activeVariantProgram({
        character: CHARACTER,
        resolved: QWEN21_VARIANT,
        cut,
        nsfwRoute: permitted ? PERMITTED_ROUTE : null,
        packSelection: packSelection(),
        input: {
          characterId: LANE_PROBE_SUBJECT_ID,
          userId: "user-probe",
          kind,
          instruction: "the studio's fixed bench instruction",
        },
        revisions: [],
      }),
    );
  }

  it("states it for an adult's permitted bench over a fully bare cut", () => {
    expect(qwen21Program(NSFW_TEST_VARIANT_KIND, true).prompt).toMatch(NUDITY);
  });

  it("never states it for the same bare cut on an ordinary variant — coverage alone grants nothing", () => {
    const program = qwen21Program("pose", false);
    expect(program.prompt).not.toMatch(NUDITY);
  });

  it("never states it for a minor's bare cut on a route nothing permitted", () => {
    const minorSheet = {
      ...SURFACE_PROFILE,
      attributes: SURFACE_PROFILE.attributes.map((entry) =>
        entry.id === "identity.apparent_age" ? { ...entry, value: "teen" } : entry,
      ),
    };
    const program = qwen21Program("pose", false, laneProbeVariantCut([], minorSheet));
    expect(program.prompt).not.toMatch(NUDITY);
  });
});

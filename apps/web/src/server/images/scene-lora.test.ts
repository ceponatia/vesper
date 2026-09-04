import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyImageModelAdvancedCapabilities,
  evaluateImageLoraForRender,
  type ImageLora,
  type ImageModel,
  imageLoraSchema,
  imageModelProfileSchema,
  imageModelSchema,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { sceneStagingById } from "@/contracts/images/scene-staging";

/**
 * The intimate-scene LoRA route's own decisions: who takes it, and what every
 * missing leg costs.
 *
 * Two collaborators are mocked because they are IO and are tested where they
 * live — the model registry read and the library resolution. Everything the
 * route itself decides is exercised for real, which is the whole of what this
 * file owns: WHEN the intimate LoRA is taken, and what each missing leg costs.
 *
 * It deliberately does NOT own two neighbouring facts, and must not grow them
 * back. Which strengths, models and tasks a library row may reach — and the
 * diagnostic each refusal carries — belongs to `evaluateImageLoraForRender`'s
 * own matrix in `@vesper/image-core`. What the MIGRATED row holds after the
 * whole 0108 → 0114 → 0118 → 0120 chain belongs to `qwen-2511-lora.int.test.ts`,
 * which reads a real database. A fixture here can only restate one migration's
 * text, so a containment claim asserted against it proves the fixture, not
 * production — and would keep passing after the row moved underneath it.
 */

vi.mock("./models", () => ({ loadImageModels: vi.fn() }));
vi.mock("./image-loras", () => ({ resolveImageLoraForRender: vi.fn() }));

import { resolveImageLoraForRender } from "./image-loras";
import { loadImageModels } from "./models";
import { emptySceneRenderPlan, type SceneRenderPlan } from "./prompts-scene-plan";
import {
  INTIMATE_SCENE_LORA_ID,
  INTIMATE_SCENE_LORA_MODEL_SLUG,
  intimateSceneLoraApplies,
  resolveIntimateSceneLoraRoute,
  SCENE_LORA_ROUTE_CODE,
  SCENE_LORA_UNAVAILABLE_CODE,
} from "./scene-lora";

const mockModels = vi.mocked(loadImageModels);
const mockResolveLora = vi.mocked(resolveImageLoraForRender);

const CIVITAI_LOCATOR = "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor";

const PROBED_VERSION = "a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729";

/**
 * The intimate model's REGISTERED row as it stands (docs/image-models/models/qwen-image-edit-2511.md):
 * unpinned slug, edit-only, three references, and the two probed LoRA controls
 * (drizzle 0118, backfilled by 0119) that let weights resolve against it.
 *
 * Deliberately a distinct object from {@link sceneProfile}'s copy of the same
 * model: the pairing reads the registry instead of keeping the lane's object
 * precisely so the row carrying these control bindings is the one the weights
 * are evaluated and sent against.
 */
function intimateModel(overrides: Partial<ImageModel> = {}): ImageModel {
  return imageModelSchema.parse({
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
    supportedAspects: ["1:1", "3:4", "16:9"],
    probedVersionId: PROBED_VERSION,
    advancedCapabilities: {
      controls: {
        loraWeights: { field: "lora_weights", type: "string" },
        loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
      },
      knownInputFields: ["prompt", "image", "lora_weights", "lora_scale"],
    },
    ...overrides,
  });
}

/** The lane's resolved scene profile, as the picker hands it to the route. */
function sceneProfile(): ResolvedImageProfile {
  return {
    model: imageModelSchema.parse({
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
    }),
    profile: imageModelProfileSchema.parse({
      id: "imgprfqwen2511sceneaaaaa",
      imageModelId: "imgmdlqwen2511aaaaaaaaaa",
      key: "scene-standard",
      label: "Scene Standard",
      task: "scene",
      operation: "edit",
      promptStrategy: "instruction_edit",
    }),
  };
}

function stagedPlan(stagingId = "lying_beneath_viewer"): SceneRenderPlan {
  const staging = sceneStagingById(stagingId);
  if (!staging) throw new Error(`fixture names a staging the registry does not have: ${stagingId}`);
  return { ...emptySceneRenderPlan(), staging };
}

const binding = {
  id: INTIMATE_SCENE_LORA_ID,
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locator: CIVITAI_LOCATOR,
  scale: 1,
  promptPrefix: null,
  promptSuffix: null,
  triggerWords: [],
};

/** Every fact the trigger reads, at their on-the-route values. */
function facts(overrides: Partial<Parameters<typeof intimateSceneLoraApplies>[0]> = {}) {
  return { plan: stagedPlan(), allowIntimate: true, selfie: false, referenceRoute: true, anchored: true, ...overrides };
}

let savedToken: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedToken = process.env.CIVITAI_API_TOKEN;
  process.env.CIVITAI_API_TOKEN = "civitai-test-token-value";
  mockModels.mockResolvedValue([intimateModel()]);
  mockResolveLora.mockResolvedValue({ ok: true, binding });
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.CIVITAI_API_TOKEN;
  else process.env.CIVITAI_API_TOKEN = savedToken;
});

describe("intimateSceneLoraApplies", () => {
  it("is true for an intimate staged, uncensored, anchored, non-selfie render", () => {
    expect(intimateSceneLoraApplies(facts())).toBe(true);
  });

  it("is false with no staging at all — the ordinary scene render", () => {
    expect(intimateSceneLoraApplies(facts({ plan: emptySceneRenderPlan() }))).toBe(false);
  });

  it("is false for a NON-intimate staging — the stock model draws those already", () => {
    expect(intimateSceneLoraApplies(facts({ plan: stagedPlan("held_from_behind") }))).toBe(false);
  });

  it("is false on a moderated rung, where the staged sentence is suppressed", () => {
    expect(intimateSceneLoraApplies(facts({ allowIntimate: false }))).toBe(false);
  });

  it("is false for a selfie, whose framing drops the staging outright", () => {
    expect(intimateSceneLoraApplies(facts({ selfie: true }))).toBe(false);
  });

  it("is false without the reference route or an anchor — the proven route is an edit", () => {
    expect(intimateSceneLoraApplies(facts({ referenceRoute: false }))).toBe(false);
    expect(intimateSceneLoraApplies(facts({ anchored: false }))).toBe(false);
  });

  it("is false once a sanitized retry has stripped the staging from the plan", () => {
    // The content-rejection retry rebuilds the plan without `staging`; nothing
    // else has to know about the LoRA for that retry to render LoRA-free.
    const sanitized: SceneRenderPlan = { ...stagedPlan(), staging: undefined };
    expect(intimateSceneLoraApplies(facts({ plan: sanitized }))).toBe(false);
  });
});

describe("resolveIntimateSceneLoraRoute", () => {
  it("routes an intimate staged render onto the intimate model with the library binding", async () => {
    const sink = new DiagnosticCollector();
    const profile = sceneProfile();
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile, sink });

    expect(route?.binding).toEqual(binding);
    // The lane's own profile ROW, paired with the intimate model.
    expect(route?.profile.profile).toBe(profile.profile);
    expect(route?.profile.model.slug).toBe(INTIMATE_SCENE_LORA_MODEL_SLUG);
    // The REGISTERED row rather than the picker's copy of the same model — only
    // the registry row carries the LoRA controls the weights resolve against, so
    // a pairing that kept the caller's object would evaluate against a row that
    // declares none.
    expect(route?.profile.model.advancedCapabilities.controls.loraWeights).toBeDefined();
    // Asked for by id, against the registered row's probed version and the
    // profile's own task.
    expect(mockResolveLora).toHaveBeenCalledWith(
      { id: INTIMATE_SCENE_LORA_ID },
      {
        model: expect.objectContaining({ id: "imgmdlqwen2511aaaaaaaaaa" }),
        versionId: PROBED_VERSION,
        // A player-facing render, so the row's `allowedTasks` curation applies.
        execution: { kind: "production", task: "scene" },
      },
      sink,
    );
    const routed = sink.items.find((item) => item.code === SCENE_LORA_ROUTE_CODE);
    expect(routed?.severity).toBe("info");
    expect(routed?.context).toMatchObject({ lora: INTIMATE_SCENE_LORA_ID, scale: 1, staging: "lying_beneath_viewer" });
  });

  it("pairs the row spelled exactly as the constant, even when a pinned duplicate sorts ahead of it", async () => {
    // Registry uniqueness is on the FULL slug and `sort` is an admin-editable
    // column, so an added `…-2511:<version>` row can legitimately arrive ahead of
    // the built-in bare one. A base-slug-only lookup pairs THAT row: a different
    // provider version, and — as here — a capability record declaring none of the
    // LoRA control bindings the weights are evaluated and sent against.
    const pinnedVersion = "c9bb0b52b1c7d0b4ff5f2c8e0a4d1e6f37c9a0d5b8e2f1a3c4d5e6f708192a3b";
    mockModels.mockResolvedValue([
      intimateModel({
        id: "imgmdlqwen2511pinnedaaaa",
        slug: `${INTIMATE_SCENE_LORA_MODEL_SLUG}:${pinnedVersion}`,
        probedVersionId: pinnedVersion,
        advancedCapabilities: emptyImageModelAdvancedCapabilities(),
      }),
      intimateModel(),
    ]);

    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile: sceneProfile() });
    expect(route?.profile.model.id).toBe("imgmdlqwen2511aaaaaaaaaa");
    // And the weights were resolved against that row's version, not the duplicate's.
    expect(mockResolveLora.mock.calls[0]?.[1]).toMatchObject({ versionId: PROBED_VERSION });
  });

  it("still pairs the pinned spelling when it is the deployment's only 2511 row", async () => {
    // The base-slug match is a FALLBACK, not dead code: a deployment whose row is
    // stored with its version suffix has no exact match to find.
    mockModels.mockResolvedValue([intimateModel({ slug: `${INTIMATE_SCENE_LORA_MODEL_SLUG}:${PROBED_VERSION}` })]);
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile: sceneProfile() });
    expect(route?.binding).toEqual(binding);
  });

  it("reports no scale of its own, so an admin retuning the row's default is followed", async () => {
    await resolveIntimateSceneLoraRoute({ ...facts(), profile: sceneProfile() });
    expect(mockResolveLora.mock.calls[0]?.[0]).toEqual({ id: INTIMATE_SCENE_LORA_ID });
  });

  it("stays silent and reads nothing off the trigger", async () => {
    const sink = new DiagnosticCollector();
    const route = await resolveIntimateSceneLoraRoute({
      ...facts({ plan: emptySceneRenderPlan() }),
      profile: sceneProfile(),
      sink,
    });
    expect(route).toBeNull();
    expect(sink.items).toEqual([]);
    expect(mockModels).not.toHaveBeenCalled();
    expect(mockResolveLora).not.toHaveBeenCalled();
  });

  it("degrades when the intimate model is not registered", async () => {
    mockModels.mockResolvedValue([]);
    const sink = new DiagnosticCollector();
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile: sceneProfile(), sink });
    expect(route).toBeNull();
    expect(mockResolveLora).not.toHaveBeenCalled();
    expectUnavailable(sink, "model");
  });

  it("degrades when the intimate model cannot run the lane's profile", async () => {
    // A row re-rated `weak` fails the identity-critical gate a scene profile
    // carries; refusing here turns a would-be refused render into a fallback.
    mockModels.mockResolvedValue([intimateModel({ identityPreservation: "weak" })]);
    const sink = new DiagnosticCollector();
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile: sceneProfile(), sink });
    expect(route).toBeNull();
    expect(mockResolveLora).not.toHaveBeenCalled();
    expectUnavailable(sink, "model_eligibility");
  });

  it("degrades when the library refuses the row, keeping the library's own code", async () => {
    mockResolveLora.mockResolvedValue({
      ok: false,
      code: "image_lora.unreachable_configuration",
      message: "no usable LoRA library entry",
    });
    const sink = new DiagnosticCollector();
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile: sceneProfile(), sink });
    expect(route).toBeNull();
    const reported = expectUnavailable(sink, "library_row");
    expect(reported.message).toContain("no usable LoRA library entry");
  });

  it("degrades when the deployment has no Civitai credential for the locator", async () => {
    delete process.env.CIVITAI_API_TOKEN;
    const sink = new DiagnosticCollector();
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile: sceneProfile(), sink });
    expect(route).toBeNull();
    const reported = expectUnavailable(sink, "credential");
    // Redacted, always: the message names the address, never a query string.
    expect(reported.message).toContain("https://civitai.com/api/download/models/3160956");
    expect(reported.message).not.toContain("type=Model");
  });

  it("needs no credential when the row's locator is not a Civitai download", async () => {
    delete process.env.CIVITAI_API_TOKEN;
    mockResolveLora.mockResolvedValue({ ok: true, binding: { ...binding, locator: "owner/some-lora" } });
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile: sceneProfile() });
    expect(route).not.toBeNull();
  });

  it("degrades when the lane resolved no profile at all", async () => {
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile: null });
    expect(route).toBeNull();
    expect(mockModels).not.toHaveBeenCalled();
  });
});

/** The one degrade diagnostic, at the expected leg. */
function expectUnavailable(sink: DiagnosticCollector, leg: string) {
  const reported = sink.items.find((item) => item.code === SCENE_LORA_UNAVAILABLE_CODE);
  expect(reported).toBeDefined();
  expect(reported?.severity).toBe("info");
  expect(reported?.context).toMatchObject({ leg });
  expect(sink.items.some((item) => item.code === SCENE_LORA_ROUTE_CODE)).toBe(false);
  return reported ?? { message: "" };
}

// ---------------------------------------------------------------------------
// The seeded row
// ---------------------------------------------------------------------------

const repoFile = (relative: string): string => readFileSync(path.join(process.cwd(), relative), "utf8");

const MIGRATION = "drizzle/0108_intimate-scene-lora.sql";

/**
 * The compatible slug 0108 wrote, as a LOCAL literal.
 *
 * Frozen history, deliberately not the route's constant: 0108 is applied in
 * production and its text can never change, while the constant names whichever
 * model the route pairs with today. Importing it here would make this pin follow
 * the route and stop describing the migration.
 */
const SLUG_0108 = "qwen/qwen-image-edit-plus-lora";

/** The seeded row as `drizzle/0108_intimate-scene-lora.sql` writes it. */
const SEEDED_ROW: ImageLora = imageLoraSchema.parse({
  id: INTIMATE_SCENE_LORA_ID,
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locatorType: "https_url",
  locator: CIVITAI_LOCATOR,
  compatibleModelSlugs: [SLUG_0108],
  compatibleVersionIds: [],
  defaultScale: 1,
  minimumScale: 0.5,
  maximumScale: 1.5,
  triggerWords: [],
  promptPrefix: null,
  promptSuffix: null,
  allowedTasks: ["scene"],
  enabled: true,
  builtin: true,
});

describe("the row 0108 seeds", () => {
  it("is written by the migration exactly as this fixture states it", () => {
    // A PIN ON 0108's OWN TEXT, and deliberately nothing more: that migration is
    // applied in production, so its literals are frozen history. It is NOT a
    // description of the live row, and must not be read as one — later data
    // migrations have moved three of these fields on purpose (0114 widened
    // `allowed_tasks`, 0118 and 0127 rewrote the compatible slugs, 0120 widened
    // the scale band to 0–2), and no single file in a chain can state what the
    // chain produces.
    // What the migrated database actually holds is asserted against a real one
    // in `qwen-2511-lora.int.test.ts`. The identity literals are what earns this
    // case: a changed id, label or locator points every intimate render at
    // different weights with nothing else noticing.
    const sql = repoFile(MIGRATION);
    expect(sql).toContain(`'${SEEDED_ROW.id}'`);
    expect(sql).toContain(`'${SEEDED_ROW.label}'`);
    expect(sql).toContain(`'${SEEDED_ROW.locator}'`);
    expect(sql).toContain(`'["${SLUG_0108}"]'::jsonb`);
    expect(sql).toContain(`'["scene"]'::jsonb`);
    expect(sql).toContain("1, 0.5, 1.5");
    expect(sql).toContain("ON CONFLICT");
  });

  it("resolves for a scene render on the intimate model — the compatibility fields agree", () => {
    // The row as the migration chain leaves it: 0118 added the intimate model's
    // slug and 0127 dropped the retired one, so the list is the route's own
    // pairing and nothing else, which is what lets it resolve at all. Restated on
    // top of the 0108 fixture rather than asserted from the database — what the
    // MIGRATED row really holds is `qwen-2511-lora.int.test.ts`'s claim, against
    // a real one.
    const migrated: ImageLora = { ...SEEDED_ROW, compatibleModelSlugs: [INTIMATE_SCENE_LORA_MODEL_SLUG] };
    const evaluated = evaluateImageLoraForRender({
      lora: migrated,
      modelSlug: intimateModel().slug,
      versionId: PROBED_VERSION,
      context: { kind: "production", task: "scene" },
      bindings: intimateModel().advancedCapabilities.controls,
    });
    expect(evaluated.ok).toBe(true);
    expect(evaluated.ok && evaluated.binding.scale).toBe(1);
    // The locator that reaches a render is the STORED one: no credential is in
    // the row, and nothing before the transport puts one there.
    expect(evaluated.ok && evaluated.binding.locator).toBe(CIVITAI_LOCATOR);
  });
});

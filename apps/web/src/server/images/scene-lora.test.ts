import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
 * The intimate-scene LoRA route's own decisions (intimate-scene-lora.spec.md
 * §Algorithm): who takes it, and what every missing leg costs.
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
  INTIMATE_SCENE_LORA_WRAPPER_SLUG,
  intimateSceneLoraApplies,
  resolveIntimateSceneLoraRoute,
  SCENE_LORA_ROUTE_CODE,
  SCENE_LORA_UNAVAILABLE_CODE,
} from "./scene-lora";

const mockModels = vi.mocked(loadImageModels);
const mockResolveLora = vi.mocked(resolveImageLoraForRender);

const CIVITAI_LOCATOR = "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor";

/**
 * The LoRA wrapper as its registered row stands (docs/image-models/qwen-image-edit-plus-lora.md):
 * pinned community slug, edit-only, three references, and the two probed LoRA
 * bindings that make it the only endpoint this route can use.
 */
function wrapperModel(overrides: Partial<ImageModel> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "imgmdlqwenlorawrapperaaa",
    slug: `${INTIMATE_SCENE_LORA_WRAPPER_SLUG}:b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200`,
    label: "Qwen Image Edit Plus LoRA",
    canGenerate: false,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "moderate",
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    supportedAspects: ["1:1", "3:4", "16:9"],
    probedVersionId: "b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200",
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

/** The lane's resolved scene profile, on the stock scene model. */
function sceneProfile(): ResolvedImageProfile {
  return {
    model: imageModelSchema.parse({
      id: "imgmdlqwen2511aaaaaaaaaa",
      slug: "qwen/qwen-image-edit-2511",
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
  mockModels.mockResolvedValue([wrapperModel()]);
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
  it("routes an intimate staged render onto the wrapper with the library binding", async () => {
    const sink = new DiagnosticCollector();
    const profile = sceneProfile();
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile, sink });

    expect(route?.binding).toEqual(binding);
    // The lane's own profile ROW, paired with the wrapper model.
    expect(route?.profile.profile).toBe(profile.profile);
    expect(route?.profile.model.slug).toContain(INTIMATE_SCENE_LORA_WRAPPER_SLUG);
    // Asked for by id, against the wrapper's pin and the profile's own task.
    expect(mockResolveLora).toHaveBeenCalledWith(
      { id: INTIMATE_SCENE_LORA_ID },
      {
        model: expect.objectContaining({ id: "imgmdlqwenlorawrapperaaa" }),
        versionId: "b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200",
        // A player-facing render, so the row's `allowedTasks` curation applies.
        execution: { kind: "production", task: "scene" },
      },
      sink,
    );
    const routed = sink.items.find((item) => item.code === SCENE_LORA_ROUTE_CODE);
    expect(routed?.severity).toBe("info");
    expect(routed?.context).toMatchObject({ lora: INTIMATE_SCENE_LORA_ID, scale: 1, staging: "lying_beneath_viewer" });
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

  it("degrades when no wrapper model is registered", async () => {
    mockModels.mockResolvedValue([]);
    const sink = new DiagnosticCollector();
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile: sceneProfile(), sink });
    expect(route).toBeNull();
    expect(mockResolveLora).not.toHaveBeenCalled();
    expectUnavailable(sink, "wrapper_model");
  });

  it("degrades when the wrapper cannot run the lane's profile", async () => {
    // A row re-rated `weak` fails the identity-critical gate a scene profile
    // carries; refusing here turns a would-be refused render into a fallback.
    mockModels.mockResolvedValue([wrapperModel({ identityPreservation: "weak" })]);
    const sink = new DiagnosticCollector();
    const route = await resolveIntimateSceneLoraRoute({ ...facts(), profile: sceneProfile(), sink });
    expect(route).toBeNull();
    expect(mockResolveLora).not.toHaveBeenCalled();
    expectUnavailable(sink, "wrapper_eligibility");
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
// The seeded row, and its parity with the probe that graded it
// ---------------------------------------------------------------------------

const repoFile = (relative: string): string => readFileSync(path.join(process.cwd(), relative), "utf8");

const MIGRATION = "drizzle/0108_intimate-scene-lora.sql";
const PROBE = "scripts/eval/scene-images/intimate-model-ab.ts";

/** The seeded row as `drizzle/0108_intimate-scene-lora.sql` writes it. */
const SEEDED_ROW: ImageLora = imageLoraSchema.parse({
  id: INTIMATE_SCENE_LORA_ID,
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locatorType: "https_url",
  locator: CIVITAI_LOCATOR,
  compatibleModelSlugs: [INTIMATE_SCENE_LORA_WRAPPER_SLUG],
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
    // `allowed_tasks`, 0118 added the 2511 slug, 0120 widened the scale band to
    // 0–2), and no single file in a chain can state what the chain produces.
    // What the migrated database actually holds is asserted against a real one
    // in `qwen-2511-lora.int.test.ts`. The identity literals are what earns this
    // case: a changed id, label or locator points every intimate render at
    // different weights with nothing else noticing.
    const sql = repoFile(MIGRATION);
    expect(sql).toContain(`'${SEEDED_ROW.id}'`);
    expect(sql).toContain(`'${SEEDED_ROW.label}'`);
    expect(sql).toContain(`'${SEEDED_ROW.locator}'`);
    expect(sql).toContain(`'["${INTIMATE_SCENE_LORA_WRAPPER_SLUG}"]'::jsonb`);
    expect(sql).toContain(`'["scene"]'::jsonb`);
    expect(sql).toContain("1, 0.5, 1.5");
    expect(sql).toContain("ON CONFLICT");
  });

  it("resolves for a scene render on the wrapper — the compatibility fields agree", () => {
    const evaluated = evaluateImageLoraForRender({
      lora: SEEDED_ROW,
      modelSlug: wrapperModel().slug,
      versionId: "b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200",
      context: { kind: "production", task: "scene" },
      bindings: wrapperModel().advancedCapabilities.controls,
    });
    expect(evaluated.ok).toBe(true);
    expect(evaluated.ok && evaluated.binding.scale).toBe(1);
    // The locator that reaches a render is the STORED one: no credential is in
    // the row, and nothing before the transport puts one there.
    expect(evaluated.ok && evaluated.binding.locator).toBe(CIVITAI_LOCATOR);
  });
});

/**
 * TRIPWIRE — the probe's `lora` arm and this route must send the same wrapper
 * and the same weights, or the owner's acceptance grades describe a render
 * production does not make (intimate-scene-lora.spec.md §"Fixtures and tests":
 * probe parity).
 *
 * Read as TEXT rather than imported: `intimate-model-ab.ts` runs `main()` on
 * import and would fire a paid probe from a test process.
 */
describe("probe parity", () => {
  it("sends the wrapper slug the probe's lora arm renders on", () => {
    expect(repoFile(PROBE)).toContain(`slug: "${INTIMATE_SCENE_LORA_WRAPPER_SLUG}:`);
  });

  it("sends the weights the probe's Civitai fallback builds", () => {
    const probe = repoFile(PROBE);
    const url = new URL(CIVITAI_LOCATOR);
    const version = url.pathname.split("/").at(-1) ?? "";
    // The probe composes the same URL from a version-id default plus the two
    // query parameters, then appends the token — the same completion this route
    // makes at the render-intent seam.
    expect(probe).toContain("https://civitai.com/api/download/models/");
    expect(probe).toContain(`"${version}"`);
    expect(probe).toContain(`url.searchParams.set("type", "${url.searchParams.get("type") ?? ""}")`);
    expect(probe).toContain(`url.searchParams.set("format", "${url.searchParams.get("format") ?? ""}")`);
    expect(probe).toContain('url.searchParams.set("token", CIVITAI_TOKEN)');
  });

  it("reads the same environment variable the probe does", () => {
    expect(repoFile(PROBE)).toContain("CIVITAI_API_TOKEN");
    expect(repoFile("apps/web/src/server/images/lora-credentials.ts")).toContain("process.env.CIVITAI_API_TOKEN");
  });
});

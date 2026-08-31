import { beforeAll, describe, expect, it } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  registerImagePromptBinding,
  IMAGE_PROMPT_PROGRAM_META_KEY,
  IMAGE_WORLD_STATE_META_KEY,
  parseImagePromptProgramProvenance,
  parseImageWorldStateProvenance,
  type ImagePromptSegment,
  type ImageRenderReference,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { INTIMATE_SCENE_LORA_WRAPPER_SLUG } from "@/contracts/images/intimate-scene-lora";
import { expectDiagnostic } from "@/test/diagnostics";
import { LANE_PROBE_NAME, LANE_PROBE_SUBJECT_ID, laneProbeVariantSegments } from "@/server/test-support";
import {
  buildCharacterPromptProgram,
  isCharacterPromptCompiled,
  variantChangeOperation,
  IMAGE_CHARACTER_PROMPT_PACK_MISSING,
  type CharacterPromptProgram,
  type CharacterPromptProgramInput,
  type CharacterPromptProgramResult,
} from "./character-prompt-program";
import { qwenImageEdit2511NegativePack, qwenImageEdit2511PositivePack } from "./packs-qwen-2511";
import { variantPromptTransport } from "./variants";

/**
 * THE PRODUCTION HALF of the character prompt-program seam
 * (`character-prompt-program.ts`, issue #256) and the variant lane's prompt
 * transport (`variants.ts`).
 *
 * The extraction itself is behavior-preserving and `character-shadow.test.ts`
 * already proves it end to end, so nothing here re-tests the shadow, the
 * compile, the packs or the prompt's wording. What is genuinely NEW is that
 * production now asks the same seam a question the shadow never asks — "is this
 * lane cut over?" — and acts on three different answers. These are the defects
 * that answer can carry, none of which any other gate sees:
 *
 * - **`unbound` degraded into `refused`.** Five seeded profiles (Seedream 4.5,
 *   Seedream 5 Lite, Wan 2.7, SDXL PuLID, Qwen 2511) carry the profile key
 *   `variant-standard`, and the 2511 binding is still a `candidate`. A seam that
 *   treated a null binding as a fault would fail every variant render in the
 *   product. `packs-character.test.ts` owns the resolver-level half of this
 *   (candidate rows invisible to `activeImagePromptBinding`); only the seam's
 *   own three-way answer is pinned here.
 * - **A binding key that loses a dimension.** Keyed on the profile alone it
 *   captures all five models at once; keyed without the profile key it lets a
 *   second `variant` profile inherit a cutover nobody measured; and the
 *   `nsfw_test` bench route swaps the MODEL while keeping the key, so a slugless
 *   key hands the bench render the ordinary 2511 program.
 * - **Prompt numbering taken from the caller's list.** The seam plans the
 *   references itself; a program numbered before planning says "Image 2" for the
 *   image the payload sends first, and hands the dialect the wrong reference
 *   count to pick its identity lock from. This was live in the shadow before the
 *   extraction.
 * - **A compiled render that still carries the legacy segments.**
 *   `resolveIntentPrompt` prefers `promptSegments` over `prompt` whenever the
 *   list is non-empty, so such a render sends the legacy prose while its row
 *   stores the compiled program — the one disagreement in this slice that
 *   nothing anywhere reports.
 *
 * CAUTION: `registerImagePromptBinding` writes a process-global registry that is
 * never reset, so every row this file adds is on a `test-only/…` slug that no
 * production profile can resolve, and no row it adds is `active` on a real slug.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const QWEN_2511_SLUG = "qwen/qwen-image-edit-2511";
const VARIANT_KEY = "variant-standard";
const QWEN_2511_VARIANT_BINDING = "binding-qwen-2511-variant-v1";

/** A promoted (`active`) row, so production resolution has something to answer. */
const PROMOTED_SLUG = "test-only/character-prompt-seam-promoted";
/** A row whose bound pack versions are deliberately never registered. */
const PACKLESS_SLUG = "test-only/character-prompt-seam-packless";
const ABSENT_PACK = "pack-test-only-character-prompt-seam-absent-v1";

const INSTRUCTION = "wearing a floor-length wine-red silk kimono";
const REVISION = "2026-08-30T00:00:00.000Z";
const VARIANT_ASSEMBLY = laneProbeVariantSegments("outfit", INSTRUCTION);

/**
 * One resolved profile. `policy` is the profile's reference policy, which is
 * what makes planning actually move or drop a reference.
 */
function programProfile(over: { slug: string; key?: string; policy?: unknown }): ResolvedImageProfile {
  const model = imageModelSchema.parse({
    id: "mdl-character-prompt-seam",
    slug: over.slug,
    label: "Prompt Program Fixture",
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    supportedAspects: ["3:4"],
  });
  const profile = imageModelProfileSchema.parse({
    id: "prf-character-prompt-seam",
    imageModelId: model.id,
    key: over.key ?? VARIANT_KEY,
    label: "Prompt Program Fixture",
    task: "variant",
    operation: "edit",
    promptStrategy: "instruction_edit",
    ...(over.policy === undefined ? {} : { referencePolicy: over.policy }),
  });
  return { model, profile };
}

function reference(role: "identity" | "location"): ImageRenderReference {
  return {
    role,
    buffer: Buffer.from(`${role}-bytes`),
    name: role === "identity" ? LANE_PROBE_NAME : "the study",
  };
}

/**
 * The variant lane's own call, over the probe fixture — `resolver: "shadow"` by
 * default so the seeded `candidate` row resolves and a narrowing case's
 * `unbound` means the KEY missed, not that the lane is simply not cut over.
 */
function programInput(over: Partial<CharacterPromptProgramInput> = {}): CharacterPromptProgramInput {
  const visual = VARIANT_ASSEMBLY.visual;
  return {
    lane: "variant",
    task: "variant",
    profile: programProfile({ slug: QWEN_2511_SLUG }),
    bindingProfileKey: VARIANT_KEY,
    resolver: "shadow",
    cut: {
      subjectId: LANE_PROBE_SUBJECT_ID,
      name: LANE_PROBE_NAME,
      digest: visual.digest,
      attributes: visual.resolved,
      exposure: visual.exposure,
      realizedBody: visual.realizedBody,
    },
    read: {
      kind: "standalone_character",
      characters: [{ characterId: LANE_PROBE_SUBJECT_ID, revision: REVISION }],
      extraRevisions: [],
    },
    references: [reference("identity")],
    operation: variantChangeOperation("outfit", INSTRUCTION),
    refuseOnMissingRequired: false,
    ...over,
  };
}

function compiled(result: CharacterPromptProgramResult): CharacterPromptProgram {
  if (!isCharacterPromptCompiled(result)) {
    throw new Error(`expected a compiled program, got ${result.kind}: ${JSON.stringify(result)}`);
  }
  return result;
}

beforeAll(() => {
  // Both rows pin the REAL 2511 dialect so nothing here re-registers a dialect;
  // the packless row's pack ids are the only fiction.
  registerImagePromptBinding({
    id: "binding-test-only-character-prompt-seam-promoted-v1",
    profileKey: VARIANT_KEY,
    profileId: null,
    modelId: null,
    modelSlug: PROMOTED_SLUG,
    versionId: null,
    task: "variant",
    promptStrategy: "instruction_edit",
    promptDialectId: "qwen_2511_delta_edit",
    positivePackVersionId: qwenImageEdit2511PositivePack.id,
    negativePackVersionId: qwenImageEdit2511NegativePack.id,
    status: "active",
  });
  registerImagePromptBinding({
    id: "binding-test-only-character-prompt-seam-packless-v1",
    profileKey: VARIANT_KEY,
    profileId: null,
    modelId: null,
    modelSlug: PACKLESS_SLUG,
    versionId: null,
    task: "variant",
    promptStrategy: "instruction_edit",
    promptDialectId: "qwen_2511_delta_edit",
    positivePackVersionId: ABSENT_PACK,
    negativePackVersionId: ABSENT_PACK,
    status: "candidate",
  });
});

// ---------------------------------------------------------------------------
// Which lane is cut over
// ---------------------------------------------------------------------------

describe("binding resolution through the seam", () => {
  /**
   * The staged-rollout contract at the SEAM: the shadow compiles the seeded
   * `candidate` row, production sees nothing, and production's nothing is
   * `unbound` — never `refused`. Kills the seam that reports a missing binding
   * as a fault, which would fail every Seedream/Wan/PuLID variant render, and
   * the seam that lets production resolve a row whose trial has not finished.
   * Promoting `binding-qwen-2511-variant-v1` to `active` must update this pin.
   */
  it("compiles a candidate row for the shadow and answers production unbound, not refused", () => {
    expect(compiled(buildCharacterPromptProgram(programInput())).binding.id).toBe(QWEN_2511_VARIANT_BINDING);
    expect(buildCharacterPromptProgram(programInput({ resolver: "active" }))).toEqual({
      kind: "unbound",
      modelSlug: QWEN_2511_SLUG,
      task: "variant",
      profileKey: VARIANT_KEY,
    });
  });

  /**
   * The binding key is (model slug, task, profile key), and every dimension
   * carries a real render. Read through the SHADOW resolver deliberately: the
   * seeded row is visible there, so `unbound` can only mean the key missed —
   * under the active resolver every row below would answer `unbound` today
   * whether or not the key still had all three dimensions.
   */
  it.each([
    // Four more seeded profiles carry `variant-standard`; a key without the slug
    // would capture all of them the moment 2511 is promoted.
    { name: "another variant model on the same profile key", slug: "bytedance/seedream-4.5", key: VARIANT_KEY },
    // The `nsfw_test` bench route swaps the MODEL and keeps the profile key.
    {
      name: "the bench route's version-pinned LoRA wrapper",
      slug: `${INTIMATE_SCENE_LORA_WRAPPER_SLUG}:b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200`,
      key: VARIANT_KEY,
    },
    // A second `variant` profile added on the bound model later must not inherit
    // a cutover measured for another profile.
    { name: "a profile key no row carries on the bound model", slug: QWEN_2511_SLUG, key: "variant-experimental" },
  ])("resolves unbound for $name", ({ slug, key }) => {
    const input = programInput({ profile: programProfile({ slug, key }), bindingProfileKey: key });
    expect(buildCharacterPromptProgram(input)).toEqual({
      kind: "unbound",
      modelSlug: slug,
      task: "variant",
      profileKey: key,
    });
  });

  /**
   * What cutover is: promotion changes production's answer and nothing else. On
   * an `active` row both resolvers find the same binding and the seam compiles
   * the SAME program from the same cut — even with the two lanes' real
   * `refuseOnMissingRequired` settings — so the evidence the shadow accumulated
   * describes the prompt production will send. Kills any production-only path
   * through the seam (a different budget, a skipped planning step, a lane-aware
   * branch) added during a later cutover round; that drift is the one failure
   * mode that makes the whole staged rollout worthless.
   *
   * The same call is what lands provenance on the image row, so the meta keys
   * and their parsers are asserted here rather than in a test of their own.
   */
  it("hands production exactly the program the shadow measured, with parseable provenance", () => {
    const profile = programProfile({ slug: PROMOTED_SLUG });
    const shadow = compiled(buildCharacterPromptProgram(programInput({ profile })));
    const production = compiled(
      buildCharacterPromptProgram(programInput({ profile, resolver: "active", refuseOnMissingRequired: true })),
    );
    expect(production).toEqual(shadow);

    expect(Object.keys(production.meta).sort()).toEqual(
      [IMAGE_PROMPT_PROGRAM_META_KEY, IMAGE_WORLD_STATE_META_KEY].sort(),
    );
    expect(parseImagePromptProgramProvenance(production.meta[IMAGE_PROMPT_PROGRAM_META_KEY])).not.toBeNull();
    expect(parseImageWorldStateProvenance(production.meta[IMAGE_WORLD_STATE_META_KEY])).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What the bound lane compiles
// ---------------------------------------------------------------------------

describe("compiling a bound lane", () => {
  /**
   * The identity-critical lane's fail-closed rule. On the SAME degraded cut —
   * a subject whose mandatory anchor never reached the digest — production
   * refuses before provider spend while the shadow compiles through the loss so
   * it can be measured. Kills a seam that hard-codes the flag, or passes the
   * shadow's tolerance to production: the render would be a stranger with the
   * character's outfit, and the row would look successful.
   */
  it("refuses a lost mandatory anchor for production and compiles through it for the shadow", () => {
    const visual = VARIANT_ASSEMBLY.visual;
    const cut = {
      ...programInput().cut,
      digest: {
        ...visual.digest,
        subjects: visual.digest.subjects.map((subject) => ({
          ...subject,
          missingMandatory: ["lost.identity.anchor"],
        })),
      },
    };
    const sink = new DiagnosticCollector();
    const tolerant = compiled(buildCharacterPromptProgram(programInput({ cut, sink })));
    expect(tolerant.missingRequired).toContain("lost.identity.anchor");
    expectDiagnostic(sink, "image_prompt_program.missing_required_fact");

    const strict = buildCharacterPromptProgram(programInput({ cut, refuseOnMissingRequired: true }));
    // The compile's own refusal code (image-core `compile-program.ts`).
    expect(strict).toMatchObject({ kind: "refused", code: "image_prompt_program.missing_required_fact" });
  });

  /**
   * The prompt describes the PLANNED payload, never the caller's list. The seam
   * runs `planIntentReferences` itself and compiles the dialect's numbered slots
   * against its output, so a policy that reranks the roles renumbers the
   * assignments and a policy that disallows one shortens the numbered list.
   *
   * Falsified against the pre-extraction shadow, which numbered from the
   * caller's array: with the location image handed in first it wrote
   * "Image 1 shows the place" for the slot the payload fills with the person.
   * The dialect's own single- versus multi-reference identity lock reads
   * `input.references.length` off the SAME list, so proving the planned list is
   * what reaches the dialect is what makes the count right; the lock's wording
   * rule is `dialect-qwen-2511.ts`'s to own.
   */
  it("numbers references from the planned send order, not the caller's list", () => {
    const callerOrder = [reference("location"), reference("identity")];
    const plannedWith = (policy: unknown): CharacterPromptProgram =>
      compiled(
        buildCharacterPromptProgram(
          programInput({ profile: programProfile({ slug: QWEN_2511_SLUG, policy }), references: callerOrder }),
        ),
      );

    // The profile ranks identity ahead of location, so the identity image the
    // caller listed second is sent — and numbered — first.
    const reordered = plannedWith({
      allowedRoles: ["identity", "location"],
      roleOrder: ["identity", "location"],
    });
    expect(reordered.numberedReferences.map((entry) => entry.role)).toEqual(["identity", "location"]);
    expect(reordered.prompt).toContain(`Image 1 shows ${LANE_PROBE_NAME}.`);
    expect(reordered.prompt).toContain("Image 2 shows the place.");

    // The policy disallows the location role: one image is sent, so exactly one
    // slot is numbered and nothing in the prompt names an image the payload
    // does not carry.
    const trimmed = plannedWith({ allowedRoles: ["identity"] });
    expect(trimmed.numberedReferences.map((entry) => entry.role)).toEqual(["identity"]);
    expect(trimmed.sentReferences).toHaveLength(1);
    expect(trimmed.prompt).toContain(`Image 1 shows ${LANE_PROBE_NAME}.`);
    expect(trimmed.prompt).not.toContain("Image 2");
  });

  /**
   * A configuration gap on a lane that IS bound is a refusal, not an `unbound`
   * fall-back to the legacy paragraph: the lane was cut over, and a silent
   * legacy render would hide the broken pin behind acceptable-looking images.
   * `character-shadow.ts` branches on this code to record `pack_missing` rather
   * than an error, so the seam has to emit it.
   */
  it("refuses a binding whose pack versions are not registered", () => {
    const sink = new DiagnosticCollector();
    const result = buildCharacterPromptProgram(
      programInput({ profile: programProfile({ slug: PACKLESS_SLUG }), sink }),
    );
    expect(result).toMatchObject({ kind: "refused", code: IMAGE_CHARACTER_PROMPT_PACK_MISSING });
    expectDiagnostic(sink, IMAGE_CHARACTER_PROMPT_PACK_MISSING);
  });
});

// ---------------------------------------------------------------------------
// What the variant render actually sends
// ---------------------------------------------------------------------------

/**
 * `variantPromptTransport` (`variants.ts`) decides the three prompt channels
 * together. It is pinned here rather than in an integration suite because the
 * failure is silent and the function is pure: `resolveIntentPrompt` prefers
 * `promptSegments` over `prompt` whenever the list is non-empty, so a compiled
 * render that kept the legacy segments would send the legacy prose while its row
 * recorded the compiled program — a provider seeing one prompt and an operator
 * reading another, with nothing reporting the disagreement. The `controls` half
 * kills an invented `negativePrompt: ""` on the Qwen endpoints, which expose no
 * negative field at all.
 */
describe("variantPromptTransport", () => {
  const SEGMENTS: readonly ImagePromptSegment[] = [
    { kind: "identity", text: "The legacy paragraph.", mandatory: true, priority: 100 },
  ];
  const LEGACY = "the legacy prose this render has always sent";

  it.each([
    {
      name: "a legacy render carries its segments",
      program: null,
      keys: ["prompt", "promptSegments"],
      prompt: LEGACY,
      negative: null,
    },
    {
      name: "a compiled render carries none",
      program: { prompt: "compiled", negativePrompt: null },
      keys: ["prompt"],
      prompt: "compiled",
      negative: null,
    },
    {
      name: "an empty compiled negative invents no control",
      program: { prompt: "compiled", negativePrompt: "" },
      keys: ["prompt"],
      prompt: "compiled",
      negative: null,
    },
    {
      name: "a non-empty compiled negative rides the normalized control",
      program: { prompt: "compiled", negativePrompt: "no watermark" },
      keys: ["controls", "prompt"],
      prompt: "compiled",
      negative: "no watermark",
    },
  ])("$name", ({ program, keys, prompt, negative }) => {
    const transport = variantPromptTransport(LEGACY, SEGMENTS, program);
    // The KEY set, not just the values: the whole defect is an inhabited
    // `promptSegments` (or an invented `controls`) beside the compiled prompt.
    expect(Object.keys(transport).sort()).toEqual(keys);
    expect(transport.prompt).toBe(prompt);
    expect(transport.controls?.negativePrompt ?? null).toBe(negative);
  });

  /** The degraded lane: no assembly means no segments, and none are invented. */
  it("emits no segments for a legacy render that assembled none", () => {
    expect(variantPromptTransport(LEGACY, undefined, null)).toEqual({ prompt: LEGACY });
  });
});

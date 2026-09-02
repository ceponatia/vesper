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
import {
  QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK,
} from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { INTIMATE_SCENE_LORA_WRAPPER_SLUG } from "@/contracts/images/intimate-scene-lora";
import { expectDiagnostic } from "@/test/diagnostics";
import { LANE_PROBE_NAME, LANE_PROBE_SUBJECT_ID, laneProbeVariantSegments } from "@/server/test-support";
import { PORTRAIT_IDENTITY_LOCK } from "./prompts-variant";
import {
  buildCharacterPromptProgram,
  characterPromptTransport,
  isCharacterPromptCompiled,
  variantChangeOperation,
  IMAGE_CHARACTER_PROMPT_PACK_MISSING,
  IMAGE_CHARACTER_PROMPT_REFERENCES_RENUMBERED,
  type CharacterPromptProgram,
  type CharacterPromptProgramInput,
  type CharacterPromptReference,
  type CharacterPromptProgramResult,
} from "./character-prompt-program";
import { qwenImageEdit2511NegativePack, qwenImageEdit2511PositivePack } from "./packs-qwen-2511";

/**
 * THE PRODUCTION HALF of the character prompt-program seam
 * (`character-prompt-program.ts`, issue #256) and the variant lane's prompt
 * transport (`variants.ts`).
 *
 * Nothing here re-tests the compile, the packs or the prompt's wording — those
 * have their own owners. What this file owns is the question production asks the
 * seam and cannot ask anywhere else: WHICH row this render resolves, and what
 * the three possible answers do. These are the defects that question can carry,
 * none of which any other gate sees:
 *
 * - **A binding key that loses a dimension.** Five seeded profiles (Qwen Edit
 *   2511, Seedream 4.5, Seedream 5 Lite, Wan 2.7, SDXL PuLID) carry the profile
 *   key `variant-standard`, and since the #256 cutover every one of them is
 *   bound — so a key without the model slug now hands all five the 2511 program:
 *   the wrong dialect, the wrong packs, and a Qwen-numbered identity lock on
 *   endpoints that number nothing. A key without the PROFILE key lets a second
 *   `variant` profile inherit a cutover nobody wired it into. And the `nsfw_test`
 *   bench route swaps the MODEL while keeping the key, onto a wrapper whose
 *   registry slug carries a `:version` pin — so resolution that failed to strip
 *   it would leave that route, and the three version-pinned community
 *   checkpoints, silently on their legacy prompts.
 * - **`unbound` degraded into `refused`.** A refusal FAILS the render; `unbound`
 *   leaves it on the prompt path it already had. The distinction still carries a
 *   fully-bound catalog: a profile added later, an operator-added model.
 * - **Prompt numbering taken from the caller's list.** The seam plans the
 *   references itself; a program numbered before planning says "Image 2" for the
 *   image the payload sends first, and hands the dialect the wrong reference
 *   count to pick its identity lock from. When planning genuinely renumbers, a
 *   numbering dialect REFUSES rather than shipping a prompt that names the wrong
 *   slot.
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

/**
 * One reference as the seam takes it: the transport shape, plus WHO an identity
 * image shows. The subject is what lets an ensemble render bind each face to its
 * own person, so a fixture that omitted it would exercise a different seam.
 */
function reference(role: "identity" | "location"): CharacterPromptReference {
  const rendered: ImageRenderReference = {
    role,
    buffer: Buffer.from(`${role}-bytes`),
    name: role === "identity" ? LANE_PROBE_NAME : "the study",
  };
  return { reference: rendered, ...(role === "identity" ? { subjectId: LANE_PROBE_SUBJECT_ID } : {}) };
}

/**
 * The variant lane's own call, over the probe fixture. `resolver: "shadow"` by
 * default: it is the widest status set, so a case that answers `unbound` under
 * it can only mean the KEY missed. Cases about production's own answer pass
 * `resolver: "active"` explicitly.
 */
function programInput(over: Partial<CharacterPromptProgramInput> = {}): CharacterPromptProgramInput {
  const visual = VARIANT_ASSEMBLY.visual;
  return {
    lane: "variant",
    task: "variant",
    profile: programProfile({ slug: QWEN_2511_SLUG }),
    bindingProfileKey: VARIANT_KEY,
    resolver: "shadow",
    cuts: [
      {
        subjectId: LANE_PROBE_SUBJECT_ID,
        name: LANE_PROBE_NAME,
        digest: visual.digest,
        attributes: visual.resolved,
        exposure: visual.exposure,
        realizedBody: visual.realizedBody,
      },
    ],
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
   * The binding key is (model slug, task, profile key), and every dimension
   * carries a real render. Since the #256 cutover every variant profile the
   * picker offers is bound, so the model dimension is testable POSITIVELY: five
   * profiles share the key `variant-standard`, and each must resolve its own
   * endpoint's row. A key that lost the slug would hand all five the 2511
   * program — the wrong dialect, the wrong packs, and a Qwen-numbered identity
   * lock on endpoints that number nothing.
   */
  it.each([
    { name: "the default editor", slug: QWEN_2511_SLUG, binding: QWEN_2511_VARIANT_BINDING },
    {
      name: "another variant model on the same profile key",
      slug: "bytedance/seedream-4.5",
      binding: "binding-seedream-45-variant-variant-standard-instruction_edit-v1",
    },
    {
      // The `nsfw_test` bench route swaps the MODEL and keeps the profile key,
      // and the wrapper's registry row carries a `:version` pin — resolution
      // strips it, because a binding names an ENDPOINT and pinning a provider
      // version is `versionId`'s separate job. Without the strip this endpoint
      // and the three version-pinned community checkpoints would all answer
      // `unbound` and silently keep their legacy prompts.
      name: "the bench route's version-pinned LoRA wrapper",
      slug: `${INTIMATE_SCENE_LORA_WRAPPER_SLUG}:b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200`,
      binding: "binding-qwen-edit-plus-lora-variant-variant-standard-instruction_edit-v1",
    },
  ])("resolves $name to its own endpoint's row", ({ slug, binding }) => {
    const input = programInput({ profile: programProfile({ slug }), resolver: "active" });
    expect(compiled(buildCharacterPromptProgram(input)).binding.id).toBe(binding);
  });

  /**
   * `unbound` is a THIRD answer, never a refusal — and a refusal is what would
   * fail the render rather than leaving it on the prompt path it already had.
   * It stays reachable now that the catalog is fully bound: a second `variant`
   * profile added on a bound model later must not inherit a cutover nobody wired
   * it into, and an operator-added model has no dialect at all.
   */
  it.each([
    { name: "a profile key no row carries on the bound model", slug: QWEN_2511_SLUG, key: "variant-experimental" },
    { name: "a model with no binding at all", slug: "test-only/character-prompt-seam-absent", key: VARIANT_KEY },
  ])("resolves unbound, not refused, for $name", ({ slug, key }) => {
    const input = programInput({
      profile: programProfile({ slug, key }),
      bindingProfileKey: key,
      resolver: "active",
    });
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
    const [intact] = programInput().cuts;
    if (intact === undefined) throw new Error("the probe fixture compiles no cut");
    const cuts = [
      {
        ...intact,
        digest: {
          ...visual.digest,
          subjects: visual.digest.subjects.map((subject) => ({
            ...subject,
            missingMandatory: ["lost.identity.anchor"],
          })),
        },
      },
    ];
    const sink = new DiagnosticCollector();
    const tolerant = compiled(buildCharacterPromptProgram(programInput({ cuts, sink })));
    expect(tolerant.missingRequired).toContain("lost.identity.anchor");
    expectDiagnostic(sink, "image_prompt_program.missing_required_fact");

    const strict = buildCharacterPromptProgram(programInput({ cuts, refuseOnMissingRequired: true }));
    // The compile's own refusal code (image-core `compile-program.ts`).
    expect(strict).toMatchObject({ kind: "refused", code: "image_prompt_program.missing_required_fact" });
  });

  /**
   * The prompt describes the PLANNED payload, never the caller's list. The seam
   * runs `planIntentReferences` itself and compiles the dialect's slots against
   * its output, so a policy that disallows a role shortens the numbered list and
   * nothing in the prompt names an image the payload does not carry.
   *
   * Falsified against the pre-extraction shadow, which numbered from the
   * caller's array. The dialect's own single- versus multi-reference identity
   * lock reads `input.references.length` off the SAME list, so proving the
   * planned list is what reaches the dialect is what makes the count right; the
   * lock's wording rule is `dialect-qwen-2511.ts`'s to own.
   *
   * The REORDERING half of this behavior is asserted by the renumbering test
   * above, which is where a numbering dialect now refuses instead.
   */
  it("numbers references from the planned send order, not the caller's list", () => {
    const trimmed = compiled(
      buildCharacterPromptProgram(
        programInput({
          // The policy disallows the location role, and the caller lists the
          // identity image first — so one image is sent, from position zero, and
          // exactly one slot is numbered.
          profile: programProfile({ slug: QWEN_2511_SLUG, policy: { allowedRoles: ["identity"] } }),
          references: [reference("identity"), reference("location")],
        }),
      ),
    );
    expect(trimmed.numberedReferences.map((entry) => entry.role)).toEqual(["identity"]);
    expect(trimmed.sentReferences).toHaveLength(1);
    expect(trimmed.prompt).toContain(`Image 1 shows ${LANE_PROBE_NAME}.`);
    expect(trimmed.prompt).not.toContain("Image 2");
  });

  /**
   * #256: on a dialect that NUMBERS its slots, reference planning moving a
   * sent reference out of the slot the caller's own order gave it is a CUTOVER
   * FAILURE, not the planner's warning.
   *
   * The failure is invisible in the output — the render succeeds and returns a
   * plausible image of the wrong composition — and it is invisible in the row
   * too, because the prompt and the payload are each internally consistent.
   * This module compiles its numbering from the planned list, so the prompt it
   * produces is right on its own; `renumbered` is the signal that the caller's
   * order and the policy's order genuinely disagree, which is the state where
   * the second plan `renderImageIntent` runs over the same list could put the
   * room in the slot the prompt calls the person. #250 moves final numbering
   * downstream and retires the guard.
   *
   * Scoped to numbering dialects: the prose family names references by role and
   * the tag family names none, so the same reordering compiles cleanly there —
   * a dialect cannot misname a slot it never asserts. Both halves are asserted,
   * because a guard that fired on every dialect would refuse every Seedream and
   * Wan scene the picker offers.
   */
  it("refuses a renumbered plan on a numbering dialect and compiles it on a naming one", () => {
    // The caller lists the location first; the policy ranks identity ahead of
    // it, so the identity image is SENT first and the caller's slot 1 moves.
    const callerOrder = [reference("location"), reference("identity")];
    const policy = { allowedRoles: ["identity", "location"], roleOrder: ["identity", "location"] };
    const sink = new DiagnosticCollector();

    const numbering = buildCharacterPromptProgram(
      programInput({
        profile: programProfile({ slug: QWEN_2511_SLUG, policy }),
        references: callerOrder,
        sink,
      }),
    );
    expect(numbering).toMatchObject({ kind: "refused", code: IMAGE_CHARACTER_PROMPT_REFERENCES_RENUMBERED });
    expectDiagnostic(sink, IMAGE_CHARACTER_PROMPT_REFERENCES_RENUMBERED);

    // Same plan, same reordering, a dialect that speaks role labels: nothing to
    // misname, so the render proceeds.
    const naming = compiled(
      buildCharacterPromptProgram(
        programInput({ profile: programProfile({ slug: "bytedance/seedream-4.5", policy }), references: callerOrder }),
      ),
    );
    expect(naming.numberedReferences.map((entry) => entry.role)).toEqual(["identity", "location"]);
    expect(naming.prompt).not.toContain("Image 1");
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
 * `characterPromptTransport` (`character-prompt-program.ts`) decides the three
 * prompt channels together, for every cut-over character lane at once — the
 * avatar, the variant, the chat-look mint and each scene rung. It is pinned here
 * rather than in an integration suite because the
 * failure is silent and the function is pure: `resolveIntentPrompt` prefers
 * `promptSegments` over `prompt` whenever the list is non-empty, so a compiled
 * render that kept the legacy segments would send the legacy prose while its row
 * recorded the compiled program — a provider seeing one prompt and an operator
 * reading another, with nothing reporting the disagreement. The `controls` half
 * kills an invented `negativePrompt: ""` on the Qwen endpoints, which expose no
 * negative field at all.
 */
describe("characterPromptTransport", () => {
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
    const transport = characterPromptTransport(LEGACY, SEGMENTS, program);
    // The KEY set, not just the values: the whole defect is an inhabited
    // `promptSegments` (or an invented `controls`) beside the compiled prompt.
    expect(Object.keys(transport).sort()).toEqual(keys);
    expect(transport.prompt).toBe(prompt);
    expect(transport.controls?.negativePrompt ?? null).toBe(negative);
  });

  /** The degraded lane: no assembly means no segments, and none are invented. */
  it("emits no segments for a legacy render that assembled none", () => {
    expect(characterPromptTransport(LEGACY, undefined, null)).toEqual({ prompt: LEGACY });
  });
});


/**
 * THE TWO PROVIDER-FACING LAWS OF A CUT-OVER CHARACTER RENDER, taken end to end
 * from the real variant assembly rather than from a hand-built digest — because
 * both defects these kill were invisible to every fixture that started from one.
 */
describe("what a cut-over variant render would actually send", () => {
  const program = (): CharacterPromptProgram => compiled(buildCharacterPromptProgram(programInput()));

  /**
   * The identity lock must come from the WORLD, not from the legacy string.
   *
   * The digest of an edit lane states no identity descriptors — the reference
   * image shows the face — and the endpoint dialects emit their lock from a
   * `subject.identity` claim. Before the anchor existed, that claim never
   * appeared for this lane, so a compiled variant carried no identity
   * protection at all while the legacy prompt carried a route-owned lock
   * sentence. Nothing reported it: the route segment is outside the emission
   * ledger on both sides, and transport parity never compares prompt text. A
   * compiled render that leaned on the legacy segment would have shipped an
   * identity-critical edit with nothing telling the model to keep the face.
   *
   * Byte-exact, because "means the same" is the defect: the render kernel's
   * Qwen quirk rewrites the legacy lock into these bytes today, so a compiled
   * program is comparable to the shipping edit path only if it reproduces them.
   */
  it("emits the byte-identical Qwen lock from the digest's own identity claim", () => {
    const result = program();

    // The claim is the digest's, and it is REQUIRED — no budget squeeze may
    // trade a person's likeness away for optional detail.
    const anchors = result.subjects
      .flatMap((subject) => subject.facts)
      .filter((fact) => fact.concept === "subject.identity");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.disposition).toBe("required_visual");
    expect(result.keptClaimIds).toContain(anchors[0]?.key);

    // No model-specific wording reached the world digest: the digest states a
    // neutral truth and the dialect owns the endpoint's sentence.
    expect(anchors[0]?.value).not.toContain("Preserve the exact face");
    expect(JSON.stringify(result.subjects)).not.toContain(PORTRAIT_IDENTITY_LOCK);

    // …and the dialect turns it into the endpoint's own bytes, once.
    expect(result.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(result.prompt.indexOf(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK)).toBe(
      result.prompt.lastIndexOf(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK),
    );
    expect(result.prompt).not.toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
  });

  /**
   * No internal handle may reach provider prose.
   *
   * The preserve set identifies its facts structurally — `<subjectId>/horns/
   * species.feature_group` — and the dialect used to render that list verbatim,
   * so a production render would have sent a character's database id, a
   * projection source key and a registry kind id to the provider as the text a
   * model is asked to act on. Unusable as instruction, and a private identifier
   * leaving the system as a side effect of drawing a picture.
   *
   * The subject id in this fixture is a literal, so a regression is not
   * theoretical: it would put THIS string in the payload.
   */
  it("names no database id, source key or fingerprint in the prompt", () => {
    const result = program();

    expect(result.prompt).not.toContain(LANE_PROBE_SUBJECT_ID);
    expect(result.prompt).not.toContain("species.feature_group");
    expect(result.prompt).not.toContain("subject.");
    // A fact key's separator. The prompt is sentences; a slash in it means a key
    // got through by some route this test did not anticipate.
    expect(result.prompt).not.toContain("/");

    // The preserve instruction still SAYS something — the guard is not "emit
    // nothing", it is "emit the meaning". These are the facts an outfit change
    // must not touch, named as the things they are.
    expect(result.prompt).toContain("unchanged from the source");
    expect(result.prompt).toContain("the horns");
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import {
  registerImagePromptBinding,
  IMAGE_PROMPT_PROGRAM_META_KEY,
  IMAGE_WORLD_STATE_META_KEY,
  parseImagePromptProgramProvenance,
  parseImageWorldStateProvenance,
  type ImageRenderReference,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import {
  QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK,
  QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK_HAIR_CONCEALED,
} from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { expectDiagnostic } from "@/test/diagnostics";
import {
  LANE_PROBE_NAME,
  LANE_PROBE_SUBJECT_ID,
  laneProbeAvatarProgram,
  laneProbeVariantCut,
  laneProbeWardrobe,
  resolvedImageProfileFixture,
} from "@/server/test-support";
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
 * have their own owners. What this file owns is the question a lane asks the
 * seam and cannot ask anywhere else: WHICH row this render resolves, and what
 * the three possible answers do. These are the defects that question can carry,
 * none of which any other gate sees:
 *
 * - **A binding key that loses a dimension.** Five seeded profiles (Qwen Edit
 *   2511, Seedream 4.5, Seedream 5 Lite, Wan 2.7, SDXL PuLID) carry the profile
 *   key `variant-standard`, and every one of them is bound — so a key without
 *   the model slug hands all five the 2511 program: the wrong dialect, the
 *   wrong packs, and a Qwen-numbered identity lock on endpoints that number
 *   nothing. A key without the PROFILE key lets a second `variant` profile
 *   inherit a binding nobody wired it into. And the `nsfw_test` bench route
 *   replaces the MODEL while keeping the key, so resolution must run on the
 *   FINAL one; the three community checkpoints carry a `:version` pin in their
 *   slug, so resolution that failed to strip it would fail every render on them
 *   with nothing in the binding table showing why.
 * - **`unbound` degraded into `refused`.** Both fail a render, but they name
 *   different things: a refusal is a fault on a lane that IS bound, `unbound`
 *   is the row an operator has to add. The distinction still carries a
 *   fully-bound catalog: a profile added later, an operator-added model.
 * - **Prompt numbering taken from the caller's list.** The seam plans the
 *   references itself; a program numbered before planning says "Image 2" for the
 *   image the payload sends first, and hands the dialect the wrong reference
 *   count to pick its identity lock from. When planning genuinely renumbers, a
 *   numbering dialect REFUSES rather than shipping a prompt that names the wrong
 *   slot.
 * - **A second prompt channel beside the program.** The intent carries one
 *   prompt, and the transport sends the program's text as exactly that; a
 *   transport that grew a second channel would send something other than the
 *   program while the row stored the program — a disagreement nothing anywhere
 *   reports.
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
/**
 * A `:version` pin as a registry row stores one — every community checkpoint's
 * row carries one (drizzle 0104). It is a slug SHAPE resolution must survive,
 * and it rides the default editor here so the case exercises the strip and
 * nothing else: the shared fixture sends an identity reference, which the Qwen
 * dialect expresses and a face-input endpoint such as SDXL PuLID refuses as a
 * dropped mandatory claim.
 */
const PINNED_VERSION = "2ef4a1e6dbbd5b8f0d8f3cbbd3a1cbee0b1d4c0f6ee1c8ad5b7f2e0c9a3d4b1e";

/** A promoted (`active`) row, so resolution has something to answer. */
const PROMOTED_SLUG = "test-only/character-prompt-seam-promoted";
/** An `active` row whose bound pack versions are deliberately never registered. */
const PACKLESS_ACTIVE_SLUG = "test-only/character-prompt-seam-packless-active";
/** A `candidate` row — data awaiting promotion, which no lane may resolve. */
const PACKLESS_SLUG = "test-only/character-prompt-seam-packless";
const ABSENT_PACK = "pack-test-only-character-prompt-seam-absent-v1";

const INSTRUCTION = "wearing a floor-length wine-red silk kimono";
const REVISION = "2026-08-30T00:00:00.000Z";
const VARIANT_CUT = laneProbeVariantCut();

/**
 * One resolved variant profile. `policy` is the profile's reference policy,
 * which is what makes planning actually move or drop a reference.
 */
function programProfile(over: { slug: string; key?: string; policy?: unknown }): ResolvedImageProfile {
  return resolvedImageProfileFixture({
    slug: over.slug,
    task: "variant",
    key: over.key ?? VARIANT_KEY,
    ...(over.policy === undefined ? {} : { referencePolicy: over.policy }),
  });
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
 * The variant lane's own call, over the probe fixture. Tolerant of a lost
 * anchor by default so a case about resolution never trips over the cut; the
 * one case about the refusal flag passes it explicitly.
 */
function programInput(over: Partial<CharacterPromptProgramInput> = {}): CharacterPromptProgramInput {
  return {
    lane: "variant",
    task: "variant",
    profile: programProfile({ slug: QWEN_2511_SLUG }),
    bindingProfileKey: VARIANT_KEY,
    cuts: [
      {
        subjectId: LANE_PROBE_SUBJECT_ID,
        name: LANE_PROBE_NAME,
        digest: VARIANT_CUT.digest,
        attributes: VARIANT_CUT.resolved,
        exposure: VARIANT_CUT.exposure,
        hairOcclusion: VARIANT_CUT.hairOcclusion,
        realizedBody: VARIANT_CUT.realizedBody,
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
  for (const [id, modelSlug, status] of [
    ["binding-test-only-character-prompt-seam-packless-active-v1", PACKLESS_ACTIVE_SLUG, "active"],
    ["binding-test-only-character-prompt-seam-packless-v1", PACKLESS_SLUG, "candidate"],
  ] as const) {
    registerImagePromptBinding({
      id,
      profileKey: VARIANT_KEY,
      profileId: null,
      modelId: null,
      modelSlug,
      versionId: null,
      task: "variant",
      promptStrategy: "instruction_edit",
      promptDialectId: "qwen_2511_delta_edit",
      positivePackVersionId: ABSENT_PACK,
      negativePackVersionId: ABSENT_PACK,
      status,
    });
  }
});

// ---------------------------------------------------------------------------
// Which lane is cut over
// ---------------------------------------------------------------------------

describe("binding resolution through the seam", () => {
  /**
   * The binding key is (model slug, task, profile key), and every dimension
   * carries a real render. Every variant profile the picker offers is bound, so
   * the model dimension is testable POSITIVELY: five profiles share the key
   * `variant-standard`, and each must resolve its own endpoint's row. A key
   * that lost the slug would hand all five the 2511 program — the wrong
   * dialect, the wrong packs, and a Qwen-numbered identity lock on endpoints
   * that number nothing.
   */
  it.each([
    { name: "the default editor", slug: QWEN_2511_SLUG, binding: QWEN_2511_VARIANT_BINDING },
    {
      name: "another variant model on the same profile key",
      slug: "bytedance/seedream-4.5",
      binding: "binding-seedream-45-variant-variant-standard-instruction_edit-v1",
    },
    {
      // A registry row whose slug carries a `:version` pin — resolution strips
      // it, because a binding names an ENDPOINT and pinning a provider version
      // is `versionId`'s separate job. Every community checkpoint carries such a
      // pin, because the bare-slug endpoint is official-models-only, so without
      // the strip every render on any of them would answer `unbound` and fail
      // with nothing in the binding table showing why. The pin rides the
      // default editor so that only the strip is under test (`PINNED_VERSION`).
      name: "a version-pinned slug",
      slug: `${QWEN_2511_SLUG}:${PINNED_VERSION}`,
      binding: QWEN_2511_VARIANT_BINDING,
    },
  ])("resolves $name to its own endpoint's row", ({ slug, binding }) => {
    const input = programInput({ profile: programProfile({ slug }) });
    expect(compiled(buildCharacterPromptProgram(input)).binding.id).toBe(binding);
  });

  /**
   * `unbound` is a THIRD answer, never a refusal: it names the row an operator
   * has to add, where a refusal names a fault on a row that exists. It stays
   * reachable now that the catalog is fully bound: a second `variant` profile
   * added on a bound model later must not inherit a binding nobody wired it
   * into, and an operator-added model has no dialect at all. Only `active`
   * rows resolve — a `candidate` row is data awaiting promotion, not a lane.
   */
  it.each([
    { name: "a profile key no row carries on the bound model", slug: QWEN_2511_SLUG, key: "variant-experimental" },
    { name: "a model with no binding at all", slug: "test-only/character-prompt-seam-absent", key: VARIANT_KEY },
    { name: "a model whose only row is still a candidate", slug: PACKLESS_SLUG, key: VARIANT_KEY },
  ])("resolves unbound, not refused, for $name", ({ slug, key }) => {
    const input = programInput({ profile: programProfile({ slug, key }), bindingProfileKey: key });
    expect(buildCharacterPromptProgram(input)).toEqual({
      kind: "unbound",
      modelSlug: slug,
      task: "variant",
      profileKey: key,
    });
  });

  /**
   * `refuseOnMissingRequired` is a task decision, not a compile input: over an
   * intact cut the seam compiles the SAME program whichever way a lane sets it,
   * so a bench that compiles tolerantly reads exactly the prompt the lane would
   * send. Kills a flag-aware branch through the seam (a different budget, a
   * skipped planning step) that would let the two answers drift apart.
   *
   * The same call is what lands provenance on the image row, so the meta keys
   * and their parsers are asserted here rather than in a test of their own.
   */
  it("compiles the same program whichever way the refusal flag is set, with parseable provenance", () => {
    const profile = programProfile({ slug: PROMOTED_SLUG });
    const tolerant = compiled(buildCharacterPromptProgram(programInput({ profile })));
    const strict = compiled(buildCharacterPromptProgram(programInput({ profile, refuseOnMissingRequired: true })));
    expect(strict).toEqual(tolerant);

    expect(Object.keys(strict.meta).sort()).toEqual([IMAGE_PROMPT_PROGRAM_META_KEY, IMAGE_WORLD_STATE_META_KEY].sort());
    expect(parseImagePromptProgramProvenance(strict.meta[IMAGE_PROMPT_PROGRAM_META_KEY])).not.toBeNull();
    expect(parseImageWorldStateProvenance(strict.meta[IMAGE_WORLD_STATE_META_KEY])).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What the bound lane compiles
// ---------------------------------------------------------------------------

describe("compiling a bound lane", () => {
  /**
   * The identity-critical lane's fail-closed rule. On the SAME degraded cut —
   * a subject whose mandatory anchor never reached the digest — a lane that
   * refuses fails before provider spend, while a bench that compiles through
   * the loss can read it off the result. Kills a seam that hard-codes the flag
   * either way: a production render would be a stranger with the character's
   * outfit and the row would look successful, or a bench could never measure
   * the loss it exists to report.
   */
  it("refuses a lost mandatory anchor when asked to, and reports it when compiling through", () => {
    const [intact] = programInput().cuts;
    if (intact === undefined) throw new Error("the probe fixture compiles no cut");
    const cuts = [
      {
        ...intact,
        digest: {
          ...VARIANT_CUT.digest,
          subjects: VARIANT_CUT.digest.subjects.map((subject) => ({
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
   * A configuration gap on a lane that IS bound is a refusal, never `unbound`:
   * the row exists, and reporting it as "add a row" would send an operator to
   * add a second one beside the broken pin. The code is what a lane's failed
   * row carries, so the seam has to emit it.
   */
  it("refuses a binding whose pack versions are not registered", () => {
    const sink = new DiagnosticCollector();
    const result = buildCharacterPromptProgram(
      programInput({ profile: programProfile({ slug: PACKLESS_ACTIVE_SLUG }), sink }),
    );
    expect(result).toMatchObject({ kind: "refused", code: IMAGE_CHARACTER_PROMPT_PACK_MISSING });
    expectDiagnostic(sink, IMAGE_CHARACTER_PROMPT_PACK_MISSING);
  });
});

// ---------------------------------------------------------------------------
// What the variant render actually sends
// ---------------------------------------------------------------------------

/**
 * `characterPromptTransport` (`character-prompt-program.ts`) decides the prompt
 * channels together, for every character lane at once — the avatar, the
 * variant, the chat-look mint and each scene rung. It is pinned here rather
 * than in an integration suite because the failure is silent and the function
 * is pure: the intent carries one prompt channel, and a transport that grew a
 * second would send something other than the program while the row recorded
 * the program — a provider seeing one prompt and an operator reading another,
 * with nothing reporting the disagreement. The `controls` half kills an
 * invented `negativePrompt: ""` on the Qwen endpoints, which expose no negative
 * field at all.
 */
describe("characterPromptTransport", () => {
  it.each([
    {
      name: "a compiled render carries its prompt and nothing else",
      program: { prompt: "compiled", negativePrompt: null },
      keys: ["prompt"],
      negative: null,
    },
    {
      name: "an empty compiled negative invents no control",
      program: { prompt: "compiled", negativePrompt: "" },
      keys: ["prompt"],
      negative: null,
    },
    {
      name: "a non-empty compiled negative rides the normalized control",
      program: { prompt: "compiled", negativePrompt: "no watermark" },
      keys: ["controls", "prompt"],
      negative: "no watermark",
    },
  ])("$name", ({ program, keys, negative }) => {
    const transport = characterPromptTransport(program);
    // The KEY set, not just the values: the whole defect is a second prompt
    // channel (or an invented `controls`) beside the compiled prompt.
    expect(Object.keys(transport).sort()).toEqual(keys);
    expect(transport.prompt).toBe("compiled");
    expect(transport.controls?.negativePrompt ?? null).toBe(negative);
  });
});


/**
 * THE TWO PROVIDER-FACING LAWS OF A CHARACTER RENDER, taken end to end from the
 * real variant cut rather than from a hand-built digest — because both defects
 * these kill were invisible to every fixture that started from one.
 */
describe("what a variant render actually sends", () => {
  const program = (): CharacterPromptProgram => compiled(buildCharacterPromptProgram(programInput()));

  it("reinforces the shared canonical platinum hair and blue eyes beside the identity reference", () => {
    const result = program();

    expect(result.prompt).toMatch(/hair color: platinum/i);
    expect(result.prompt).toMatch(/eye color: blue/i);
  });

  /**
   * The identity lock must come from the WORLD.
   *
   * The digest of an edit lane states no identity descriptors — the reference
   * image shows the face — and the endpoint dialects emit their lock from a
   * `subject.identity` claim. Before the anchor existed, that claim never
   * appeared for this lane, so a compiled variant carried no identity
   * protection at all, and nothing reported it. A program that lost the anchor
   * again would ship an identity-critical edit with nothing telling the model
   * to keep the face — and now with no other sentence anywhere to say so.
   *
   * Byte-exact, because "means the same" is the defect: the dialect is the one
   * source of the family's lock wording, and a paraphrase here would be a
   * change of instruction to every Qwen edit with nothing reporting it.
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
    // neutral truth and the dialect owns the endpoint's sentence — neither the
    // Qwen lock's nor the prose family's.
    expect(anchors[0]?.value).not.toContain("Preserve the exact face");
    expect(JSON.stringify(result.subjects)).not.toContain("Preserve face, hair color and style");

    // …and the dialect turns it into the endpoint's own bytes, once.
    expect(result.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(result.prompt.indexOf(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK)).toBe(
      result.prompt.lastIndexOf(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK),
    );
    expect(result.prompt).not.toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);

    // The lock preserves a likeness; the age anchor beside it is the lane's
    // own text-authoritative claim (`CHARACTER_LANE_APPARENT_AGE.variant`), and
    // a reference-edit that lost it would preserve the model's over-estimate.
    expect(result.prompt).toContain(`${LANE_PROBE_NAME} appears in the late twenties.`);
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

/**
 * HAIR THE HEADWEAR FULLY HIDES (docs/images/character-prompts.md §Hair the
 * headwear conceals), through the shared seam rather than per route.
 *
 * The withholding itself is the character adapter's and is proved there
 * (`contracts/images/subject-digest.test.ts`); what this owns is the WIRING:
 * the band a lane resolved onto its cut reaches the projection through
 * `castAssembly`, so a `full` cut compiles to the concealment sentence and a
 * `partial` one compiles exactly as before. Falsified against the state the
 * band's carrier left every prompt in — every lane populated `hairOcclusion`
 * and nothing read it. The avatar lane is the probe; every other lane hands the
 * same cut shape to the same fold.
 */
describe("hair the headwear fully hides", () => {
  const HIJAB = { name: "hijab", coverage: ["hair", "ears"], layer: 2, opacity: "opaque" } as const;
  const CONCEALED = `${LANE_PROBE_NAME}'s hair is fully covered by the headwear; no hair is visible.`;

  it.each([
    ["full", true],
    ["partial", false],
  ] as const)("compiles a `%s` cut with the concealment stated: %s", (band, stated) => {
    const program = compiled(laneProbeAvatarProgram({ wardrobe: [{ ...HIJAB, hairOcclusion: band }] }));
    expect(program.prompt.includes(CONCEALED)).toBe(stated);
    const concealment = program.subjects
      .flatMap((subject) => subject.facts)
      .find((fact) => fact.concept === "subject.hair_concealment");
    expect(concealment !== undefined).toBe(stated);
    if (concealment !== undefined) {
      // Required and kept: no budget squeeze may re-expose what the wardrobe hides.
      expect(concealment.disposition).toBe("required_visual");
      expect(program.keptClaimIds).toContain(concealment.key);
    }
    expect(program.missingRequired).toEqual([]);
  });

  /**
   * A reference-anchored render must not ask the model to restore hair the
   * headwear hides (issue #312). The lock is the family's own bytes, so the
   * band reaches it through the compiled claim set rather than a second
   * channel: at `full` the lock drops "hair" and keeps every other cue, at
   * `partial` the measured lock ships untouched. Falsified against the lock
   * that named hair on every render — a hijab-wearing edit from a bare-headed
   * reference then preserved the reference's hair over the hijab.
   */
  it.each([
    ["full", QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK_HAIR_CONCEALED, QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK],
    ["partial", QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK, QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK_HAIR_CONCEALED],
  ] as const)("locks a `%s` cut to its reference without the hair it cannot show", (band, lock, other) => {
    const cut = laneProbeVariantCut([...laneProbeWardrobe(), { ...HIJAB, hairOcclusion: band }]);
    expect(cut.hairOcclusion).toBe(band);
    const program = compiled(
      buildCharacterPromptProgram(
        programInput({
          cuts: [
            {
              subjectId: LANE_PROBE_SUBJECT_ID,
              name: LANE_PROBE_NAME,
              digest: cut.digest,
              attributes: cut.resolved,
              exposure: cut.exposure,
              hairOcclusion: cut.hairOcclusion,
              realizedBody: cut.realizedBody,
            },
          ],
        }),
      ),
    );
    expect(program.prompt).toContain(lock);
    expect(program.prompt).not.toContain(other);
    if (band === "full") expect(program.prompt).not.toMatch(/[Pp]reserve[^.]*\bhair\b/);
  });
});

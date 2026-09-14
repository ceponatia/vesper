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
  QWEN_2511_APPEARANCE_MOVED_NOTICE,
  QWEN_2511_GROUPED_REFERENCE_CURRENT_LOOK_LOCK,
  QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_2511_SINGLE_REFERENCE_CURRENT_LOOK_LOCK,
  QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK,
  QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK_HAIR_CONCEALED,
} from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { APPEARANCE_REVISION_META_KEY, appearanceRevisionOf } from "@/contracts/images/appearance-revision";
import { IMAGE_CHARACTER_APPEARANCE_REFERENCE_REDUNDANT } from "@/contracts/images/character-adapter";
import { characterSceneImageOperation } from "@/contracts/images/character-digest";
import { expectDiagnostic } from "@/test/diagnostics";
import {
  attr,
  LANE_PROBE_NAME,
  LANE_PROBE_SECOND_NAME,
  LANE_PROBE_SECOND_SUBJECT_ID,
  LANE_PROBE_SUBJECT_ID,
  laneProbeAvatarProgram,
  laneProbeCastScenePlan,
  laneProbeCastSubjects,
  laneProbeProfile,
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
import { applySceneCastVisual } from "./scene-subject-visual";

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
/** The seeded scene profile key this endpoint carries a bound row for (`packs-qwen-2511.ts`). */
const SCENE_KEY = "scene-standard";
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

    // The appearance-revision stamp rides beside the two provenance keys on
    // every character render, so a reference read back later can compare it.
    expect(Object.keys(strict.meta).sort()).toEqual(
      [IMAGE_PROMPT_PROGRAM_META_KEY, IMAGE_WORLD_STATE_META_KEY, APPEARANCE_REVISION_META_KEY].sort(),
    );
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
    // One identity image and one cast member is the dialect's SOLE binding, and
    // that is where an identity slot's number now lives (#544 F2): "Image 1
    // shows Nyx." beside "Use Nyx in Image 1 …" was two sentences saying one
    // thing. What this owns is the NUMBER, not the sentence carrying it.
    expect(trimmed.prompt).toContain(`Use ${LANE_PROBE_NAME} in Image 1 as the sole subject;`);
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

    // The registry's PROSE, not its label form (#547): an image-eligible
    // attribute that declares a phrase reaches every dialect as the noun
    // phrase it was authored as.
    expect(result.prompt).toMatch(/platinum hair/i);
    expect(result.prompt).toMatch(/blue eyes/i);
  });

  /**
   * ISSUE #450 checklist item 2: the 2511 identity reference is authoritative
   * for FACE and skin tone (docs/images/character-prompts.md §Identity on a
   * reference-anchored render), so the probe sheet's oval `face.shape` — an
   * OPTIONAL reinforcement the reference already shows pixel-perfect once a
   * subject is reference-anchored — is dropped as redundant, while the SAME
   * dialect leaves hair, build, wardrobe and pose text-authoritative: the
   * platinum hair the sibling test above pins, and the requested outfit
   * change this render IS, both still compile untouched.
   */
  it("drops the redundant face-shape reinforcement a reference-authoritative face already shows, without losing text-controlled hair or the requested change", () => {
    const result = program();

    // The documented redundant fact: never reaches the prompt once the
    // subject is anchored to a 2511 identity reference.
    expect(result.prompt).not.toMatch(/\boval\b/i);

    // Recorded as a suppression with its OWN reason — distinguishable from an
    // out-of-frame or hidden judgment, and from a fitter's drop.
    const suppressions =
      parseImageWorldStateProvenance(result.meta[IMAGE_WORLD_STATE_META_KEY])?.suppressions ?? [];
    const redundant = suppressions.filter(
      (entry) => entry.reason === IMAGE_CHARACTER_APPEARANCE_REFERENCE_REDUNDANT,
    );
    expect(redundant.some((entry) => entry.key.endsWith("appearance.face.shape"))).toBe(true);

    // Text-controlled facts on this dialect are UNTOUCHED: hair stays
    // reinforced (the sibling test's own claim, restated here beside the
    // fact it must not be confused with)…
    expect(result.prompt).toMatch(/platinum hair/i);
    // …and so is the requested change itself.
    expect(result.prompt).toContain(`Make exactly this change: ${INSTRUCTION}`);
  });

  /**
   * ISSUE #450 checklist item 4: several identity references of ONE person
   * are several VIEWS of that one subject, never several people. The
   * request-aware selection reads the same per-subject anchored set the
   * digest's own identity anchor already uses (`referenceAnchoredSubjects`, a
   * Set keyed on subject ref) — so a second image of the same person costs
   * this policy nothing extra: still one subject, the redundant fact
   * suppressed exactly once, never once per reference.
   */
  it("keeps several identity references of one person bound to that one subject, not two", () => {
    const result = compiled(
      buildCharacterPromptProgram(programInput({ references: [reference("identity"), reference("identity")] })),
    );

    // Still ONE subject and ONE identity anchor, whichever way the references
    // arrived — several views, never several people.
    expect(result.subjects).toHaveLength(1);
    const anchors = result.subjects
      .flatMap((subject) => subject.facts)
      .filter((fact) => fact.concept === "subject.identity");
    expect(anchors).toHaveLength(1);
    // Both images still travel to the provider — a view, not a drop.
    expect(result.sentReferences).toHaveLength(2);

    // The redundant face-shape fact is suppressed exactly once for the one
    // subject it names.
    const suppressions =
      parseImageWorldStateProvenance(result.meta[IMAGE_WORLD_STATE_META_KEY])?.suppressions ?? [];
    const redundant = suppressions.filter(
      (entry) =>
        entry.reason === IMAGE_CHARACTER_APPEARANCE_REFERENCE_REDUNDANT &&
        entry.key.endsWith("appearance.face.shape"),
    );
    expect(redundant).toHaveLength(1);
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
    // Said in the subject's own pronoun: the binding above introduced her by
    // name and every later sentence refers back to it (#544 F2).
    expect(result.prompt).toContain("She appears in the late twenties.");
    expect(result.prompt).not.toContain(`${LANE_PROBE_NAME} appears`);
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
  /** The avatar lane's sentence: 2512, no identity reference, so the subject is named. */
  const CONCEALED = `${LANE_PROBE_NAME}'s hair is fully covered by the headwear; no hair is visible.`;
  /**
   * The variant lane's: 2511 with the subject's own identity image, so the
   * binding introduces her once and this refers back by pronoun (#544 F2).
   */
  const VARIANT_CONCEALED = "Her hair is fully covered by the headwear; no hair is visible.";

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
   * headwear hides (issue #312) — now because the binding never claims hair.
   *
   * The 2511 preserve set is the honest one after #544 F4: the photograph
   * carries the face, the skin tone and the apparent age, and the TEXT is
   * authoritative for hair, build, wardrobe and pose. So there is no longer a
   * hair-concealed SPELLING of the binding to switch to — the two exported names
   * are the same bytes, asserted here because a test reading them as two
   * wordings would be pinning a distinction the endpoint no longer makes — and
   * one binding ships at either band. What keeps the reference's hair off a
   * covered head is the concealment sentence, stated at `full` and nowhere else.
   *
   * The concealment is worded through the subject's own voice: this lane names
   * her once in the binding and refers back by pronoun, so a name here would be
   * the repetition F2 removed. Falsified against the lock that named hair on
   * every render — a hijab-wearing edit from a bare-headed reference then
   * preserved the reference's hair over the hijab — and against the cheap fix of
   * deleting the concealment sentence.
   */
  it.each([
    ["full", true],
    ["partial", false],
  ] as const)("locks a `%s` cut to its reference and never asks for the hair back", (band, concealed) => {
    expect(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK_HAIR_CONCEALED).toBe(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
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
    expect(program.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    // Nothing anywhere in the instruction asks for hair to be kept from the image.
    expect(program.prompt).not.toMatch(/\bkeep\b[^.]*\bhair\b/i);
    expect(program.prompt).not.toMatch(/[Pp]reserve[^.]*\bhair\b/);
    expect(program.prompt.includes(VARIANT_CONCEALED)).toBe(concealed);
  });

  /**
   * A CURRENT reference does not give the binding its hair back when the
   * headwear hides it (issue #551, the #312 invariant arriving from the other
   * direction).
   *
   * The appearance revision digests attributes; hair occlusion is wardrobe. So
   * a character who has not changed an inch since her anchor was minted, now in
   * a hijab, compares `matches` on the honest reading of the stamp — and the
   * wider preserve clause would then ask the model to keep her hair "exactly as
   * shown" in the same prompt as the sentence saying no hair is visible, over
   * text the selection has already dropped. That is the #544 F4 ambiguity the
   * lock was narrowed to end, and it is invisible in the output: the render
   * simply paints hair through the headwear.
   *
   * The seam downgrades a `full`-band subject to `unknown` before the verdict
   * is spent, so BOTH halves move together — the ordinary lock and the
   * concealment sentence, which is exactly what the band compiled before this
   * contract existed. Falsified against the stamp being honoured at `full`.
   */
  it("never takes the wider preserve set for a covered head, however current the reference is", () => {
    const cut = laneProbeVariantCut([...laneProbeWardrobe(), { ...HIJAB, hairOcclusion: "full" }]);
    expect(cut.hairOcclusion).toBe("full");
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
          // The reference depicts EXACTLY this cut's appearance: on the stamp
          // alone this is the `matches` case.
          references: [{ ...reference("identity"), appearanceRevision: appearanceRevisionOf(cut.resolved) }],
        }),
      ),
    );

    expect(program.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(program.prompt).not.toContain(QWEN_2511_SINGLE_REFERENCE_CURRENT_LOOK_LOCK);
    // The one assertion the defect fails: nothing asks for hair back.
    expect(program.prompt).not.toMatch(/\bkeep\b[^.]*\bhair\b/i);
    expect(program.prompt).toContain(VARIANT_CONCEALED);
    // And no appearance-moved correction either — nothing about her HAS moved.
    expect(program.prompt).not.toContain(QWEN_2511_APPEARANCE_MOVED_NOTICE);
    const references = parseImagePromptProgramProvenance(program.meta[IMAGE_PROMPT_PROGRAM_META_KEY])?.references ?? [];
    expect(references.map((entry) => entry.preservation)).toEqual(["unknown"]);
  });

  /**
   * ISSUE #450 checklist item 5: a fact the existing projection already
   * suppressed — here, hair the headwear fully hides — cannot re-enter
   * through the new request-aware selection. The withholding happens before
   * this policy ever runs, so the concealed hair facts never reach
   * `subject.facts` for it to consider; this pins that the suppression stays
   * recorded under its OWN reason and is never relabelled as reference
   * redundancy.
   */
  it("does not let request-aware selection recover hair the headwear already concealed", () => {
    const cut = laneProbeVariantCut([...laneProbeWardrobe(), { ...HIJAB, hairOcclusion: "full" }]);
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

    expect(program.prompt).not.toMatch(/platinum/i);
    const suppressions =
      parseImageWorldStateProvenance(program.meta[IMAGE_WORLD_STATE_META_KEY])?.suppressions ?? [];
    const hairSuppressions = suppressions.filter((entry) => entry.key.includes("hair"));
    expect(hairSuppressions.length).toBeGreaterThan(0);
    for (const entry of hairSuppressions) {
      expect(entry.reason).not.toBe(IMAGE_CHARACTER_APPEARANCE_REFERENCE_REDUNDANT);
    }
  });
});

/**
 * WHO THE PROMPT NAMES (issue #544 F2) — the seam's second lane policy, beside
 * the apparent-age one and settable by no caller.
 *
 * The display name reaches a compiled prompt through exactly one field: the
 * label this module folds out of each cut. On a lane sending an identity
 * reference of that person, the name is a SECOND identity cue in the same
 * prompt as the photograph — and on the fictional-celebrity workflow it is a
 * real person's name standing beside a picture of somebody else, restated once
 * per claim. The scene lane therefore offers no label for a subject the payload
 * actually carries an image of, and the dialect introduces them by that image.
 *
 * Three things this pins, none of which any other gate sees:
 *
 * 1. **The anchored subject is unnamed on a scene.** Falsified against the
 *    unconditional `labels[cut.subjectId] = cut.name` this replaced.
 * 2. **The unanchored one is not.** The policy keys on whether a REQUIRED
 *    identity reference in the planned send list shows this person — the same
 *    predicate the digest's own identity anchor is synthesized under — never on
 *    whether the payload has references at all. The scene ladder's
 *    single-reference rung sends one surviving identity image for a cast of two,
 *    and a cast member with no image of their own has nothing to be introduced
 *    by; blanking their name too would leave the prompt unable to tell the two
 *    people apart.
 * 3. **No other lane moves.** The variant lane sends the same shape of
 *    reference for the same person and keeps the name.
 */
describe("the lane's subject-naming policy", () => {
  /** The bound scene endpoint, so a scene program compiles rather than answering `unbound`. */
  const sceneProfile = (): ResolvedImageProfile =>
    resolvedImageProfileFixture({ slug: QWEN_2511_SLUG, task: "scene", key: SCENE_KEY });

  /**
   * A two-person scene through the production seams, with `referenced` deciding
   * which cast members get an identity image of their own — the scene ladder's
   * single-reference rung, where the answer differs per person.
   */
  function sceneProgram(referenced: (subjectId: string) => boolean): CharacterPromptProgram {
    const members = laneProbeCastSubjects();
    const plan = laneProbeCastScenePlan(members.map((subject) => subject.member));
    const built = applySceneCastVisual({ plan, members });
    expect(built.refusal).toBeNull();
    return compiled(
      buildCharacterPromptProgram({
        lane: "scene",
        task: "scene",
        profile: sceneProfile(),
        bindingProfileKey: SCENE_KEY,
        bindingStrategy: "instruction_edit",
        cuts: built.visuals.map((slice) => ({
          subjectId: slice.subjectId,
          name: slice.name,
          digest: slice.digest,
          attributes: slice.attributes,
          exposure: slice.exposure,
          hairOcclusion: slice.hairOcclusion,
          realizedBody: slice.realizedBody,
        })),
        read: { kind: "committed_cut", token: built.visuals[0]?.cutId ?? "" },
        references: built.visuals
          .filter((slice) => referenced(slice.subjectId))
          .map((slice): CharacterPromptReference => ({
            reference: { role: "identity", buffer: Buffer.from(slice.subjectId), name: slice.name },
            subjectId: slice.subjectId,
          })),
        operation: () => characterSceneImageOperation({ subjectCount: built.visuals.length, kind: "edit" }),
        refuseOnMissingRequired: true,
      }),
    );
  }

  const labelOf = (program: CharacterPromptProgram, subjectId: string): string | undefined =>
    program.subjects.find((subject) => subject.entityId === subjectId)?.label;

  it("offers no display name for a scene subject the payload carries an identity image of", () => {
    const program = sceneProgram(() => true);

    expect(labelOf(program, LANE_PROBE_SUBJECT_ID)).not.toBe(LANE_PROBE_NAME);
    expect(labelOf(program, LANE_PROBE_SECOND_SUBJECT_ID)).not.toBe(LANE_PROBE_SECOND_NAME);
    // The whole point, at the boundary the model reads: neither name is in the
    // text sent beside their photographs.
    expect(program.prompt).not.toContain(LANE_PROBE_NAME);
    expect(program.prompt).not.toContain(LANE_PROBE_SECOND_NAME);
  });

  it("keeps the display name of a scene subject no identity reference shows", () => {
    // Only the bystander is referenced — the single-reference rung's shape, and
    // the one where the two cast members must be answered differently.
    const program = sceneProgram((subjectId) => subjectId !== LANE_PROBE_SUBJECT_ID);

    expect(labelOf(program, LANE_PROBE_SUBJECT_ID)).toBe(LANE_PROBE_NAME);
    expect(labelOf(program, LANE_PROBE_SECOND_SUBJECT_ID)).not.toBe(LANE_PROBE_SECOND_NAME);
    expect(program.prompt).toContain(LANE_PROBE_NAME);
    expect(program.prompt).not.toContain(LANE_PROBE_SECOND_NAME);

    // …and the binding says so at the boundary the model reads (PR #545 review):
    // the one photograph binds the one person it shows, and the cast member with
    // no image of their own is named as having none. The several-people form
    // would promise to keep "each person's face … as their own image shows"
    // about somebody the payload carries nothing of; the sole-subject form would
    // claim the whole picture for one of two people. The dialect owns both
    // wordings and pins them
    // (`packages/image-core/src/prompt-program/prompt-program.test.ts`); what
    // this owns is that the production seam hands it this cast.
    expect(program.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(program.prompt).not.toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
    expect(program.prompt).toContain(`${LANE_PROBE_NAME} has no reference image and is described below.`);
    expect(program.prompt.toLowerCase()).not.toContain("sole subject");
  });

  it("names the subject on every other lane, reference and all", () => {
    // The same person, the same identity reference, the variant lane's own call.
    const program = compiled(buildCharacterPromptProgram(programInput()));

    expect(labelOf(program, LANE_PROBE_SUBJECT_ID)).toBe(LANE_PROBE_NAME);
    expect(program.prompt).toContain(LANE_PROBE_NAME);
  });

  /**
   * ISSUE #450 checklist item 3: a mixed ensemble decides separately PER
   * SUBJECT. This rung's only identity image is Ilsa's, so her
   * reference-authoritative face shape and skin tone are redundant and
   * dropped, while Nyx — the unreferenced bystander, never in
   * `anchoredSubjects` — keeps the full reference-free description a render
   * of her still needs. The two fixtures' disjoint words
   * (`image-lane-probe.ts`'s module header) are what let this be checked
   * without a per-subject parser: "heart-shaped" and "ashen" can only be
   * Ilsa's, "oval" and "brown" only Nyx's.
   */
  it("selects reference-aware detail per subject in a mixed ensemble, never for the whole cast", () => {
    const program = sceneProgram((subjectId) => subjectId !== LANE_PROBE_SUBJECT_ID);

    // Ilsa (referenced): her face shape and skin tone are redundant against
    // her own reference and do not reach the prompt.
    expect(program.prompt).not.toMatch(/heart-shaped/i);
    expect(program.prompt).not.toMatch(/\bashen\b/i);

    // Nyx (unreferenced): the same two facts are still reference-free-required
    // for HER render and remain stated.
    expect(program.prompt).toMatch(/\boval\b/i);
    expect(program.prompt).toMatch(/\bbrown\b/i);

    const suppressions =
      parseImageWorldStateProvenance(program.meta[IMAGE_WORLD_STATE_META_KEY])?.suppressions ?? [];
    const redundant = suppressions.filter(
      (entry) => entry.reason === IMAGE_CHARACTER_APPEARANCE_REFERENCE_REDUNDANT,
    );
    const nyxRedundant = redundant.filter((entry) => entry.key.startsWith(`subject.${LANE_PROBE_SUBJECT_ID}.appearance`));
    const ilsaRedundant = redundant.filter((entry) =>
      entry.key.startsWith(`subject.${LANE_PROBE_SECOND_SUBJECT_ID}.appearance`),
    );
    expect(ilsaRedundant.length).toBeGreaterThan(0);
    expect(nyxRedundant).toEqual([]);
  });
});

/**
 * WHAT THE LANES BESIDE THE SCENE STILL STATE (issue #552).
 *
 * The reveal-tier and naming work landed in the scene lane, and the scene lane
 * is where every assertion about it was written. Three other lanes compile
 * through this same seam, and each of them is a render OF a person the prompt
 * has to be able to talk about — so the claims below are the ones a scene-shaped
 * edit is most likely to take away from them by accident. Each `it` names the
 * claim it protects; the chat-look lane's own half lives with its mint
 * (`chat-look.test.ts`), which is the only place that assembles it.
 */
describe("the lanes beside the scene", () => {
  /** The variant lane's program, over the shared probe cut. */
  const variantProgram = (over: Partial<CharacterPromptProgramInput> = {}): CharacterPromptProgram =>
    compiled(buildCharacterPromptProgram(programInput(over)));

  /**
   * PROTECTS: the portrait names its subject and states their apparent age.
   *
   * Both are lane-table answers no caller may set — `CHARACTER_LANE_SUBJECT_NAMING
   * .avatar` is `label` and `CHARACTER_LANE_APPARENT_AGE.avatar` is `state` — and
   * both were changed for the scene in the same commit. A portrait has no
   * reference to inherit an age from and no image to be introduced by, so a lane
   * table edited one row too far leaves a text-to-image render with no age
   * anchor and nobody named in it.
   */
  it("names the avatar lane's subject and states their apparent age on 2512", () => {
    const program = compiled(laneProbeAvatarProgram({ wardrobe: laneProbeWardrobe() }));

    expect(program.prompt).toContain(`${LANE_PROBE_NAME} appears`);
    expect(program.prompt).toMatch(/late twenties/);
  });

  /**
   * ISSUE #450 checklist item 1: a reference-free render carries no identity
   * reference, so it is never in `anchoredSubjects` and the request-aware
   * selection this issue adds must be a complete no-op for it — #426's
   * reference-free completeness rules, unchanged. Kills a selection that
   * applied a dialect's reference authority regardless of whether a reference
   * was actually sent.
   */
  it("keeps a reference-free portrait's applicable required core description, and still refuses a missing one", () => {
    const full = compiled(laneProbeAvatarProgram({ wardrobe: laneProbeWardrobe() }));

    // No identity reference exists on this lane: every reference-free-required
    // core value stays stated exactly as #426 requires, INCLUDING the face
    // shape and skin tone a reference-anchored render would treat as
    // redundant (the sibling variant-lane test below).
    expect(full.prompt).toMatch(/\boval\b/i);
    expect(full.prompt).toMatch(/platinum hair/i);
    expect(full.prompt).toMatch(/blue eyes/i);
    expect(full.missingRequired).toEqual([]);

    // Strip one required core value this suite otherwise always supplies. The
    // avatar lane refuses on it exactly as before this change — a
    // reference-free subject was never a candidate for the new selection step.
    const withoutFaceShape = laneProbeProfile({
      attributes: laneProbeProfile().attributes.filter((value) => value.id !== "face.shape"),
    });
    const degraded = laneProbeAvatarProgram({ profile: withoutFaceShape, wardrobe: laneProbeWardrobe() });
    expect(degraded.kind).toBe("refused");
  });

  /**
   * PROTECTS: a variant edit names its subject and carries the change contract.
   *
   * The scene rung deliberately carries NO change contract — its description is
   * the instruction — and offers no display name. A variant is the opposite on
   * both counts: it is one edit of one named person, and without the delta and
   * its preserve set the endpoint is handed a description of somebody and no
   * instruction about what to do to them.
   */
  it("names the variant lane's subject and carries the change contract on 2511", () => {
    const program = variantProgram();

    expect(program.prompt).toContain(LANE_PROBE_NAME);
    expect(program.prompt).toContain(`Make exactly this change: ${INSTRUCTION}`);
    expect(program.prompt).toMatch(/\bKeep\b[^.]*\bunchanged from the source\./);
  });

  /**
   * PROTECTS: a covered torso states the silhouette and no surface detail.
   *
   * `breasts.size` is the one intimate fact an ordinary render may state — the
   * declared `ordinarySilhouette` exception, because a size reads through
   * clothing — while `breasts.shape`, `breasts.augmentation` and
   * `breasts.fullness` are surface facts a sweater hides. The three moved to the
   * `skin` reveal tier and nothing outside the scene lane exercised them, so
   * this is the regression a tier revert produces: a clothed portrait describing
   * a body the picture does not contain.
   *
   * The control is the same three facts on a BARE torso through a route that
   * permits intimate anatomy — they are stateable, authored and reachable, so
   * the absence above is the coverage rule and not an empty fixture.
   */
  describe("breast detail a covered torso cannot show", () => {
    /** The probe sheet plus the three re-tiered surface facts, in disjoint words. */
    const SURFACE = laneProbeProfile({
      attributes: [
        ...laneProbeProfile().attributes,
        attr("breasts.shape", "teardrop", "base"),
        attr("breasts.augmentation", "obviously_augmented", "base"),
        attr("breasts.fullness", "plump", "base"),
      ],
    });

    /** One variant program over the probe sheet, dressed or bare, by route. */
    const variant = (
      wardrobe: ReturnType<typeof laneProbeWardrobe>,
      intimateReveal: boolean,
    ): CharacterPromptProgram => {
      const cut = laneProbeVariantCut(wardrobe, SURFACE);
      return variantProgram({
        intimateReveal,
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
      });
    };

    /** The avatar lane's own program over the same sheet, dressed. */
    const avatar = (): CharacterPromptProgram =>
      compiled(laneProbeAvatarProgram({ profile: SURFACE, wardrobe: laneProbeWardrobe() }));

    const SURFACE_WORDS = [/teardrop/i, /augment/i, /plump/i];

    it.each([
      ["the avatar lane on 2512", avatar],
      ["the variant lane on 2511", () => variant(laneProbeWardrobe(), false)],
      ["a variant on a route that permits intimate anatomy", () => variant(laneProbeWardrobe(), true)],
    ] as const)("states the breast size and no surface detail in %s", (_lane, build) => {
      const program = build();

      expect(program.prompt).toMatch(/an ample bust/i);
      for (const word of SURFACE_WORDS) expect(program.prompt).not.toMatch(word);
    });

    it("states all three on a bare torso through a permitting route — the control", () => {
      const program = variant([], true);

      expect(program.prompt).toMatch(/an ample bust/i);
      for (const word of SURFACE_WORDS) expect(program.prompt).toMatch(word);
    });
  });
});

/**
 * THE QWEN PROMPT BUDGET, AT THE SEAM (issue #552).
 *
 * `recommendedChars: 1300` is a Vesper advisory the migration writes onto the
 * two Qwen rows, and the seam is the one place a row's number becomes a fitting
 * decision (`imagePromptBudgetFromBinding` over
 * `profile.model.advancedCapabilities.prompt`). The fitter's own two-phase rule
 * has its owner in `packages/image-core`; what no test anywhere covered is that
 * this seam passes the row's number through as an ADVISORY — a limit that eats
 * optional claims and never touches the sentences a variant edit IS.
 *
 * The binding is built in the fixture. Nothing here reads a database row: the
 * number under test is data an operator curates, and a suite that loaded it
 * would be testing the migration instead of the seam.
 */
describe("the prompt budget the seam fits a variant edit to", () => {
  /** The variant profile with a prompt binding declaring `recommendedChars`, or none at all. */
  const budgeted = (recommendedChars?: number): ResolvedImageProfile => {
    const base = programProfile({ slug: QWEN_2511_SLUG });
    return {
      ...base,
      model: {
        ...base.model,
        advancedCapabilities: {
          ...base.model.advancedCapabilities,
          prompt: { field: "prompt", ...(recommendedChars === undefined ? {} : { recommendedChars }) },
        },
      },
    };
  };

  const program = (recommendedChars?: number): CharacterPromptProgram =>
    compiled(buildCharacterPromptProgram(programInput({ profile: budgeted(recommendedChars) })));

  const dropped = (result: CharacterPromptProgram): readonly string[] =>
    parseImagePromptProgramProvenance(result.meta[IMAGE_PROMPT_PROGRAM_META_KEY])?.droppedClaimIds ?? [];

  /** The keys of every required claim the unfitted render actually kept. */
  const requiredKept = (result: CharacterPromptProgram): string[] =>
    result.subjects
      .flatMap((subject) => subject.facts)
      .filter((fact) => fact.disposition === "required_visual")
      .map((fact) => fact.key)
      .filter((key) => result.keptClaimIds.includes(key));

  /**
   * PROTECTS: a row with no `recommendedChars` fits nothing.
   *
   * An absent budget is not a small one — it means "nobody has measured this
   * endpoint", and every optional claim is emitted in canonical order. A seam
   * that substituted a default would silently start trimming every render on
   * every model whose row has never been curated, which is all of them but two.
   */
  it("fits nothing when the row's prompt binding declares no recommended length", () => {
    const none = program();
    const unreachable = program(100_000);
    const tight = program(200);

    // An absent advisory and one no prompt can reach are the same render.
    expect(none.prompt).toBe(unreachable.prompt);
    expect(dropped(none)).toEqual(dropped(unreachable));

    // Control: the seam DOES pass a number through, so the equality above is not
    // "the fitter was never wired to this lane".
    expect(tight.prompt.length).toBeLessThan(none.prompt.length);
    expect(tight.keptClaimIds.length).toBeLessThan(none.keptClaimIds.length);
  });

  /**
   * PROTECTS: an advisory eats optional claims only, and the mandatory floor of
   * a variant edit survives it whole.
   *
   * `recommendedChars` without a `maxChars` may never compress a mandatory
   * segment — that is the whole reason the two fields are separate — so the
   * identity lock, the delta and its preserve set stand at any advisory length.
   * Run at the shipped 1300 and at a length far below the mandatory floor,
   * because a rule that only holds while the prompt happens to fit is not the
   * rule.
   */
  it.each([1300, 200])("trims only optional claims at a %d-character advisory", (recommendedChars) => {
    const none = program();
    const fitted = program(recommendedChars);

    // A squeeze only ever removes: nothing appears that the unfitted render
    // did not already carry.
    const carried = new Set(none.keptClaimIds);
    for (const id of fitted.keptClaimIds) expect(carried.has(id)).toBe(true);

    // Every required claim survives, at either length.
    const required = requiredKept(none);
    expect(required.length).toBeGreaterThan(0);
    for (const key of required) expect(fitted.keptClaimIds).toContain(key);

    // …and so do the three sentences a variant edit IS.
    expect(fitted.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(fitted.prompt).toContain(`Make exactly this change: ${INSTRUCTION}`);
    expect(fitted.prompt).toMatch(/\bKeep\b[^.]*\bunchanged from the source\./);
  });

  /**
   * ISSUE #450 checklist item 6: selection stays a SEPARATE question from
   * fitting. The redundant face-shape fact is removed by the request-aware
   * selection before the digest ever reaches the fitter, so it can never
   * appear as either a kept claim or a fitter-recorded drop — only as a
   * world-state suppression under its own reason. Required facts and the
   * requested change survive the same squeeze regardless, exactly as the
   * sibling test above already pins for every optional claim.
   */
  it("removes a redundant optional fact before fitting, distinct from the fitter's own drops", () => {
    const fitted = program(200);

    const worldState = parseImageWorldStateProvenance(fitted.meta[IMAGE_WORLD_STATE_META_KEY]);
    const redundant = (worldState?.suppressions ?? []).filter(
      (entry) => entry.reason === IMAGE_CHARACTER_APPEARANCE_REFERENCE_REDUNDANT,
    );
    expect(redundant.length).toBeGreaterThan(0);

    const promptProvenance = parseImagePromptProgramProvenance(fitted.meta[IMAGE_PROMPT_PROGRAM_META_KEY]);
    for (const entry of redundant) {
      // Never offered to the fitter at all: neither kept nor among its own
      // recorded drops.
      expect(fitted.keptClaimIds).not.toContain(entry.key);
      expect(promptProvenance?.droppedClaimIds ?? []).not.toContain(entry.key);
    }

    // The requested change and the identity lock survive the same squeeze.
    expect(fitted.prompt).toContain(`Make exactly this change: ${INSTRUCTION}`);
    expect(fitted.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
  });
});

/**
 * ISSUE #450 checklist item 7: identical resolved inputs select the same
 * facts in the same order and compile to the same prompt.
 *
 * The request-aware selection is a pure filter over already-ordered arrays
 * (`Array.prototype.map`/`filter`, no `Set` iteration order and nothing
 * time- or randomness-dependent), so two builds from the same
 * `CharacterPromptProgramInput` must be indistinguishable — not merely
 * text-equal, but equal in the subjects, the suppressions and the kept-claim
 * order a developer inspector reads.
 */
describe("determinism of the request-aware selection", () => {
  it("selects the same facts in the same order from identical resolved inputs", () => {
    const first = compiled(buildCharacterPromptProgram(programInput()));
    const second = compiled(buildCharacterPromptProgram(programInput()));

    expect(second.prompt).toBe(first.prompt);
    expect(second.negativePrompt).toBe(first.negativePrompt);
    expect(second.keptClaimIds).toEqual(first.keptClaimIds);
    expect(second.subjects).toEqual(first.subjects);
    expect(
      parseImageWorldStateProvenance(second.meta[IMAGE_WORLD_STATE_META_KEY])?.suppressions,
    ).toEqual(parseImageWorldStateProvenance(first.meta[IMAGE_WORLD_STATE_META_KEY])?.suppressions);
  });
});

// ---------------------------------------------------------------------------
// What the reference still shows (issue #551)
// ---------------------------------------------------------------------------

/**
 * THE PRESERVATION CONTRACT, DERIVED FROM THE REFERENCE'S OWN PROVENANCE
 * (issue #551, owner direction on the PR #545 review).
 *
 * Issue #450 gave this dialect ONE split: the reference owns face, skin tone and
 * apparent age, the text owns hair and build. That split is right for a
 * photograph of unknown age and wrong for a reference minted from the very
 * appearance the render is drawing — on an instruction editor, restating hair
 * the image already carries is an instruction to repaint it. So the reference's
 * stamp decides, and the defects are both silent in the output:
 *
 * - a reference that IS current still having its hair restated (the contract
 *   does nothing, and the edit keeps fighting its own anchor);
 * - a reference that is NOT current being trusted for hair anyway, which
 *   deletes the only description of it from the prompt and renders last
 *   month's haircut.
 *
 * Both scenarios are the issue's own acceptance criteria, and nothing else in
 * the suite can see either one: the dialect owns the wording, this seam owns
 * which contract a render compiles under.
 */
describe("the preservation contract the reference's own stamp decides", () => {
  /** The appearance this render is drawing — what a freshly minted look depicts. */
  const CURRENT_APPEARANCE = appearanceRevisionOf(VARIANT_CUT.resolved);
  /**
   * The same character before the haircut — what an older accepted portrait
   * depicts. Derived from the same resolved attributes so the two revisions
   * differ in exactly one registry fact and nothing else.
   */
  const BEFORE_THE_HAIRCUT = appearanceRevisionOf(
    VARIANT_CUT.resolved.map((entry) =>
      entry.id === "hair.length" ? { ...entry, value: "chin_length" } : entry,
    ),
  );

  const anchoredOn = (appearanceRevision: string | null): CharacterPromptProgram =>
    compiled(
      buildCharacterPromptProgram(
        programInput({ references: [{ ...reference("identity"), appearanceRevision }] }),
      ),
    );

  const redundantKeys = (result: CharacterPromptProgram): string[] =>
    (parseImageWorldStateProvenance(result.meta[IMAGE_WORLD_STATE_META_KEY])?.suppressions ?? [])
      .filter((entry) => entry.reason === IMAGE_CHARACTER_APPEARANCE_REFERENCE_REDUNDANT)
      .map((entry) => entry.key);

  /**
   * ACCEPTANCE (issue #551): a render anchored on a reference minted from the
   * current appearance compiles no hair or build sentence and a binding that
   * preserves them from the image.
   */
  it("drops hair and build from the text and preserves them from a reference that depicts this very appearance", () => {
    const result = anchoredOn(CURRENT_APPEARANCE);

    // The wider preserve clause, and NOT the ordinary one — the two are
    // deliberately non-overlapping strings so which contract a render compiled
    // under stays assertable from the text.
    expect(result.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_CURRENT_LOOK_LOCK);
    expect(result.prompt).not.toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    // Nothing tells the model to repaint the hair the photograph already has.
    expect(result.prompt).not.toMatch(/platinum hair/i);
    // Recorded under the SAME reason #450 records, because it is the same
    // judgment over a wider set: this fact is redundant beside this reference.
    const redundant = redundantKeys(result);
    expect(redundant.some((key) => key.includes("appearance.hair."))).toBe(true);
    expect(redundant.some((key) => key.includes("appearance.build."))).toBe(true);
    // The requested change is untouched — this policy removes reinforcement,
    // never the instruction the render IS.
    expect(result.prompt).toContain(`Make exactly this change: ${INSTRUCTION}`);
    // And the provenance says which verdict the slot compiled under, so a
    // finished render can still explain why it said nothing about hair.
    const references = parseImagePromptProgramProvenance(result.meta[IMAGE_PROMPT_PROGRAM_META_KEY])?.references ?? [];
    expect(references.map((entry) => entry.preservation)).toEqual(["matches"]);
  });

  /**
   * ACCEPTANCE (issue #551): a render anchored on an older base portrait after a
   * haircut compiles an explicit hair change.
   *
   * "Explicit" is as explicit as a digest can honestly be. The stamp says the
   * appearance moved; it cannot say which fact moved, so the prompt states
   * today's hair as text (which it always did) and adds the one thing the old
   * prompt lacked — that the photograph is no longer the authority for it.
   */
  it("keeps hair in the text and says the photograph is out of date when the reference predates the change", () => {
    // Control: the fixture really does carry the fact this case moves, so a
    // green test cannot mean "the two revisions happened to be identical".
    expect(BEFORE_THE_HAIRCUT).not.toBe(CURRENT_APPEARANCE);
    const result = anchoredOn(BEFORE_THE_HAIRCUT);

    expect(result.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(result.prompt).not.toContain(QWEN_2511_SINGLE_REFERENCE_CURRENT_LOOK_LOCK);
    // Today's hair, still stated — the render draws the haircut it has now.
    expect(result.prompt).toMatch(/platinum hair/i);
    // …and the sentence that stops the reference and the text competing.
    expect(result.prompt).toContain(QWEN_2511_APPEARANCE_MOVED_NOTICE);
    // Nothing was dropped as redundant: an out-of-date image is authoritative
    // for exactly the aspects #450 already gave it.
    expect(redundantKeys(result).some((key) => key.includes("appearance.hair."))).toBe(false);
    const references = parseImagePromptProgramProvenance(result.meta[IMAGE_PROMPT_PROGRAM_META_KEY])?.references ?? [];
    expect(references.map((entry) => entry.preservation)).toEqual(["differs"]);
  });

  /**
   * The fallback that every reference minted before this contract, and every
   * uploaded portrait, takes. It must be the program the seam compiled before
   * the stamp existed — byte-identical, because a silent wording change to every
   * unstamped render is exactly what a forward-only contract must not do.
   */
  it("compiles an unstamped reference exactly as it did before the stamp existed", () => {
    const unstamped = compiled(buildCharacterPromptProgram(programInput()));
    const explicitlyUnknown = anchoredOn(null);

    expect(explicitlyUnknown.prompt).toBe(unstamped.prompt);
    expect(unstamped.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(unstamped.prompt).not.toContain(QWEN_2511_APPEARANCE_MOVED_NOTICE);
    expect(unstamped.prompt).toMatch(/platinum hair/i);
    const references = parseImagePromptProgramProvenance(unstamped.meta[IMAGE_PROMPT_PROGRAM_META_KEY])?.references ?? [];
    expect(references.map((entry) => entry.preservation)).toEqual(["unknown"]);
  });

  /**
   * THE STAMP THIS RENDER'S OWN OUTPUT CARRIES.
   *
   * Every character lane merges the program's meta onto the row it reserves, so
   * this one line is what makes a rendered image able to say later what it
   * depicts — and it is taken from the cut that was drawn, never from a second
   * read of the character at some later moment. A row stamped from a later read
   * would claim a portrait shows a haircut it predates, which is the one failure
   * this contract exists to prevent.
   */
  it("stamps its own output with the appearance it drew, per subject", () => {
    const result = anchoredOn(CURRENT_APPEARANCE);

    expect(result.meta[APPEARANCE_REVISION_META_KEY]).toEqual({ [LANE_PROBE_SUBJECT_ID]: CURRENT_APPEARANCE });
  });

  /**
   * Two images of one person are two claims about when she was photographed.
   * Taking the wider preserve set on the strength of the fresher one would ask
   * the model to keep hair "exactly as shown" across a pair of photographs where
   * only one of them shows today's.
   */
  it("refuses the wider preserve set when one of a subject's references is out of date", () => {
    const result = compiled(
      buildCharacterPromptProgram(
        programInput({
          references: [
            { ...reference("identity"), appearanceRevision: CURRENT_APPEARANCE },
            { ...reference("identity"), appearanceRevision: BEFORE_THE_HAIRCUT },
          ],
        }),
      ),
    );

    expect(result.sentReferences).toHaveLength(2);
    expect(result.prompt).not.toContain(QWEN_2511_SINGLE_REFERENCE_CURRENT_LOOK_LOCK);
    expect(result.prompt).not.toContain(QWEN_2511_GROUPED_REFERENCE_CURRENT_LOOK_LOCK);
    expect(result.prompt).toMatch(/platinum hair/i);
    expect(redundantKeys(result).some((key) => key.includes("appearance.hair."))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@vesper/contracts";
// Through the barrel, exactly as a consumer reaches this layer. Dialects and packs
// register themselves at import time, so a test that reached for
// `./compile-program` directly would compile against an empty registry and refuse
// every case with `dialect_unregistered` — which is the behavior a consumer WANTS
// (nothing falls back to a generic prompt) and the wrong thing to test around.
import {
  buildImageWorldDigest,
  compileImagePromptProgram,
  imageConcept,
  imageConceptChannelRank,
  imageConceptChannels,
  imageConceptIds,
  imageNegativeGuardOf,
  imagePositiveProtections,
  imagePromptDialect,
  lintImagePromptCollisions,
  parseImagePromptProgramProvenance,
  registerImagePromptDialect,
  PROSE_FAMILY_IDENTITY_LOCK,
  PROSE_FAMILY_IDENTITY_LOCK_HAIR_CONCEALED,
  qwenImage2512Bindings,
  qwenImage2512NegativePack,
  qwenImage2512PositivePack,
  createSceneStagingSurfaceLog,
  compileDialectClaims,
  selectImageNegativeConstraints,
  selectImagePositiveClaims,
  QWEN_2511_GROUPED_REFERENCE_IDENTITY_LOCK,
  QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK,
  type CompileImagePromptProgramInput,
  type ImageCameraFact,
  type ImageConflictKey,
  type ImageEntityDigest,
  type ImageNegativePackVersion,
  type ImageOperationContract,
  type ImagePositivePackVersion,
  type ImagePromptDialectDefinition,
  type ImagePromptProfileBinding,
  type ImageWorldDigest,
  type ImageWorldDigestInput,
  type ImageWorldFact,
  type ImageWorldRelation,
} from "./index";
// The scene IR is a sibling of the compiler, not part of it: `prompt-program/index.ts`
// deliberately re-exports no scene-ir name, so these come from the protocol directly.
import {
  createSceneStagingSurfaceForms,
  sceneStagingIds,
  sceneViewerBodyPartIds,
  type SceneStagingId,
  type SceneStagingSurfaceFormEntry,
  type SceneStagingSurfaceFormTable,
} from "../scene-ir";

/**
 * The prompt-program layer.
 *
 * One file for the whole layer because the invariants worth protecting here are
 * about how its parts INTERACT — a guard, a protection set and a linter decision
 * together decide whether an exclusion is safe — and splitting them would mean
 * three copies of the same world fixture.
 *
 * Four claims are under test, and nothing else:
 *
 * 1. **The negative channel can never forbid what the world requires.** This is
 *    the safety property the whole two-channel design exists for, it fails
 *    silently (the image just comes out wrong), and no other gate can see it.
 * 2. **A compile is deterministic and fails closed.** Same world, byte-equal
 *    program; a moved source, a different fingerprint; an unregistered dialect or
 *    a contradicted required exclusion, a refusal rather than a generic prompt.
 * 3. **The digest cannot carry what a projection may not send.** A `restricted`
 *    or `nonvisual` field arriving as a fact is dropped, not downgraded.
 * 4. **The 2511 delta-edit dialect honors its cutover contract.** The subject is
 *    bound to its numbered image ONCE and referred to by pronoun after, the
 *    preserve set is what a photograph carries, references are numbered from the
 *    final send order, an identity claim with nothing to reference refuses, and
 *    every exclusion drops with the endpoint's own recorded reason. Its wording
 *    is asserted structurally rather than as a snapshot (#544): what this layer
 *    owns is the SHAPE of the instruction, and a byte pin would fail on every
 *    wording change while proving nothing about it.
 * 5. **Dropped claims and staging wording form ONE accounting system.** A render
 *    may not report that it sent an arrangement's measured wording and that the
 *    claim carrying it never reached the prompt.
 *
 * Deliberately NOT tested: each of the ~55 concepts' Qwen wording, each block's
 * guard in isolation, and the seeded pack contents. The first two are covered
 * where they matter (through the collision table and the end-to-end compile), and
 * enumerating a registry to assert it contains the list you just typed proves
 * only that you typed it twice.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let factSeq = 0;

/** One fact, with only the members a case actually cares about spelled out. */
function fact(overrides: Partial<ImageWorldFact> & Pick<ImageWorldFact, "concept">): ImageWorldFact {
  factSeq += 1;
  return {
    key: `fact.${factSeq}`,
    value: "something",
    semanticTags: [],
    disposition: "optional_visual",
    priority: 0.5,
    source: { owner: "test", key: "fixture" },
    ...overrides,
  };
}

/** Generic in `kind` so `entity("subject", …)` is an `ImageSubjectDigest`, not a widened slice. */
function entity<TKind extends ImageEntityDigest["kind"]>(
  kind: TKind,
  ref: string,
  facts: readonly ImageWorldFact[],
): ImageEntityDigest & { readonly kind: TKind } {
  return { kind, ref, entityId: ref, label: ref, facts, morphology: [], missingRequired: [] };
}

function operation(overrides: Partial<ImageOperationContract> = {}): ImageOperationContract {
  return {
    kind: "generate",
    task: "portrait",
    strategy: "text_to_image_description",
    subjectCount: 1,
    style: { medium: "photographic", descriptors: [] },
    literalText: [],
    ...overrides,
  };
}

function world(input: Partial<ImageWorldDigestInput> = {}): ImageWorldDigest {
  return buildImageWorldDigest({
    read: { kind: "transactional_projection", token: "read-1" },
    operation: operation(),
    ...input,
  }).digest;
}

const cameraSource = { owner: "test", key: "camera" };

/** The seeded Qwen bindings, by task. */
function bindingFor(task: "item" | "location"): (typeof qwenImage2512Bindings)[number] {
  const found = qwenImage2512Bindings.find((binding) => binding.task === task);
  if (found === undefined) throw new Error(`no seeded Qwen 2512 binding for ${task}`);
  return found;
}

const itemBinding = bindingFor("item");

function compileInput(digest: ImageWorldDigest, overrides: Partial<CompileImagePromptProgramInput> = {}) {
  return {
    digest,
    binding: bindingFor(digest.operation.task === "location" ? "location" : "item"),
    positivePack: qwenImage2512PositivePack,
    negativePack: qwenImage2512NegativePack,
    references: [],
    budget: {},
    negativeFieldAvailable: true,
    refuseOnMissingRequired: false,
    ...overrides,
  } satisfies CompileImagePromptProgramInput;
}

/**
 * Run `run` with the item binding's dialect re-registered under a stand-in
 * positive compiler, and the real compiler put back after. No registered dialect
 * words nothing (each states the subject count), so the blank-wording cases
 * below each stand one in; `standIn` receives the real definition so a case can
 * wrap it rather than replace it.
 */
function withItemPositiveCompiler<T>(
  standIn: (real: ImagePromptDialectDefinition) => ImagePromptDialectDefinition["compilePositive"],
  run: () => T,
): T {
  const real = imagePromptDialect(itemBinding.promptDialectId);
  if (real === null) throw new Error("the item binding names an unregistered dialect");
  registerImagePromptDialect({ ...real, compilePositive: standIn(real) });
  try {
    return run();
  } finally {
    registerImagePromptDialect(real);
  }
}

/**
 * The keys this world's negative channel would actually forbid, after guards and
 * linting.
 *
 * The whole safety property in one function: whatever survives here is what a
 * dialect is allowed to spell, so a key appearing that the world requires is
 * exactly the defect the collision table below hunts for.
 */
function forbiddenKeys(digest: ImageWorldDigest): readonly ImageConflictKey[] {
  const claims = selectImagePositiveClaims(digest);
  const constraints = selectImageNegativeConstraints({
    enabledBlockIds: qwenImage2512NegativePack.manifest.enabledBlockIds,
    guard: imageNegativeGuardOf(digest),
    packVersionId: qwenImage2512NegativePack.id,
    evidenceIds: {},
  });
  const linted = lintImagePromptCollisions({
    constraints,
    protections: imagePositiveProtections({ claims, operation: digest.operation, camera: digest.camera }),
  });
  return [...new Set(linted.constraints.flatMap((constraint) => constraint.conflictKeys))];
}

// ---------------------------------------------------------------------------
// 1. Collisions — the safety property
// ---------------------------------------------------------------------------

describe("the negative channel never forbids what the world requires", () => {
  /**
   * The baseline the cases below are read against. Without it, every "the key is
   * absent" assertion could pass because the block was never enabled at all —
   * which is a different bug wearing the same result.
   */
  it("does forbid the ordinary artifacts on a plain photoreal portrait", () => {
    const keys = forbiddenKeys(world({ subjects: [entity("subject", "s1", [fact({ concept: "subject.identity" })])] }));
    expect(keys).toEqual(
      expect.arrayContaining([
        "text",
        "watermark",
        "extra_limbs",
        "missing_digits",
        "multiple_people",
        "synthetic_skin",
        "illustration",
      ]),
    );
  });

  /**
   * Each case names a world fact and the exclusion it must disarm — the minimum
   * collision rules, one row each. A failure here means a render that
   * asked for something was told not to produce it, which is the failure mode the
   * whole conflict-key design exists to make impossible.
   */
  const cases: readonly {
    readonly name: string;
    readonly digest: () => ImageWorldDigest;
    readonly disarms: readonly ImageConflictKey[];
  }[] = [
    {
      name: "authored lettering disarms the text-artifact block",
      digest: () =>
        world({
          operation: operation({
            literalText: [{ text: "EXIT", source: { owner: "test", key: "sign" } }],
          }),
          subjects: [entity("subject", "s1", [fact({ concept: "subject.identity" })])],
        }),
      disarms: ["text", "letters", "caption"],
    },
    {
      name: "an item's printed marking disarms lettering and logos",
      digest: () =>
        world({
          operation: operation({ task: "item", subjectCount: 0 }),
          items: [entity("item", "i1", [fact({ concept: "item.marking", value: "ACME" })])],
        }),
      disarms: ["text", "letters", "caption", "logo"],
    },
    {
      name: "a species feature group disarms the extra-appendage exclusions",
      digest: () =>
        world({
          subjects: [
            entity("subject", "s1", [
              fact({
                concept: "subject.morphology",
                value: "a pair of feathered wings",
                semanticTags: ["morphology.extra_appendage", "morphology.extra_limb"],
              }),
            ]),
          ],
        }),
      disarms: ["extra_limbs", "extra_appendages"],
    },
    {
      name: "an authored absence disarms both missing-anatomy exclusions",
      digest: () =>
        world({
          subjects: [
            entity("subject", "s1", [fact({ concept: "subject.absence", value: "a below-elbow amputation" })]),
          ],
        }),
      disarms: ["missing_limbs", "missing_digits"],
    },
    {
      name: "a synthetic-surface subject disarms the waxy-skin exclusion",
      digest: () =>
        world({
          subjects: [
            entity("subject", "s1", [
              fact({ concept: "subject.morphology", value: "moulded polymer skin", semanticTags: ["morphology.synthetic_surface"] }),
            ]),
          ],
        }),
      disarms: ["synthetic_skin"],
    },
    {
      name: "an ensemble disarms the single-subject exclusion",
      digest: () =>
        world({
          operation: operation({ subjectCount: 2 }),
          subjects: [
            entity("subject", "s1", [fact({ concept: "subject.identity" })]),
            entity("subject", "s2", [fact({ concept: "subject.identity" })]),
          ],
        }),
      disarms: ["multiple_people"],
    },
    {
      name: "a portrait crop disarms the cropping exclusions",
      digest: () =>
        world({
          subjects: [entity("subject", "s1", [fact({ concept: "subject.identity" })])],
          camera: [{ component: "framing", band: "portrait", source: cameraSource } satisfies ImageCameraFact],
        }),
      disarms: ["cropped", "out_of_frame"],
    },
    {
      name: "an illustrated render disarms the illustration exclusion",
      digest: () =>
        world({
          operation: operation({ style: { medium: "illustration", descriptors: [] } }),
          subjects: [entity("subject", "s1", [fact({ concept: "subject.identity" })])],
        }),
      disarms: ["illustration", "synthetic_skin", "excessive_smoothing"],
    },
    {
      name: "a described interior disarms the background-clutter exclusion",
      digest: () =>
        world({
          operation: operation({ task: "item", subjectCount: 0 }),
          items: [entity("item", "i1", [fact({ concept: "item.identity", disposition: "required_visual" })])],
          location: entity("location", "l1", [fact({ concept: "location.contents", value: "crowded shelving" })]),
        }),
      disarms: ["background_clutter", "extra_objects"],
    },
  ];

  it.each(cases)("$name", ({ digest, disarms }) => {
    const keys = forbiddenKeys(digest());
    for (const key of disarms) expect(keys).not.toContain(key);
  });

  /**
   * Falsified against a linter that subtracted keys but forgot to record WHY: an
   * operator seeing "background_clutter dropped" with no cause cannot tell a
   * working guard from a broken pack, and would eventually stop reading the
   * diagnostics.
   */
  it("names the claim responsible for each removal", () => {
    const digest = world({
      operation: operation({ literalText: [{ text: "EXIT", source: { owner: "test", key: "sign" } }] }),
      subjects: [entity("subject", "s1", [fact({ concept: "subject.identity" })])],
    });
    const claims = selectImagePositiveClaims(digest);
    const linted = lintImagePromptCollisions({
      constraints: selectImageNegativeConstraints({
        enabledBlockIds: ["generated_text_artifacts"],
        guard: imageNegativeGuardOf(digest),
        packVersionId: "pack-test",
        evidenceIds: {},
      }),
      protections: imagePositiveProtections({ claims, operation: digest.operation, camera: digest.camera }),
    });
    // The guard already refuses the block outright when text is requested, so
    // nothing is selected — which is the stronger outcome, and the reason the
    // decision list is empty rather than full of removals.
    expect(linted.constraints).toEqual([]);
    expect(linted.decisions).toEqual([]);
  });

  /**
   * The linter's own removal path, reached by enabling a block whose guard is
   * silent about the conflicting fact. Falsified against a linter that dropped a
   * whole constraint when only some of its keys were protected.
   */
  it("narrows a constraint to its surviving keys rather than dropping it whole", () => {
    const digest = world({
      subjects: [
        entity("subject", "s1", [
          fact({ concept: "subject.absence", value: "a missing index finger" }),
        ]),
      ],
    });
    const claims = selectImagePositiveClaims(digest);
    const linted = lintImagePromptCollisions({
      constraints: selectImageNegativeConstraints({
        enabledBlockIds: ["anatomy_duplication"],
        guard: imageNegativeGuardOf(digest),
        packVersionId: "pack-test",
        evidenceIds: {},
      }),
      protections: imagePositiveProtections({ claims, operation: digest.operation, camera: digest.camera }),
    });
    const decision = linted.decisions[0];
    expect(decision?.outcome).toBe("narrowed");
    expect(decision?.keptKeys).toContain("extra_limbs");
    expect(decision?.keptKeys).not.toContain("missing_limbs");
    expect(decision?.removed.map((entry) => entry.key).sort()).toEqual(["missing_digits", "missing_limbs"]);
    expect(decision?.removed[0]?.concept).toBe("subject.absence");
  });
});

// ---------------------------------------------------------------------------
// 2. The digest carries only what a projection may send
// ---------------------------------------------------------------------------

describe("world digest construction", () => {
  /**
   * The concept channel is declared in three closed consts — the vocabulary, the
   * selector's walk order, and the digest's own fact ranking — and NONE of the
   * three checks the others. Falsified against a channel added to the vocabulary
   * and forgotten in either order: `indexOf` answers -1 rather than failing, so
   * the new channel's facts silently sort ahead of the operation contract and the
   * prompt leads with whatever it happens to say.
   *
   * Registry-derived rather than a typed-out list, so it asks about agreement and
   * never about contents.
   */
  it("gives every declared concept channel a position in both selection orders", () => {
    const perChannel = imageConceptChannels.map((channel) => {
      const concept = imageConceptIds.find((id) => imageConcept(id)?.channel === channel);
      if (concept === undefined) throw new Error(`no concept declares the channel ${channel}`);
      return concept;
    });
    expect(imageConceptChannels.filter((channel) => imageConceptChannelRank(channel) < 0)).toEqual([]);
    const built = world({
      subjects: [entity("subject", "s1", perChannel.map((concept) => fact({ concept })))],
    });
    expect(built.subjects[0]?.facts.map((entry) => entry.concept)).toEqual(perChannel);
  });

  /**
   * Falsified against a builder that trusted its input: a `restricted` field
   * arriving as a fact is a projection bug with a privacy edge, and downgrading
   * it to optional would put account data in a provider payload.
   */
  it("drops a fact whose disposition may not produce one, and says so", () => {
    const built = buildImageWorldDigest({
      read: { kind: "transactional_projection", token: "read-1" },
      operation: operation({ task: "item", subjectCount: 0 }),
      items: [
        entity("item", "i1", [
          fact({ key: "keep", concept: "item.identity", disposition: "required_visual" }),
          fact({ key: "secret", concept: "item.identity", disposition: "restricted" }),
          fact({ key: "unknown", concept: "not.a.concept" as never }),
        ]),
      ],
    });
    expect(built.digest.items[0]?.facts.map((entry) => entry.key)).toEqual(["keep"]);
    expect(built.issues.map((issue) => issue.code).sort()).toEqual([
      "world_digest.nonfact_disposition",
      "world_digest.unknown_concept",
    ]);
  });

  /**
   * Falsified against a builder that kept relations verbatim: a relation naming
   * an entity the digest does not carry compiles to a sentence about something
   * the payload never describes.
   */
  it("drops a relation whose ends are not both in the digest", () => {
    const built = buildImageWorldDigest({
      read: { kind: "transactional_projection", token: "read-1" },
      operation: operation(),
      subjects: [entity("subject", "s1", [fact({ concept: "subject.identity" })])],
      relations: [
        { kind: "holds", subjectRef: "s1", objectRef: "i-missing", required: true, source: { owner: "test", key: "r" } },
      ] satisfies ImageWorldRelation[],
    });
    expect(built.digest.relations).toEqual([]);
    expect(built.issues[0]?.code).toBe("world_digest.dangling_relation");
  });

  /**
   * The freeze is what makes "no compiler may reach back into live state" more
   * than a review comment: a dialect handed the digest cannot edit a fact into a
   * different world.
   */
  it("freezes the digest through its nested facts", () => {
    const digest = world({ subjects: [entity("subject", "s1", [fact({ concept: "subject.identity" })])] });
    expect(Object.isFrozen(digest)).toBe(true);
    expect(Object.isFrozen(digest.subjects[0]?.facts[0])).toBe(true);
  });

  /**
   * Falsified against a freeze that used `Object.isFrozen` as its repeat-visit
   * guard. Shallow frozen-ness is not evidence of deep frozen-ness, so a
   * projection handing in an already-frozen wrapper around mutable children —
   * a module-level frozen default, a value that passed some other shallow
   * freeze — was skipped at its root and left every child writable inside a
   * digest the compilers are told is immutable.
   */
  it("freezes inside a branch that arrived already shallow-frozen", () => {
    const revisions = Object.freeze([{ owner: "item.library", entityId: "i1", revision: "r1" }]);
    const digest = world({ sourceRevisions: revisions });
    expect(Object.isFrozen(digest.sourceRevisions[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Determinism and refusal
// ---------------------------------------------------------------------------

describe("compiling a prompt program", () => {
  const itemWorld = (description = "a scuffed pocket compass"): ImageWorldDigest =>
    world({
      operation: operation({ task: "item", subjectCount: 0 }),
      items: [
        entity("item", "i1", [
          fact({ key: "i1.identity", concept: "item.identity", value: "a product photograph of a brass compass", disposition: "required_visual", priority: 1 }),
          fact({ key: "i1.form", concept: "item.form", value: description, priority: 0.9 }),
        ]),
      ],
      sourceRevisions: [{ owner: "item.library", entityId: "i1", revision: "r1" }],
    });

  /**
   * Falsified against the shipped lane, which put "a scuffed pocket compass.."
   * in every product prompt. The item projection passes an authored description
   * VERBATIM — authored prose ends in its own full stop — and every dialect
   * wording appends one. A description long enough to be excerpted was worse: the
   * projection ends a truncation with an ellipsis, so the appended stop made "…".
   *
   * An authored `!` or `?` survives as itself, because flattening it would be the
   * dialect editing prose it was only asked to place.
   */
  it("terminates a clause once, whatever punctuation the authored value brought", () => {
    // The dialect sentence-cases each clause, which is its business — these
    // expectations state the terminator, and carry the capital only so the
    // substring matches.
    for (const [authored, expected] of [
      ["a scuffed pocket compass.", "A scuffed pocket compass."],
      ["a scuffed pocket compass…", "A scuffed pocket compass…"],
      ["what a compass!", "What a compass!"],
      ["a scuffed pocket compass", "A scuffed pocket compass."],
    ]) {
      const result = compileImagePromptProgram(compileInput(itemWorld(authored)));
      if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
      expect(result.compiled.positiveText).toContain(expected);
      expect(result.compiled.positiveText).not.toMatch(/[.!?…][.…]/u);
    }
  });

  /**
   * The end-to-end vertical slice: world digest → claims → constraints → linter →
   * Qwen constructor → the two payload fields.
   *
   * Structural assertions rather than a prompt snapshot, because the requirement
   * is that the render SAYS these things — a reworded sentence is a dialect
   * improvement, not a regression.
   */
  it("produces both payload fields from one digest", () => {
    const result = compileImagePromptProgram(compileInput(itemWorld()));
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const { positiveText, negativeText, promptProgramProvenance } = result.compiled;

    expect(positiveText).toContain("No people are present");
    expect(positiveText).toContain("brass compass");
    expect(positiveText).toContain("scuffed pocket compass");
    // The exclusions moved out of the positive prose, which is the migration's
    // whole point — a hidden "no text, no watermark" tail could never be linted.
    expect(positiveText).not.toContain("no text");
    expect(positiveText).not.toContain("watermark");

    // No negative field: Qwen Image ignores `negative_prompt`, measured 16/16
    // against a contradictory canary (trials A and A2, 2026-08-19), so the
    // dialect declares `unsupported` and every exclusion drops with a reason
    // rather than spending prompt budget on text that changes nothing.
    expect(negativeText).toBeNull();
    const negativeOutcomes = promptProgramProvenance.negativeOutcomes;
    expect(negativeOutcomes.length).toBeGreaterThan(0);
    expect(negativeOutcomes.every((outcome) => outcome.transport === "dropped")).toBe(true);

    expect(promptProgramProvenance.promptDialectId).toBe("qwen_2512_description");
    expect(promptProgramProvenance.positivePackVersionId).toBe(qwenImage2512PositivePack.id);
    expect(promptProgramProvenance.negativePackVersionId).toBe(qwenImage2512NegativePack.id);
  });

  /**
   * Falsified against any compile that reads ambient state: two compiles of one
   * digest must fingerprint and read identically, which is what makes "retry
   * this exact composition" meaningful at all.
   */
  it("is byte-equal for the same world and moves when a source revision moves", () => {
    const digest = itemWorld();
    const first = compileImagePromptProgram(compileInput(digest));
    const second = compileImagePromptProgram(compileInput(digest));
    if (!first.ok || !second.ok) throw new Error("unexpected refusal");
    expect(second.compiled.program.fingerprint).toBe(first.compiled.program.fingerprint);
    expect(second.compiled.positiveText).toBe(first.compiled.positiveText);

    const moved = buildImageWorldDigest({
      read: { kind: "transactional_projection", token: "read-2" },
      operation: digest.operation,
      items: [...digest.items],
      sourceRevisions: [{ owner: "item.library", entityId: "i1", revision: "r2" }],
    }).digest;
    expect(moved.fingerprint).not.toBe(digest.fingerprint);
  });

  /**
   * The fail-closed rules, each of which would otherwise become a render
   * that looks fine and quietly lost a guarantee.
   */
  it.each([
    {
      name: "a retry whose world has moved",
      input: () => compileInput(itemWorld(), { expectedReadToken: "read-from-yesterday" }),
      code: "image_prompt_program.world_stale",
    },
    {
      name: "a binding naming a dialect nobody implements",
      input: () =>
        compileInput(itemWorld(), { binding: { ...itemBinding, promptDialectId: "pony_compel_tags" as const } }),
      code: "image_prompt_program.pack_dialect_mismatch",
    },
    {
      name: "a pack that suppresses a concept the render may not lose",
      input: () =>
        compileInput(itemWorld(), {
          positivePack: {
            ...qwenImage2512PositivePack,
            manifest: { ...qwenImage2512PositivePack.manifest, suppressedConcepts: ["item.identity"] },
          },
        }),
      code: "image_prompt_program.mandatory_concept_suppressed",
    },
    {
      name: "a binding whose strategy disagrees with the job",
      input: () => compileInput(itemWorld(), { binding: { ...itemBinding, promptStrategy: "instruction_edit" as const } }),
      code: "image_prompt_program.strategy_mismatch",
    },
    {
      name: "a digest whose subjects differ from the caller-resolved cast",
      input: () => compileInput(itemWorld(), { expectedSubjectRefs: ["subject.missing"] }),
      code: "image_prompt_program.subject_set_mismatch",
    },
  ])("refuses $name before provider spend", ({ input, code }) => {
    const result = compileImagePromptProgram(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe(code);
  });

  /**
   * Falsified against a compile that guarded the claim LIST and never the text.
   * A dialect that reports every claim as kept and still hands back blank text
   * leaves the mandatory-claim refusal nothing to see, so the compile returned
   * `ok` with an empty prompt — which the transport then posts as the empty
   * string. The stand-in wraps the real compiler and blanks only its text, so
   * the drop record is honest and the text guard is the one thing that can fire.
   */
  it("refuses a compile that worded nothing rather than sending a blank prompt", () => {
    const result = withItemPositiveCompiler(
      (real) => (input) => ({ ...real.compilePositive(input), text: "   " }),
      () => compileImagePromptProgram(compileInput(itemWorld())),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("image_prompt_program.prompt_empty");
  });

  /**
   * Falsified against `compileDialectClaims` as it stood behind the blank-prompt
   * guard: a claim rendered as whitespace was pushed as a segment, the segment
   * layer dropped it with an info diagnostic, and no claim id was recorded — so a
   * mandatory claim worded to nothing escaped `mandatory_claim_dropped`, and the
   * compile sent a prompt that described the compass without the identity claim
   * that makes it that compass. Blank text and a null render are the same
   * statement; the optional half pins that what changed is the RECORD, not the
   * drop — an optional claim worded blank still leaves the prompt, and says so.
   */
  it("treats a claim worded as whitespace as a dropped claim, refusing when it is mandatory", () => {
    const wordingBlank =
      (blankId: string): ImagePromptDialectDefinition["compilePositive"] =>
      (input) =>
        compileDialectClaims({
          claims: input.claims,
          render: (claim) => ({
            kind: claim.segmentKind,
            text: claim.id === blankId ? "   " : "worded.",
            mandatory: claim.required,
            priority: claim.priority,
          }),
          surfaces: createSceneStagingSurfaceLog(),
          budget: input.budget,
        });
    const compile = () => compileImagePromptProgram(compileInput(itemWorld()));

    const mandatory = withItemPositiveCompiler(() => wordingBlank("i1.identity"), compile);
    expect(mandatory.ok).toBe(false);
    if (!mandatory.ok) {
      expect(mandatory.refusal.code).toBe("image_prompt_program.mandatory_claim_dropped");
      expect(mandatory.refusal.context.claims).toEqual([{ id: "i1.identity", concept: "item.identity" }]);
    }

    const optional = withItemPositiveCompiler(() => wordingBlank("i1.form"), compile);
    if (!optional.ok) throw new Error(`unexpected refusal: ${optional.refusal.code}`);
    expect(optional.compiled.droppedClaimIds).toEqual(["i1.form"]);
    expect(optional.compiled.program.positive.map((claim) => claim.id)).not.toContain("i1.form");
  });

  /**
   * Falsified against a compiler that trusted the dialect's declared transport:
   * the dialect says Qwen has a `negative_prompt` field, but whether THIS version
   * exposes one is a probe fact, and inventing the key is exactly the guessing
   * the capability layer exists to prevent.
   */
  it("drops every exclusion when the running version exposes no negative field", () => {
    const result = compileImagePromptProgram(compileInput(itemWorld(), { negativeFieldAvailable: false }));
    if (!result.ok) throw new Error("unexpected refusal");
    expect(result.compiled.negativeText).toBeNull();
    expect(result.compiled.transports.every((entry) => entry.transport.kind === "dropped")).toBe(true);
    // Still recorded, so an operator can see what the render WOULD have excluded.
    expect(result.compiled.promptProgramProvenance.negativeOutcomes.length).toBeGreaterThan(0);
  });

  /**
   * Probing this version is now a no-op for the negative channel, and that is the
   * claim worth pinning. The dialect declares `unsupported`, so nothing is
   * delivered whether or not the row exposes a field — a later probe cannot
   * quietly start sending exclusions this endpoint ignores.
   *
   * Falsified against the previous dialect, which declared `dedicated_field` and
   * would have begun sending on the day somebody activated the version.
   */
  it("delivers no exclusions whether or not the version exposes a negative field", () => {
    const digest = itemWorld();
    const exposed = compileImagePromptProgram(compileInput(digest));
    const absent = compileImagePromptProgram(compileInput(digest, { negativeFieldAvailable: false }));
    if (!exposed.ok || !absent.ok) throw new Error("unexpected refusal");
    expect(exposed.compiled.program.deliveredNegativeIds).toEqual([]);
    expect(absent.compiled.program.deliveredNegativeIds).toEqual([]);
    expect(exposed.compiled.negativeText).toBeNull();
    expect(exposed.compiled.program.fingerprint).toBe(absent.compiled.program.fingerprint);
  });

  /**
   * Falsified against a compile that filtered only the digest-derived claims.
   * The pack's own rendering-intent descriptors were appended after the
   * suppression pass, so a pack suppressing `style.descriptor` — which you do
   * because the model degrades when style words appear — still emitted its own.
   * A concept a pack says this endpoint may not carry may not arrive from any
   * source, including the pack.
   */
  it("suppresses a concept in the pack's own rendering intent, not just in the world", () => {
    const suppressing = {
      ...qwenImage2512PositivePack,
      manifest: { ...qwenImage2512PositivePack.manifest, suppressedConcepts: ["style.descriptor" as const] },
    };
    const plain = compileImagePromptProgram(compileInput(itemWorld()));
    const result = compileImagePromptProgram(compileInput(itemWorld(), { positivePack: suppressing }));
    if (!plain.ok || !result.ok) throw new Error("unexpected refusal");
    // The descriptors are the pack's, and reach the prompt when nothing suppresses
    // them. Matched case-insensitively: the dialect sentence-cases each clause,
    // and which end of a sentence a descriptor lands on is its business.
    expect(plain.compiled.positiveText).toMatch(/sharp focus throughout/i);
    expect(result.compiled.positiveText).not.toMatch(/sharp focus throughout/i);
    expect(result.compiled.positiveText).not.toMatch(/high detail/i);
  });

  /**
   * Falsified against a fitter that trimmed from the tail of a joined string: the
   * identity claim is what the render is OF, and a budget squeeze must eat the
   * optional description instead.
   */
  it("gives up optional detail before the claim naming the subject", () => {
    const result = compileImagePromptProgram(compileInput(itemWorld(), { budget: { recommendedCharacters: 60 } }));
    if (!result.ok) throw new Error("unexpected refusal");
    expect(result.compiled.positiveText).toContain("brass compass");
    expect(result.compiled.droppedClaimIds).toContain("i1.form");
  });
});

// ---------------------------------------------------------------------------
// 4. The Qwen 2511 delta-edit dialect
// ---------------------------------------------------------------------------

describe("the Qwen 2511 delta-edit dialect", () => {
  const referenceSource = { owner: "test", key: "ref" };

  // Fixture packs and binding rather than seeded ones: no 2511 lane is bound
  // this round — registering production packs would silently arm
  // `activeImagePromptBinding` for the shipping edit lanes before their shadow
  // trial. The compile call takes the pair directly, so nothing global is
  // registered here either.
  const positivePack2511: ImagePositivePackVersion = {
    id: "pack-2511-positive-test",
    packId: "pack-2511-positive",
    channel: "positive",
    slug: "qwen-2511-positive-test",
    version: 1,
    dialectId: "qwen_2511_delta_edit",
    manifest: {
      version: 1,
      suppressedConcepts: [],
      priorityAdjustments: {},
      wordingVariant: "default",
      renderingIntent: [],
    },
    contentHash: "test",
    status: "active",
    evidence: [],
    supersedesVersionId: null,
  };
  const negativePack2511: ImageNegativePackVersion = {
    id: "pack-2511-negative-test",
    packId: "pack-2511-negative",
    channel: "negative",
    slug: "qwen-2511-negative-test",
    version: 1,
    dialectId: "qwen_2511_delta_edit",
    manifest: {
      version: 1,
      enabledBlockIds: [
        "generated_text_artifacts",
        "watermark_and_signature",
        "anatomy_duplication",
        "single_subject_integrity",
        "identity_drift",
      ],
      priorityOverrides: {},
      evidenceIds: {},
      wordingVariant: "default",
    },
    contentHash: "test",
    status: "active",
    evidence: [],
    supersedesVersionId: null,
  };
  const binding2511: ImagePromptProfileBinding = {
    id: "binding-2511-test",
    profileKey: "variant-standard",
    profileId: null,
    modelId: null,
    modelSlug: "qwen/qwen-image-edit-2511",
    versionId: null,
    task: "variant",
    promptStrategy: "instruction_edit",
    promptDialectId: "qwen_2511_delta_edit",
    positivePackVersionId: "pack-2511-positive-test",
    negativePackVersionId: "pack-2511-negative-test",
    status: "active",
  };

  const editOperation = (): ImageOperationContract =>
    operation({
      kind: "edit",
      task: "variant",
      strategy: "instruction_edit",
      change: {
        concept: "subject.pose",
        value: "raise her left hand to shoulder height",
        replacements: [],
        // Fact KEYS, which is what a preserve entry is: the set identifies the
        // facts structurally and the dialect renders what each one names. Bare
        // words used to render as themselves, which is exactly how a character
        // id reached provider prose.
        preserve: ["s1.identity", "s1.exposure"],
        geometry: "locked",
      },
    });

  const wren = () => ({
    ...entity("subject", "s1", [
      fact({
        key: "s1.identity",
        concept: "subject.identity",
        value: "Wren, a wiry courier",
        disposition: "required_visual",
        priority: 1,
      }),
      // `subjectRef` mirrors production: the character adapter's synthesized
      // exposure facts always carry their subject's ref
      // (`exposureFacts`, apps/web character-adapter), which is what lets the
      // dialect bind the fragment to the person — "Wren is …", never the
      // anonymous "The subject is …" fallback for an unowned claim.
      fact({ key: "s1.exposure", concept: "subject.exposure", value: "bare from the waist up", subjectRef: "s1" }),
    ]),
    label: "Wren",
  });

  /**
   * A cast member the scene lane offers NO display name for — the ordinary
   * scene shape, and the one a reference sheet is sent beside (#546).
   */
  const viewedSubject = (ref: string, pronouns: "she_her" | "he_him") => ({
    ...entity("subject", ref, [
      fact({
        key: `${ref}.identity`,
        concept: "subject.identity",
        value: "the same person shown in the reference image",
        subjectRef: ref,
        disposition: "required_visual",
        priority: 1,
      }),
    ]),
    label: "",
    pronouns,
  });

  /**
   * The same, with the composer's two phrases about one body: the POSE, filed
   * under `subject.body_language` exactly as the scene lowering files it, and
   * the ACTIVITY under its own concept (#548).
   */
  const actingSubject = (ref: string, pronouns: "she_her" | "he_him", pose: string, activity: string) => {
    const subject = viewedSubject(ref, pronouns);
    return {
      ...subject,
      facts: [
        ...subject.facts,
        fact({ key: `${ref}.pose`, concept: "subject.body_language", value: pose, subjectRef: ref, priority: 0.9 }),
        fact({ key: `${ref}.activity`, concept: "subject.activity", value: activity, subjectRef: ref, priority: 0.8 }),
      ],
    };
  };

  const editWorld = (input: Partial<ImageWorldDigestInput> = {}): ImageWorldDigest =>
    world({
      operation: editOperation(),
      subjects: [wren()],
      references: [{ role: "identity", subjectRef: "s1", required: true, source: referenceSource }],
      ...input,
    });

  const compile2511 = (digest: ImageWorldDigest, overrides: Partial<CompileImagePromptProgramInput> = {}) =>
    compileImagePromptProgram({
      digest,
      binding: binding2511,
      positivePack: positivePack2511,
      negativePack: negativePack2511,
      references: [{ position: 1, role: "identity", subjectRef: "s1" }],
      budget: {},
      // The probed 0119 schema exposes no negative input of any kind.
      negativeFieldAvailable: false,
      refuseOnMissingRequired: false,
      ...overrides,
    });

  /**
   * THE BINDING SENTENCE (#544 F2/F4).
   *
   * The subject is bound to their numbered image ONCE, with the preserve set a
   * photograph can actually carry: face, skin tone, apparent age. Hair and body
   * proportions left it because the TEXT is authoritative for them — the old
   * lock claimed both and was then followed by four hair facts and a build
   * stated as bare truths, with nothing to tell a reminder from an override —
   * and the separate "Image 1 shows <name>." assignment merged into it, because
   * two sentences saying one thing is how the display name got into the payload
   * beside the reference it competes with.
   *
   * Structural rather than byte-pinned, per the testing rules: what matters is
   * that the subject is introduced once, that the preserve set is the reference's
   * own, and that the delta still follows. Compiled twice because the renderer
   * keeps per-compile state (the binding emits once, send slots are consumed):
   * state leaking across compiles would make the second compile of one digest
   * differ from the first, which breaks the layer's determinism guarantee.
   */
  it("binds the subject to its image once, then states the delta", () => {
    const digest = editWorld();
    const first = compile2511(digest);
    const second = compile2511(digest);
    if (!first.ok || !second.ok) throw new Error("unexpected refusal");
    expect(second.compiled.positiveText).toBe(first.compiled.positiveText);
    expect(second.compiled.program.fingerprint).toBe(first.compiled.program.fingerprint);

    const text = first.compiled.positiveText;
    expect(text.startsWith("Use Wren in Image 1 as the sole subject; keep Wren's ")).toBe(true);
    expect(text).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(text).not.toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
    // One introduction, not two: the numbered assignment lives inside the
    // binding sentence rather than repeating the name beside it.
    expect(text.indexOf("Image 1")).toBe(text.lastIndexOf("Image 1"));
    expect(text).not.toContain("Image 1 shows Wren.");
    // The reference carries the face and nothing the text owns.
    expect(text).not.toMatch(/keep[^.]*\bhair\b/i);
    expect(text).not.toMatch(/keep[^.]*body proportions/i);
    // The blanket clauses are absent: "preserve everything" fighting a requested
    // change is the documented squashed-figure failure, and "change only what
    // this instruction requests" promised a delta the scene rung never supplies.
    expect(text.toLowerCase()).not.toContain("everything else");
    expect(text.toLowerCase()).not.toContain("change only what");

    // The delta-first order survives the regrouping: the binding, then the one
    // requested change, then the LIMITED preserve set.
    const change = text.indexOf("Make exactly this change: raise her left hand to shoulder height.");
    const preserve = text.indexOf("Keep the exposure and the identity unchanged from the source.");
    expect(change).toBeGreaterThan(0);
    expect(preserve).toBeGreaterThan(change);

    // An exposure fragment composes as a subject-scoped sentence, not as a bare
    // fragment dropped into the payload.
    expect(text).toContain("Wren is bare from the waist up.");
    // The person count CLOSES the instruction (D10): it used to sit third, which
    // is the one place a "nobody else is here" assertion cannot do its job.
    expect(text.endsWith("Wren is the only person in the picture; the foreground is clear.")).toBe(true);
  });

  /**
   * A preserve entry names a fact STRUCTURALLY, and the wording happens in the
   * dialect. The defect this kills shipped: the renderer printed the entries
   * verbatim, so a production render sent `<characterId>/horns/species.
   * feature_group` to the provider as the text a model was asked to act on — a
   * database id and two internal handles in a payload, and an instruction no
   * model can follow.
   *
   * The unresolvable half is the part only this layer can reach: an entry the
   * program does not state must be DROPPED and reported, never degraded back to
   * its key, because "we could not word it" must not become "we sent the id".
   */
  it("words the preserve set by meaning and drops what it cannot word", () => {
    const digest = editWorld({
      operation: {
        ...editOperation(),
        change: {
          concept: "subject.pose",
          value: "raise her left hand to shoulder height",
          replacements: [],
          // One real fact key, one naming nothing this program states.
          preserve: ["s1.exposure", "s1.nothing_states_this"],
          geometry: "locked",
        },
      },
    });
    const sink = new DiagnosticCollector();
    const result = compile2511(digest, { sink });
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);

    // The resolvable entry became what it MEANS.
    expect(result.compiled.positiveText).toContain("Keep the exposure unchanged from the source.");
    // Neither entry reached the payload as a key, and the unworded one is
    // reported rather than lost in silence.
    expect(result.compiled.positiveText).not.toContain("s1.exposure");
    expect(result.compiled.positiveText).not.toContain("nothing_states_this");
    expect(sink.items.some((entry) => entry.code === "image_prompt_program.preserve_unworded")).toBe(true);
  });

  /**
   * The non-identity slots keep a short assignment sentence of their own, and
   * every one of them is numbered from the slot's SEND position.
   *
   * Falsified against a compiler that numbered references from array index or
   * from the digest's own order: the slots below arrive scrambled. The binding
   * still takes its single-subject form, because the cast has one person and one
   * identity image — which is what "the sole subject" asserts, not how many
   * images the payload carries.
   */
  it("numbers every other role from its send position, after the binding", () => {
    const digest = editWorld({
      // The canvas permission rides here so the whole delta tail is ordered in
      // one case: the change, the limited preserve set, then the geometry.
      operation: operation({
        kind: "edit",
        task: "variant",
        strategy: "instruction_edit",
        change: {
          concept: "subject.pose",
          value: "raise her left hand to shoulder height",
          replacements: [],
          preserve: ["s1.identity", "s1.exposure"],
          geometry: "canvas_may_expand",
        },
      }),
      location: {
        ...entity("location", "l1", [
          fact({ key: "l1.identity", concept: "location.identity", value: "a narrow tea shop", disposition: "required_visual" }),
        ]),
        label: "the tea shop",
      },
      references: [
        { role: "identity", subjectRef: "s1", required: true, source: referenceSource },
        { role: "location", subjectRef: "l1", required: false, source: referenceSource },
        { role: "style", required: false, source: referenceSource },
      ],
    });
    const result = compile2511(digest, {
      references: [
        // Deliberately NOT in position order: numbering must come from the
        // slot's own send position, never from where it sits in the array.
        { position: 2, role: "location", subjectRef: "l1" },
        { position: 3, role: "style" },
        { position: 1, role: "identity", subjectRef: "s1" },
      ],
    });
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const text = result.compiled.positiveText;

    expect(text.startsWith("Use Wren in Image 1 as the sole subject;")).toBe(true);
    expect(text).toContain("Image 2 shows the place, the tea shop.");
    expect(text).toContain("Image 3 is the style reference; take only its rendering style.");
    // The other slots follow the binding, and the delta follows them.
    const location = text.indexOf("Image 2 shows the place");
    const style = text.indexOf("Image 3 is the style reference");
    const change = text.indexOf("Make exactly this change:");
    const preserve = text.indexOf("Keep the exposure and the identity unchanged from the source.");
    const geometry = text.indexOf(
      "You may extend the canvas and paint in the newly required space rather than compressing the subject to fit.",
    );
    expect(location).toBeGreaterThan(0);
    expect(style).toBeGreaterThan(location);
    expect(change).toBeGreaterThan(style);
    expect(preserve).toBeGreaterThan(change);
    expect(geometry).toBeGreaterThan(preserve);
  });

  /**
   * A cast of two takes the multi-reference binding: each person is introduced
   * by their OWN image number, in one sentence, and the preserve set is stated
   * once for everybody.
   *
   * Also the reason reference claims carry their index in their id
   * (`positive-claims.ts`): two `identity` references used to compile two claims
   * with one id, so the second overwrote the first wherever a claim id is the
   * handle — including the slot a dialect resolved, which is what this sentence
   * is built from.
   */
  it("introduces each person by their own image when the cast has two", () => {
    const digest = editWorld({
      operation: { ...editOperation(), subjectCount: 2 },
      subjects: [
        wren(),
        {
          ...entity("subject", "s2", [
            fact({
              key: "s2.identity",
              concept: "subject.identity",
              value: "Nyx, a tall archivist",
              subjectRef: "s2",
              disposition: "required_visual",
              priority: 1,
            }),
          ]),
          label: "Nyx",
        },
      ],
      references: [
        { role: "identity", subjectRef: "s1", required: true, source: referenceSource },
        { role: "identity", subjectRef: "s2", required: true, source: referenceSource },
      ],
    });
    const result = compile2511(digest, {
      references: [
        { position: 2, role: "identity", subjectRef: "s2" },
        { position: 1, role: "identity", subjectRef: "s1" },
      ],
    });
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const text = result.compiled.positiveText;

    expect(text.startsWith("Use the numbered images as assigned: Image 1 shows Wren, Image 2 shows Nyx; ")).toBe(true);
    expect(text).toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
    expect(text).not.toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(text).toContain("Exactly 2 people are in the picture and nobody else; the foreground is clear.");
    // The second person's identity claim is absorbed by the binding that already
    // introduced them, never a stray "They: the same person shown …" sentence.
    expect(text).not.toContain(": the same person shown");
  });

  /**
   * ONE PERSON, SEVERAL IMAGES (#546) — the shape the reference-view lane
   * produces, and the one the several-person binding got wrong.
   *
   * A matching reference view enters the send list as a SECOND `identity`
   * reference for the same character, carrying the angle registry's own clause
   * (`apps/web` `scene.ts`, `reference-views.ts`). Grouped by slot rather than
   * by person, that compiled "Image 1 shows a woman, Image 2 shows a woman …
   * keep each person's face" — the duplicate-person cue this rebuild exists to
   * remove, produced by the one lane that sends a sheet.
   *
   * Falsified against a binding that counts photographs: the assertions below
   * are that no second indefinite noun and no "each person" survive, which is
   * exactly what a slot-counting form emits.
   */
  it("binds two images of one person as one subject shown in both", () => {
    const digest = editWorld({
      operation: operation({ kind: "edit", task: "scene", strategy: "instruction_edit", subjectCount: 1 }),
      subjects: [viewedSubject("s1", "she_her")],
      references: [
        { role: "identity", subjectRef: "s1", required: true, source: referenceSource },
        // The view rides as OPTIONAL, behind the anchor, exactly as the lane offers it.
        { role: "identity", subjectRef: "s1", required: false, source: referenceSource },
      ],
    });
    const result = compile2511(digest, {
      references: [
        { position: 1, role: "identity", subjectRef: "s1" },
        { position: 2, role: "identity", subjectRef: "s1", description: "seen from behind, the same person" },
      ],
    });
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const text = result.compiled.positiveText;

    expect(
      text.startsWith(
        "Create a new scene using the woman shown in Images 1 and 2 as the sole subject. " +
          "Image 1 is her primary identity reference; Image 2 is seen from behind, the same person. " +
          "Keep her face, skin tone and apparent age consistent with these references.",
      ),
    ).toBe(true);
    // The preserve clause is the grouped one, and neither other spelling is
    // present — which is how a reader tells which binding this render chose.
    expect(text).toContain(QWEN_2511_GROUPED_REFERENCE_IDENTITY_LOCK);
    expect(text).not.toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
    expect(text).not.toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    // The two defects, named: no cast wording, and no second person.
    expect(text.toLowerCase()).not.toContain("each person");
    expect(text.match(/\ba woman\b/gu)).toBeNull();
    // The lane's clause is quoted verbatim and nothing invents an angle beside it.
    expect(text.indexOf("seen from behind, the same person")).toBe(
      text.lastIndexOf("seen from behind, the same person"),
    );
    // Still one person in the picture, said last.
    expect(text.endsWith("She is the only person in the picture; the foreground is clear.")).toBe(true);
  });

  /**
   * TWO PEOPLE WITH A SHEET EACH (#546): one clause per PERSON, listing that
   * person's own images, and the preserve set stated once for everybody.
   *
   * The list rises from commas to semicolons because each clause now carries
   * commas of its own — the lane's description is a comma'd phrase — and a
   * comma-joined list of comma'd clauses reads as one longer list of images.
   */
  it("gives each person their own images when a cast of two carries views", () => {
    const digest = editWorld({
      operation: operation({ kind: "edit", task: "scene", strategy: "instruction_edit", subjectCount: 2 }),
      subjects: [viewedSubject("s1", "she_her"), viewedSubject("s2", "he_him")],
      references: [
        { role: "identity", subjectRef: "s1", required: true, source: referenceSource },
        { role: "identity", subjectRef: "s2", required: true, source: referenceSource },
        { role: "identity", subjectRef: "s1", required: false, source: referenceSource },
        { role: "identity", subjectRef: "s2", required: false, source: referenceSource },
      ],
    });
    const result = compile2511(digest, {
      // The lane's own send order: every anchor, then the views that support them.
      references: [
        { position: 1, role: "identity", subjectRef: "s1" },
        { position: 2, role: "identity", subjectRef: "s2" },
        { position: 3, role: "identity", subjectRef: "s1", description: "seen from behind, the same person" },
        { position: 4, role: "identity", subjectRef: "s2", description: "seen in profile, the same person" },
      ],
    });
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const text = result.compiled.positiveText;

    expect(
      text.startsWith(
        "Create a new scene using the numbered images as assigned: " +
          "Images 1 and 3 show a woman, with Image 1 her primary identity reference " +
          "and Image 3 seen from behind, the same person; " +
          "Images 2 and 4 show a man, with Image 2 his primary identity reference " +
          "and Image 4 seen in profile, the same person; " +
          "keep each person's face, skin tone and apparent age exactly as their own image shows.",
      ),
    ).toBe(true);
    expect(text).toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
    expect(text).not.toContain(QWEN_2511_GROUPED_REFERENCE_IDENTITY_LOCK);
    // Two people, named once each — four photographs are not four bodies.
    expect(text.match(/\ba woman\b/gu)).toHaveLength(1);
    expect(text.match(/\ba man\b/gu)).toHaveLength(1);
    expect(text).toContain("Exactly 2 people are in the picture and nobody else; the foreground is clear.");
  });

  /**
   * THE VARIANT EDIT'S WHOLE PROMPT (#548), as a literal.
   *
   * Short enough to read in one breath, and every one of this dialect's
   * contracts is visible in it: the binding, the change contract the scene rung
   * does not have, the LIMITED preserve set, the subject-scoped exposure clause,
   * the medium, and the person count last. The variant task keeps the
   * DESCRIPTIVE register — its instruction is the change contract, and a second
   * imperative voice would compete with it (#549).
   */
  it("pins the variant edit's compiled prompt, change contract and descriptive voice intact", () => {
    const result = compile2511(editWorld());
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);

    expect(result.compiled.positiveText).toBe(
      "Use Wren in Image 1 as the sole subject; keep Wren's face, skin tone and apparent age exactly as shown. " +
        "Make exactly this change: raise her left hand to shoulder height. " +
        "Keep the exposure and the identity unchanged from the source. " +
        "Wren is bare from the waist up. " +
        "Rendered as a photograph, with real optics and natural surface detail. " +
        "Wren is the only person in the picture; the foreground is clear.",
    );
  });

  /**
   * THE POSE/ACTIVITY SPLIT ON AN ENSEMBLE (#548).
   *
   * Two composer phrases about one body take two sentences, and each person's
   * pair is bound to their own pronoun — which is the half a single fused
   * sentence per subject cannot get wrong quietly: "She is leaning against the
   * counter and pouring a second cup" is at least about one woman, while the
   * same fusion across a cast puts a man's page-turn in her sentence.
   */
  it("gives every subject a pose sentence and an activity sentence of their own", () => {
    const digest = editWorld({
      operation: operation({ kind: "edit", task: "scene", strategy: "instruction_edit", subjectCount: 2 }),
      subjects: [
        actingSubject("s1", "she_her", "leaning against the counter", "pouring a second cup"),
        actingSubject("s2", "he_him", "sitting at the far end of the bench", "turning a page"),
      ],
      references: [
        { role: "identity", subjectRef: "s1", required: true, source: referenceSource },
        { role: "identity", subjectRef: "s2", required: true, source: referenceSource },
      ],
    });
    const result = compile2511(digest, {
      references: [
        { position: 1, role: "identity", subjectRef: "s1" },
        { position: 2, role: "identity", subjectRef: "s2" },
      ],
    });
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const text = result.compiled.positiveText;

    expect(text).toContain("Show her leaning against the counter. Show her pouring a second cup.");
    expect(text).toContain("Show him sitting at the far end of the bench. Show him turning a page.");
    // Nothing is fused: neither person's activity rides the other's pose, and
    // neither rides their own.
    expect(text).not.toContain(" and pouring");
    expect(text).not.toContain(" and turning");
  });

  /**
   * The fail-closed half of the identity contract. On this endpoint the
   * reference IS the identity transport, so an identity claim with nothing to
   * bind to must refuse — compiling prose that describes a face instead would
   * have the endpoint repaint a stranger, which is the failure the binding
   * exists to prevent. The second case is the send-order rule biting: a
   * reference the planner trimmed out of the payload may not be described, and
   * the digest's intent alone cannot resurrect it.
   */
  it.each([
    {
      name: "an identity-bearing edit with no reference at all",
      run: () => compile2511(editWorld({ references: [] }), { references: [] }),
    },
    {
      name: "a planned identity reference the payload no longer carries",
      run: () => compile2511(editWorld(), { references: [{ position: 1, role: "style" }] }),
    },
  ])("refuses $name before provider spend", ({ run }) => {
    const result = run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("image_prompt_program.mandatory_claim_dropped");
  });

  /**
   * THE SCENE THIS ISSUE WAS FILED OVER (#544).
   *
   * A single-subject, first-person, clothed chat scene compiled 38 sentences
   * that named one character 28 times, described an invisible "viewer" as a
   * participant, and put the single-person assertion third. Every property below
   * is one of those defects, asserted structurally rather than as a snapshot:
   * a snapshot would fail on any wording change and prove nothing about the
   * shape, which is what this issue is about.
   *
   * The fixture carries the SHAPES the production adapter and lowering actually
   * emit, because every seam this suite protects is a disagreement between them
   * and the dialect:
   *
   * - no display label and a pronoun set, which is the ordinary scene case (the
   *   lane omits labels for reference-anchored subjects);
   * - three garments rather than five — withholding the two an opaque outer
   *   layer conceals is the application's own step, and what this proves is that
   *   whatever arrives is stated in ONE sentence;
   * - garment- and hair-scoped current-state values as `with …` CLAUSE
   *   fragments naming their own garment or part, which is what the adapter's
   *   renderers produce, at the loci the visual-state projection files them
   *   under — a garment reading at its `garment_part` key, never at the
   *   garment's own `item` key;
   * - one current-state value that is a PREDICATE rather than a clause ("damp at
   *   the hair"), because the same kind produces both shapes;
   * - the composer's pose filed under `subject.body_language`, the same concept
   *   as the cut's committed posture, because that is what the scene lowering
   *   does (`actionFacts`) and it is what makes the duplicate posture possible.
   */
  describe("a first-person chat scene", () => {
    const sceneWorld = (opts: { pronouns?: boolean } = {}): ImageWorldDigest =>
      world({
        operation: operation({
          kind: "edit",
          task: "scene",
          strategy: "instruction_edit",
          subjectCount: 1,
        }),
        scene: [
          fact({
            key: "scene.capture_mode",
            concept: "scene.capture_mode",
            value: "first_person_disembodied",
            disposition: "required_visual",
          }),
          fact({ key: "scene.mood", concept: "scene.mood", value: "nervous, curious, with a hint of playful tension" }),
        ],
        subjects: [
          {
            ...entity("subject", "s1", [
              fact({
                key: "s1.identity",
                concept: "subject.identity",
                value: "the person shown in the reference image",
                subjectRef: "s1",
                disposition: "required_visual",
                priority: 1,
              }),
              fact({ key: "s1.build.arms", concept: "subject.morphology", value: "Arm build: slender", subjectRef: "s1", locus: "arms" }),
              fact({ key: "s1.build.weight", concept: "subject.morphology", value: "Weight presentation: slim", subjectRef: "s1", locus: "torso" }),
              // The gender attribute projects like any other sheet value; beside a
              // usable pronoun it is what "She" already says.
              fact({ key: "s1.gender", concept: "subject.appearance", value: "Gender: female", subjectRef: "s1", semanticTags: ["appearance:core", "attribute:identity.gender"] }),
              // No `Hair arrangement:` attribute beside the hairstyle below: the
              // adapter suppresses the sheet's arrangement wherever a committed
              // hairstyle states it (`appearanceReplacementReason`).
              fact({ key: "s1.hair.color", concept: "subject.appearance", value: "Hair color: dark brown", subjectRef: "s1", locus: "hair" }),
              fact({ key: "s1.hair.length", concept: "subject.appearance", value: "Hair length: mid back", subjectRef: "s1", locus: "hair" }),
              fact({ key: "s1.wear.jeans", concept: "subject.wardrobe", value: "dark-wash skinny jeans", subjectRef: "s1", locus: "item:g-jeans", disposition: "required_visual" }),
              fact({ key: "s1.wear.loafers", concept: "subject.wardrobe", value: "brown leather loafers", subjectRef: "s1", locus: "item:g-loafers", disposition: "required_visual" }),
              fact({ key: "s1.wear.sweater", concept: "subject.wardrobe", value: "a pastel-pink crewneck sweater", subjectRef: "s1", locus: "item:g-sweater", disposition: "required_visual" }),
              // The garment reading's locus is the PART's, never the garment's:
              // the two never match in production, which is why matching them
              // was the wrong way to join the clause to the sentence.
              fact({ key: "s1.wear.sweater.tuck", concept: "subject.current_state", value: "with the sweater tucked in", subjectRef: "s1", locus: "garment_part:g-sweater:hem" }),
              fact({ key: "s1.hair.style", concept: "subject.current_state", value: "with the hair worn loose", subjectRef: "s1", locus: "hair" }),
              fact({ key: "s1.hair.wetness", concept: "subject.current_state", value: "damp at the hair", subjectRef: "s1", locus: "hair" }),
              fact({
                key: "s1.posture",
                concept: "subject.body_language",
                value: "standing",
                subjectRef: "s1",
                disposition: "required_visual",
                priority: 1,
              }),
              fact({
                key: "s1.pose",
                concept: "subject.body_language",
                value: "standing at the refreshments table, angled slightly toward the camera",
                subjectRef: "s1",
                priority: 0.9,
              }),
              fact({
                key: "s1.activity",
                concept: "subject.activity",
                value: "reaching for a cup of coffee",
                subjectRef: "s1",
                priority: 0.8,
              }),
              fact({ key: "s1.expression", concept: "subject.expression", value: "small, hesitant but playful", subjectRef: "s1" }),
            ]),
            // The lane omits the display name for a reference-anchored subject.
            label: "",
            ...(opts.pronouns === false ? {} : { pronouns: "she_her" as const }),
          },
        ],
        location: {
          ...entity("location", "l1", [
            fact({
              key: "l1.contents",
              concept: "location.contents",
              value: "a warm lounge with a comfortable couch, a low wooden table and bookshelves along one wall",
              disposition: "required_visual",
            }),
            fact({ key: "l1.lighting", concept: "location.lighting", value: "soft natural light from a tall window" }),
          ]),
          label: "the lounge",
        },
        camera: [{ component: "framing", band: "waist_up", source: cameraSource }],
        references: [{ role: "identity", subjectRef: "s1", required: true, source: referenceSource }],
      });

    const compiledScene = (register?: "descriptive" | "imperative"): string => {
      const result = compile2511(sceneWorld(), register === undefined ? {} : { register });
      if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
      return result.compiled.positiveText;
    };

    /**
     * The two REGISTERS this fixture compiles in (#549), and the needle each
     * band takes in either one.
     *
     * The imperative is the scene task's default: the endpoint's `prompt` is
     * documented as an edit instruction, and a description of a woman in a
     * lounge handed to an edit model beside a photograph of her can be read as a
     * reminder about the picture it was given. The descriptive register stays
     * compilable so a fixed trial can A/B the two on one seed set, which is the
     * only thing that can settle which one this endpoint obeys.
     *
     * Every structural property below is register-INDEPENDENT — one
     * introduction, one wardrobe sentence, one posture, the band order — so each
     * is asserted in both, over the frame that register writes.
     */
    const registers = [
      {
        register: "imperative" as const,
        opening: "Create a new scene using the woman in Image 1 as the sole subject. Keep her face",
        pronoun: /\bher\b/gu,
        build: "Give her arm build",
        hair: "Give her hair color",
        garments: "Dress her in dark-wash skinny jeans",
        damp: "Show her damp at the hair.",
        pose: "Show her standing at the refreshments table",
        activity: "Show her reaching for a cup of coffee.",
        setting: "Place her in a warm lounge with",
        lighting: "Light the scene with soft natural light",
        mood: "Keep the atmosphere nervous",
        style: "Render it as a photograph",
      },
      {
        register: "descriptive" as const,
        opening: "Use the woman in Image 1 as the sole subject; keep her face",
        pronoun: /\bShe\b/gu,
        build: "She has arm build",
        hair: "She has hair color",
        garments: "She wears dark-wash skinny jeans",
        damp: "She is damp at the hair.",
        pose: "She is standing at the refreshments table",
        activity: "She is reaching for a cup of coffee.",
        setting: "A warm lounge with",
        lighting: "Lit by soft natural light",
        mood: "The atmosphere is nervous",
        style: "Rendered as a photograph",
      },
    ];

    /**
     * THE GOLDEN PROMPT (#548).
     *
     * A literal, deliberately, and the only place in this suite that pins one.
     * Every structural assertion around it was true of the malformed sentence
     * this issue was filed over — "She is standing at the craft services table,
     * turned slightly toward the camera … and reaching for a cup of coffee, her
     * attention on the camera across the room." had one introduction, one
     * wardrobe sentence, one posture and the right band order — because no
     * structural property can see that a sentence is ungrammatical. A reader
     * can, and this is what a reader reads.
     *
     * Scoped to this fixture. Other cases stay structural, per the testing
     * rules: a byte pin on a case whose wording is not the contract fails on
     * every improvement and proves nothing about the shape.
     *
     * Two spellings still move it legitimately: the appearance phrases are still
     * the registry's `label: value` form ("hair color: dark brown") until the
     * prose slice replaces them, and the wardrobe order is fact-key order rather
     * than layer order. Both are known follow-ups, and both change this literal
     * when they land.
     */
    it("compiles the fixture as this imperative prompt, sentence by grammatical sentence", () => {
      expect(compiledScene()).toBe(
        "Create a new scene using the woman in Image 1 as the sole subject. " +
          "Keep her face, skin tone and apparent age exactly as shown. " +
          "Give her arm build: slender and weight presentation: slim. " +
          "Give her hair color: dark brown and hair length: mid back, with the hair worn loose. " +
          "Dress her in dark-wash skinny jeans, brown leather loafers and a pastel-pink crewneck sweater, " +
          "with the sweater tucked in. " +
          "Show her damp at the hair. " +
          "Show her standing at the refreshments table, angled slightly toward the camera, " +
          "with a small, hesitant but playful expression. " +
          "Show her reaching for a cup of coffee. " +
          "Seen from the camera's own eye-level point of view. " +
          "Waist-up framing. " +
          "Place her in a warm lounge with a comfortable couch, a low wooden table and bookshelves along one wall. " +
          "Light the scene with soft natural light from a tall window. " +
          "Keep the atmosphere nervous, curious, with a hint of playful tension. " +
          "Render it as a photograph, with real optics and natural surface detail. " +
          "She is the only person in the picture; the foreground is clear.",
      );
    });

    /**
     * The same digest in the other register — the A/B the trial runs, byte for
     * byte. Nothing but the wording moves: same claims, same references, same
     * program fingerprint (asserted below), which is what makes the two
     * comparable on one seed.
     */
    it("compiles the same fixture as this descriptive prompt", () => {
      expect(compiledScene("descriptive")).toBe(
        "Use the woman in Image 1 as the sole subject; keep her face, skin tone and apparent age exactly as shown. " +
          "She has arm build: slender and weight presentation: slim. " +
          "She has hair color: dark brown and hair length: mid back, with the hair worn loose. " +
          "She wears dark-wash skinny jeans, brown leather loafers and a pastel-pink crewneck sweater, " +
          "with the sweater tucked in. " +
          "She is damp at the hair. " +
          "She is standing at the refreshments table, angled slightly toward the camera, " +
          "with a small, hesitant but playful expression. " +
          "She is reaching for a cup of coffee. " +
          "Seen from the camera's own eye-level point of view. " +
          "Waist-up framing. " +
          "A warm lounge with a comfortable couch, a low wooden table and bookshelves along one wall. " +
          "Lit by soft natural light from a tall window. " +
          "The atmosphere is nervous, curious, with a hint of playful tension. " +
          "Rendered as a photograph, with real optics and natural surface detail. " +
          "She is the only person in the picture; the foreground is clear.",
      );
    });

    /**
     * The register is WORDING, never a different request. Two registers of one
     * digest ask for the same picture, so they share a program fingerprint and
     * differ only in the prompt the endpoint reads — which is the property that
     * lets a fixed-seed trial attribute a difference in the output to the words.
     */
    it("changes only the words: one digest, one fingerprint, two prompts", () => {
      const imperative = compile2511(sceneWorld(), { register: "imperative" });
      const descriptive = compile2511(sceneWorld(), { register: "descriptive" });
      if (!imperative.ok || !descriptive.ok) throw new Error("unexpected refusal");

      expect(imperative.compiled.program.fingerprint).toBe(descriptive.compiled.program.fingerprint);
      expect(imperative.compiled.positiveText).not.toBe(descriptive.compiled.positiveText);
      expect(imperative.compiled.droppedClaimIds).toEqual(descriptive.compiled.droppedClaimIds);
    });

    it.each(registers)("introduces the subject once and refers back by pronoun ($register)", (entry) => {
      const text = compiledScene(entry.register);
      expect(text.startsWith(entry.opening)).toBe(true);
      // ONCE. The binding phrase is the introduction, and nothing re-introduces her.
      expect(text.indexOf("the woman in Image 1")).toBe(text.lastIndexOf("the woman in Image 1"));
      expect(text.match(entry.pronoun)?.length ?? 0).toBeGreaterThan(2);
      // The projection's placeholder for an unnamed subject is not a name: a
      // prompt that says "she" everywhere else may not say "the subject" here.
      // The binding's own "as the sole subject" is the phrase that says there is
      // one person, not a name for her, so it is removed before the check rather
      // than narrowing the check around it.
      expect(text.replace("as the sole subject", "").toLowerCase()).not.toContain("the subject");
      // The digest's own identity value is what the binding replaces; it must not
      // travel beside it as a second, weaker description of the same person.
      expect(text).not.toContain("the person shown in the reference image");
    });

    it("lets the pronoun carry the gender, and states it only where no pronoun can", () => {
      expect(compiledScene().toLowerCase()).not.toContain("gender: female");
      const result = compile2511(sceneWorld({ pronouns: false }));
      if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
      expect(result.compiled.positiveText.toLowerCase()).toContain("gender: female");
    });

    it.each(registers)("never uses `viewer` as a noun on a disembodied shot ($register)", (entry) => {
      const text = compiledScene(entry.register);
      expect(text).toContain("Seen from the camera's own eye-level point of view.");
      expect(text.toLowerCase()).not.toContain("viewer");
    });

    /**
     * The `with …` rule (#544 F1/F6). The adapter names the garment inside its
     * own fragment, so the clause TRAILS the sentence it qualifies; wrapped in
     * the subject frame instead it compiled "She is with the sweater tucked in",
     * which is the sentence this asserts nothing anywhere produces.
     */
    it.each(registers)("states the wardrobe in one sentence, each garment reading trailing it ($register)", (entry) => {
      const text = compiledScene(entry.register);
      const wardrobe = text.match(/[^.]*skinny jeans[^.]*\./gu) ?? [];
      expect(wardrobe).toHaveLength(1);
      expect(wardrobe[0]).toContain(entry.garments);
      for (const garment of ["dark-wash skinny jeans", "brown leather loafers", "a pastel-pink crewneck sweater"]) {
        expect(wardrobe[0]).toContain(garment);
      }
      expect(wardrobe[0]).toContain("with the sweater tucked in");
      expect(text).not.toMatch(/\b(?:is|are)\s+with\b/iu);
    });

    /**
     * A hair reading belongs to the head the build band just described, and a
     * PREDICATE reading is not a trailing clause at all — the same visual-state
     * kind produces both, so the shape of the value is what decides.
     */
    it.each(registers)("trails a hair reading on the hair sentence, not the garments ($register)", (entry) => {
      const text = compiledScene(entry.register);
      const hair = text.match(/[^.]*\bhair color\b[^.]*\./gu) ?? [];
      expect(hair).toHaveLength(1);
      expect(hair[0]).toContain(entry.hair);
      expect(hair[0]).toContain("with the hair worn loose");
      expect(hair[0]).toContain("hair length: mid back");
      // The wardrobe sentence is not the hair reading's host.
      expect(text).not.toMatch(/skinny jeans[^.]*with the hair worn loose/u);
      expect(text).toContain(entry.damp);
    });

    it.each(registers)("says the posture once, in the pose sentence the composer wrote ($register)", (entry) => {
      const text = compiledScene(entry.register);
      // "standing" is a committed cut fact AND the first word of the composer's
      // pose, and the lowering files both under `subject.body_language`. Two
      // sentences saying it is two bodies to compose.
      expect(text.match(/\bstanding\b/gu)).toHaveLength(1);
      expect(text).toContain("with a small, hesitant but playful expression");
    });

    /**
     * THE FUSION THIS ISSUE WAS FILED OVER (#548).
     *
     * The pose and the activity are two composer phrases about one body, and
     * joining them under one subject frame with "and" produced a sentence no
     * English reader would write. They are two sentences now, and the expression
     * rides the first of them rather than becoming a third.
     */
    it.each(registers)("gives the pose and the activity a sentence each ($register)", (entry) => {
      const text = compiledScene(entry.register);
      const pose = text.match(/[^.]*refreshments table[^.]*\./gu) ?? [];

      expect(pose).toHaveLength(1);
      expect(pose[0]?.trim()).toBe(
        `${entry.pose}, angled slightly toward the camera, with a small, hesitant but playful expression.`,
      );
      expect(text).toContain(entry.activity);
      // No composer phrase is fused onto another with "and".
      expect(text).not.toContain(" and reaching");
      expect(pose[0]).not.toContain("reaching");
    });

    it.each(registers)("emits the bands in reading order and closes on the count ($register)", (entry) => {
      const text = compiledScene(entry.register);
      const at = (needle: string): number => {
        const found = text.indexOf(needle);
        expect(found).toBeGreaterThanOrEqual(0);
        return found;
      };
      const order = [
        at("the woman in Image 1"),
        at(entry.build),
        at(entry.hair),
        at(entry.garments),
        at(entry.pose),
        at(entry.activity),
        at("Seen from the camera's own"),
        at("Waist-up framing."),
        at(entry.setting),
        at(entry.lighting),
        at(entry.mood),
        at(entry.style),
      ];
      expect(order).toEqual([...order].sort((left, right) => left - right));
      expect(text.endsWith("She is the only person in the picture; the foreground is clear.")).toBe(true);
    });

    /**
     * The family's own guidance asks for roughly 200 words. The measured
     * baseline was 2021 characters of one-fact sentences; this is the shape
     * check that keeps a future claim from being added back as its own sentence
     * per fact. It is not a budget — the endpoint declares none — so the bound is
     * generous on purpose, and it holds in both registers because the imperative
     * spends a few words the descriptive does not.
     */
    it.each(registers)("compiles under the family's advisory length ($register)", (entry) => {
      expect(compiledScene(entry.register).length).toBeLessThan(1300);
    });
  });

  /**
   * TWO LABEL-LESS SUBJECTS — the multi binding's own circularity (#544).
   *
   * A label-less subject's introduction IS "the woman in Image 1", so an
   * assignment list built from introductions wrote "Image 1 shows the woman in
   * Image 1": a sentence that defines each image by itself and tells the model
   * nothing about who is in it. The assignment takes the INDEFINITE noun the
   * pronoun set implies, and the definite introduction is what every later
   * sentence uses.
   */
  it("assigns each label-less subject an indefinite noun rather than their own image", () => {
    const unnamed = (ref: string, pronouns: "she_her" | "he_him") => ({
      ...entity("subject", ref, [
        fact({
          key: `${ref}.identity`,
          concept: "subject.identity",
          value: "the same person shown in the reference image",
          subjectRef: ref,
          disposition: "required_visual",
          priority: 1,
        }),
        fact({ key: `${ref}.build`, concept: "subject.morphology", value: "Frame: slight", subjectRef: ref }),
      ]),
      // The scene lane's own shape: no display name for a subject the payload
      // carries an identity image of.
      label: "",
      pronouns,
    });
    const digest = editWorld({
      operation: operation({ kind: "edit", task: "scene", strategy: "instruction_edit", subjectCount: 2 }),
      subjects: [unnamed("s1", "she_her"), unnamed("s2", "he_him")],
      references: [
        { role: "identity", subjectRef: "s1", required: true, source: referenceSource },
        { role: "identity", subjectRef: "s2", required: true, source: referenceSource },
      ],
    });
    const result = compile2511(digest, {
      references: [
        { position: 1, role: "identity", subjectRef: "s1" },
        { position: 2, role: "identity", subjectRef: "s2" },
      ],
    });
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const text = result.compiled.positiveText;

    // A scene, so the opening is the imperative register's (#549); the
    // assignment list and the preserve clause after it are the register's
    // business no more than the image numbers are.
    expect(
      text.startsWith("Create a new scene using the numbered images as assigned: Image 1 shows a woman, Image 2 shows a man; "),
    ).toBe(true);
    expect(text).toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
    // Nothing defines an image by pointing back at it…
    expect(text).not.toContain("Image 1 shows the woman in Image 1");
    expect(text).not.toContain("Image 2 shows the man in Image 2");
    // …and the placeholder for an unnamed subject never stands in for a name.
    expect(text.toLowerCase()).not.toContain("the subject");
  });

  /**
   * A STAGED ARRANGEMENT AND A COVERED HEAD, on the subject the scene lane
   * declines to name (#544 F2).
   *
   * Both sentences used to be bound to the display LABEL, which on this lane is
   * the projection's neutral placeholder — so an intimate arrangement compiled
   * "The subject standing with the subject's back against the viewer's chest"
   * and the concealment compiled "The subject's hair is fully covered", in a
   * prompt whose every other sentence says "she". The template's own words are
   * untouched; only what `{name}` binds to changes.
   */
  describe("a label-less subject's staged arrangement and covered head", () => {
    const TEMPLATE =
      "{name} standing with {name}'s back against the viewer's chest, the viewer's own arms closed around {name} from behind";
    const stagingForms = createSceneStagingSurfaceForms(
      Object.fromEntries(
        sceneStagingIds.map((id): [SceneStagingId, SceneStagingSurfaceFormEntry] => [
          id,
          { text: TEMPLATE, revision: 1, digest: id.length.toString(16).padStart(64, "0") },
        ]),
      ) as SceneStagingSurfaceFormTable,
    );

    const stagedText = (): string => {
      const digest = editWorld({
        operation: operation({ kind: "edit", task: "scene", strategy: "instruction_edit", subjectCount: 1 }),
        scene: [
          fact({
            key: "scene.staging",
            concept: "scene.staging",
            value: stagingForms.formFor("held_from_behind"),
            subjectRef: "s1",
            disposition: "required_visual",
            priority: 1,
          }),
        ],
        subjects: [
          {
            ...entity("subject", "s1", [
              fact({
                key: "s1.identity",
                concept: "subject.identity",
                value: "the same person shown in the reference image",
                subjectRef: "s1",
                disposition: "required_visual",
                priority: 1,
              }),
              fact({
                key: "s1.hair_concealment",
                concept: "subject.hair_concealment",
                value: "hair fully covered by the headwear; no hair visible",
                subjectRef: "s1",
                disposition: "required_visual",
                priority: 0.99,
              }),
            ]),
            label: "",
            pronouns: "she_her",
          },
        ],
      });
      const result = compile2511(digest);
      if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
      return result.compiled.positiveText;
    };

    it("binds the template's first placeholder to the introduction and the rest to pronouns", () => {
      const text = stagedText();

      expect(text).toContain(
        "The woman in Image 1 standing with her back against the viewer's chest, the viewer's own arms closed around her from behind.",
      );
      // The registry's own words survive the binding untouched.
      expect(text).toContain("the viewer's own arms closed around");
      expect(text).not.toContain("{name}");
      expect(text).not.toContain("her's");
    });

    it("words the concealment through the same voice", () => {
      const text = stagedText();

      expect(text).toContain("Her hair is fully covered by the headwear; no hair is visible.");
      // The neutral placeholder is never a name, in either sentence.
      expect(text.toLowerCase()).not.toContain("the subject");
      // The fact's own descriptor stays out of the payload; the dialect owns the sentence.
      expect(text).not.toContain("no hair visible");
    });
  });

  /**
   * The degradation record (owner ruling 2026-08-29): no negative input exists
   * on the probed 0119 schema, so every exclusion drops with THIS endpoint's
   * reason — distinct from 2512's `endpoint_ignores_negative_field` (a field
   * that exists and does nothing) and from the version gate's
   * `no_negative_field_on_version`. Falsified against a compileNegative that
   * emits text anyway, drops without recording, or borrows a neighbour's
   * reason and makes the provenance lie about why nothing was excluded.
   */
  it("drops every exclusion with the endpoint's own recorded reason", () => {
    const result = compile2511(editWorld());
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    expect(result.compiled.negativeText).toBeNull();
    expect(result.compiled.inlineExclusions).toEqual([]);
    expect(result.compiled.program.deliveredNegativeIds).toEqual([]);
    expect(result.compiled.transports.length).toBeGreaterThan(0);
    for (const outcome of result.compiled.transports) {
      expect(outcome.transport).toEqual({ kind: "dropped", reason: "endpoint_has_no_negative_field" });
    }
    // Still recorded in provenance, so an operator can see what this render
    // WOULD have excluded on an endpoint with a channel for it.
    expect(result.compiled.promptProgramProvenance.negativeOutcomes.length).toBe(result.compiled.transports.length);
  });
});

/**
 * A CLAIM VALUE NO RENDERER UNDERSTANDS (#544 D1).
 *
 * Every prose family shared one last-resort fallback: a record with no
 * `label`/`text`/`value`/`name` member was flattened to its own leaf values
 * joined, on the reasoning that saying something true beat emitting
 * `[object Object]`. It shipped structure as language. A body-language support
 * state reached a production payload as "Katelyn Nacon is surface, ground, legs,
 * borne by" — true of the data, and an instruction no model can follow.
 *
 * The fix is fail-closed: such a value words nothing, the claim is recorded as
 * declined with a diagnostic, and on a mandatory kind the compile refuses before
 * provider spend. The missing renderer is the defect; flattening is how it
 * stayed invisible.
 *
 * Asserted per family rather than on the helper, because the helper returning
 * `""` is not enough on its own — `"<subject> is "` is not an empty segment, so
 * a family that interpolated the blank would travel a mutilated clause instead
 * of declining.
 */
describe("a claim value no dialect can word", () => {
  /** The exact shape from the owner's report: a support relation with no prompt renderer. */
  const SUPPORT = {
    relations: [{ role: "borne_by", anchor: { kind: "surface", surfaceKind: "ground" }, loadZones: ["legs"] }],
  };

  const unreadableWorld = (concept: "subject.body_language" | "subject.wardrobe"): ImageWorldDigest =>
    world({
      subjects: [
        entity("subject", "nyx", [
          fact({
            key: "nyx.identity",
            concept: "subject.identity",
            value: "a woman with dark hair",
            subjectRef: "nyx",
            disposition: "required_visual",
            priority: 1,
          }),
          fact({ key: "nyx.unreadable", concept, value: SUPPORT, subjectRef: "nyx" }),
        ]),
      ],
    });

  it.each(["qwen_2511_delta_edit", "qwen_2512_description", "seedream_45_prose", "pony_compel_tags"] as const)(
    "%s declines it rather than flattening its structure",
    (dialectId) => {
      const dialect = imagePromptDialect(dialectId);
      if (dialect === null) throw new Error(`${dialectId} is not registered`);
      const sink = new DiagnosticCollector();
      const compiled = dialect.compilePositive({
        claims: selectImagePositiveClaims(unreadableWorld("subject.body_language")),
        operation: operation(),
        references: [{ position: 1, role: "identity", subjectRef: "nyx" }],
        entityLabels: { nyx: "Nyx" },
        budget: {},
        sink,
      });
      expect(compiled.text.toLowerCase()).not.toContain("borne");
      expect(compiled.text.toLowerCase()).not.toContain("ground");
      expect(compiled.droppedClaimIds).toContain("nyx.unreadable");
      expect(sink.items.some((entry) => entry.code === "image_prompt_program.value_unreadable")).toBe(true);
    },
  );

  /**
   * The fail-closed half. `wardrobe` is unfittable BY KIND, so the same value on
   * a garment fact is a claim the render may not lose — and a refusal before
   * spend is the honest outcome for a kind whose renderer nobody wrote.
   */
  it("refuses the render when the unreadable value sits on a mandatory kind", () => {
    const result = compileImagePromptProgram(compileInput(unreadableWorld("subject.wardrobe")));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("image_prompt_program.mandatory_claim_dropped");
  });
});

// ---------------------------------------------------------------------------
// 5. Staging wording and the drop record — one accounting system
// ---------------------------------------------------------------------------

/**
 * What a render says it did with a staging's measured wording.
 *
 * The vocabulary is deliberately two-valued — `adopted` or `replaced` — with no `dropped`
 * member, because a claim that never reached the prompt is already named by
 * `droppedClaimIds`. That is only safe while the two structures cannot disagree, and nothing
 * in the type system stops provenance from listing claim `scene.staging` as dropped while
 * also reporting that its wording was adopted. A reader would believe it: the digest and
 * revision look authoritative, and the measurements behind `on_all_fours@3` would be credited
 * to an image whose prompt never carried the arrangement at all.
 *
 * Falsified against the obvious implementation, which publishes every decision the dialect
 * recorded — correct until a budget squeeze removes the segment after the wording was taken,
 * which no care at the call site can anticipate.
 */
describe("a render's staging wording and its dropped claims", () => {
  /** Stands in for SHA-256, which this package may not compute — identity is what matters. */
  const stagingFormEntry = (id: SceneStagingId): SceneStagingSurfaceFormEntry => ({
    text: `{name} in the measured wording for ${id}`,
    revision: 3,
    digest: id.length.toString(16).padStart(64, "0"),
  });

  /** A registry's table stands in for the application's: total over the vocabulary, wording arbitrary. */
  const stagingForms = createSceneStagingSurfaceForms(
    Object.fromEntries(
      sceneStagingIds.map((id): [SceneStagingId, SceneStagingSurfaceFormEntry] => [id, stagingFormEntry(id)]),
    ) as SceneStagingSurfaceFormTable,
  );

  const stagedWorld = (): ImageWorldDigest =>
    world({
      scene: [
        fact({
          key: "scene.staging",
          concept: "scene.staging",
          value: stagingForms.formFor("on_all_fours"),
          subjectRef: "nyx",
        }),
      ],
      subjects: [
        entity("subject", "nyx", [
          fact({ key: "nyx.identity", concept: "subject.identity", value: "a woman with dark hair", disposition: "required_visual", priority: 1 }),
        ]),
      ],
    });

  it("reports the measured wording as adopted, in a record storage keeps", () => {
    const result = compileImagePromptProgram(compileInput(stagedWorld()));
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const provenance = result.compiled.promptProgramProvenance;

    // The disposition is only worth anything if it describes the bytes that
    // travelled, so the prompt is checked alongside the claim about it.
    expect(result.compiled.positiveText).toContain("in the measured wording for on_all_fours");
    expect(provenance.positiveClaimIds).toContain("scene.staging");
    expect(provenance.droppedClaimIds).not.toContain("scene.staging");
    expect(provenance.sceneStagingSurfaces).toEqual([
      {
        claimId: "scene.staging",
        stagingId: "on_all_fours",
        revision: "on_all_fours@3",
        digest: stagingForms.digestFor("on_all_fours"),
        disposition: "adopted",
        dialectId: "qwen_2512_description",
      },
    ]);
    // `images.meta.promptProgram` is read back through this parser, and its object
    // schema STRIPS what it does not declare. A field the compiler writes and the
    // schema forgot is lost in silence rather than at a boundary.
    expect(parseImagePromptProgramProvenance(provenance)?.sceneStagingSurfaces).toEqual(
      provenance.sceneStagingSurfaces,
    );
  });

  it("reports no wording at all for a staging the budget removed", () => {
    const result = compileImagePromptProgram(compileInput(stagedWorld(), { budget: { recommendedCharacters: 40 } }));
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const provenance = result.compiled.promptProgramProvenance;

    expect(result.compiled.positiveText).not.toContain("measured wording");
    expect(provenance.droppedClaimIds).toContain("scene.staging");
    expect(provenance.positiveClaimIds).not.toContain("scene.staging");
    expect(provenance.sceneStagingSurfaces).toEqual([]);
  });

  /**
   * The other half of the vocabulary, and the reason it exists. This family words every
   * arrangement itself, so its renders never contain the measured bytes — a provenance record
   * that stayed silent about that would leave `on_all_fours@3` as the only wording fact on
   * file, and the next tuning round would read these renders as evidence for it.
   */
  it("reports a tag endpoint's own wording as a replacement", () => {
    const dialect = imagePromptDialect("pony_compel_tags");
    if (dialect === null) throw new Error("the tag family is not registered");
    const compiled = dialect.compilePositive({
      claims: selectImagePositiveClaims(stagedWorld()),
      operation: operation(),
      references: [],
      entityLabels: { nyx: "Nyx" },
      budget: {},
    });

    expect(compiled.text).not.toContain("measured wording");
    expect(compiled.text).toContain("on all fours");
    expect(compiled.stagingSurfaces).toEqual([
      { claimId: "scene.staging", form: stagingForms.formFor("on_all_fours"), disposition: "replaced" },
    ]);
  });

  /**
   * Falsified against the warning-only shape this replaced.
   *
   * A dialect that words an arrangement without saying where the wording came from used to
   * warn and publish anyway, so provenance carried a rendered staging with no disposition
   * beside it — which reads as "this render had no staging", not as "nobody said". The record
   * is the whole point of the channel, so an unrecorded staging is now UNRENDERABLE: the
   * segment is refused, and because staging is `required_visual` the compile refuses with it
   * rather than shipping a scene that quietly lost its arrangement.
   */
  it("refuses a staging whose dialect recorded no wording decision", () => {
    const claims = selectImagePositiveClaims(stagedWorld());
    const compiled = compileDialectClaims({
      claims,
      // A renderer that words the arrangement and never touches the log — the mistake a new
      // dialect makes, and the one no type checks.
      render: (claim) =>
        claim.concept === "scene.staging"
          ? { kind: "pose", text: "an arrangement worded with no decision recorded.", mandatory: true, priority: 1 }
          : null,
      surfaces: createSceneStagingSurfaceLog(),
      budget: {},
    });

    expect(compiled.text).not.toContain("an arrangement worded with no decision recorded.");
    expect(compiled.droppedClaimIds).toContain("scene.staging");
    expect(compiled.stagingSurfaces).toEqual([]);
  });

  /**
   * The structural rule the two lists have to keep between them: a claim is either dropped or
   * carries exactly one disposition, never both and never neither. Cutting `dropped` from the
   * disposition vocabulary is safe only while that holds.
   */
  it("never reports a claim as both dropped and decided", () => {
    const result = compileImagePromptProgram(compileInput(stagedWorld()));
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const { droppedClaimIds, sceneStagingSurfaces, positiveClaimIds } = result.compiled.promptProgramProvenance;

    for (const record of sceneStagingSurfaces) {
      expect(droppedClaimIds).not.toContain(record.claimId);
      expect(positiveClaimIds).toContain(record.claimId);
    }
    for (const claimId of positiveClaimIds.filter((id) => id === "scene.staging")) {
      expect(sceneStagingSurfaces.filter((record) => record.claimId === claimId)).toHaveLength(1);
    }
  });
});

/**
 * THE VIEWER'S OWN LIMBS, AND WHY THEIR WORDING IS BOUND (issue #390).
 *
 * The measured scar: naming a body part without binding it to the camera makes
 * the model paint a whole second person into the room, and no negative fixes it
 * — "no man in frame" anchors on *man*, exactly as the literal "no camera" once
 * anchored on cameras. What works is positive: **possessive binding** ("the
 * viewer's own") plus **frame geometry** (cropped by the edge, strongly
 * foreshortened), because a limb the frame cuts through and the lens looms over
 * cannot be composed as somebody standing there.
 *
 * That is a wording invariant, so it is asserted over the compiled TEXT rather
 * than over a helper, and it is derived from the part vocabulary rather than
 * typed out — a seventh part cannot ship worded like a bare noun.
 *
 * Falsified against a phrase that drops either anchor, and against one part's
 * phrase being reused for another (six limbs stated as one).
 */
describe("the viewer's own body in a compiled prompt", () => {
  /** The anchors that make a limb the camera-holder's rather than a subject's. */
  const GEOMETRY = /foreshorten|cropped|frame edge|lower edge|bottom of the frame|toward the lens|from the lens/;

  const viewerWorld = (parts: readonly string[]): ImageWorldDigest =>
    world({
      scene: [fact({ key: "viewer.body_geometry", concept: "viewer.body_geometry", value: [...parts] })],
      subjects: [
        entity("subject", "nyx", [
          fact({ key: "nyx.identity", concept: "subject.identity", value: "a woman with dark hair", disposition: "required_visual", priority: 1 }),
        ]),
      ],
    });

  const compiledText = (parts: readonly string[]): string => {
    const result = compileImagePromptProgram(compileInput(viewerWorld(parts)));
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    return result.compiled.positiveText;
  };

  it.each([...sceneViewerBodyPartIds])("binds %s to the camera-holder and to the frame", (part) => {
    const text = compiledText([part]);
    expect(text).toContain("the viewer's own");
    expect(text).toMatch(GEOMETRY);
  });

  it("gives every part its own phrase, so six limbs are not stated as one", () => {
    const phrases = new Set(sceneViewerBodyPartIds.map((part) => compiledText([part])));
    expect(phrases.size).toBe(sceneViewerBodyPartIds.length);
  });

  /**
   * The value is a closed vocabulary, not words. A part id nothing recognizes
   * leaves the clause unwritten rather than travelling into a payload as a
   * string nobody checked — and a foreground clause naming no limb is the
   * disembodied shot spelled at greater length, so it is not written either.
   */
  it("writes no foreground clause for a value it cannot read", () => {
    expect(compiledText([])).not.toContain("in the viewer's immediate foreground");
    const invented = compileImagePromptProgram(compileInput(viewerWorld(["elbows"])));
    if (!invented.ok) throw new Error(`unexpected refusal: ${invented.refusal.code}`);
    expect(invented.compiled.positiveText).not.toContain("in the viewer's immediate foreground");
    expect(invented.compiled.droppedClaimIds).toContain("viewer.body_geometry");
  });
});

/**
 * HAIR THE HEADWEAR FULLY HIDES, per dialect family.
 *
 * `subject.hair_concealment` replaces every authored hair fact for a subject at
 * the `full` hair-occlusion band, and it is the only sentence the render then
 * has about hair — so a family that words it weakly, or drops it, leaves the
 * model free to paint the hair the projection just withheld. Byte-pinned per
 * family, because the meaning must be identical across endpoints while the
 * register is each family's own, and no other gate reads these bytes.
 */
describe("hair the headwear fully hides", () => {
  const concealedWorld = (): ImageWorldDigest =>
    world({
      subjects: [
        entity("subject", "nyx", [
          fact({
            key: "nyx.hair_concealment",
            concept: "subject.hair_concealment",
            value: "hair fully covered by the headwear; no hair visible",
            subjectRef: "nyx",
            disposition: "required_visual",
            priority: 0.99,
          }),
        ]),
      ],
    });

  it.each([
    ["seedream_45_prose", "Nyx's hair is fully covered by the headwear; no hair is visible."],
    ["qwen_2511_delta_edit", "Nyx's hair is fully covered by the headwear; no hair is visible."],
    ["qwen_2512_description", "Nyx's hair is fully covered by the headwear; no hair is visible."],
    ["pony_compel_tags", "Nyx hair fully covered by headwear, no visible hair"],
  ] as const)("%s states the concealment, and keeps it mandatory", (dialectId, wording) => {
    const dialect = imagePromptDialect(dialectId);
    if (dialect === null) throw new Error(`${dialectId} is not registered`);
    const compiled = dialect.compilePositive({
      claims: selectImagePositiveClaims(concealedWorld()),
      operation: operation(),
      references: [],
      entityLabels: { nyx: "Nyx" },
      budget: {},
    });
    expect(compiled.text).toContain(wording);
    // The value never reaches the payload as itself: the fact carries a neutral
    // descriptor and each family owns its sentence.
    expect(compiled.text).not.toContain("no hair visible");
    const segment = compiled.segments.find((entry) => entry.text.includes(wording));
    expect(segment?.mandatory).toBe(true);
    expect(segment?.kind).toBe("wardrobe");
  });

  /** A reference-anchored subject, with or without the concealment claim beside their identity. */
  const anchoredWorld = (concealed: boolean): ImageWorldDigest =>
    world({
      subjects: [
        entity("subject", "nyx", [
          fact({ key: "nyx.identity", concept: "subject.identity", value: "the same person shown in the reference image", subjectRef: "nyx", disposition: "required_visual", priority: 1 }),
          fact({ key: "nyx.face_visibility", concept: "subject.face_visibility", value: "hidden", subjectRef: "nyx", disposition: "required_visual", priority: 0.99 }),
          ...(concealed
            ? [fact({ key: "nyx.hair_concealment", concept: "subject.hair_concealment", value: "hair fully covered", subjectRef: "nyx", disposition: "required_visual", priority: 0.99 })]
            : []),
        ]),
      ],
    });

  const anchoredText = (dialectId: string, concealed: boolean): string => {
    const dialect = imagePromptDialect(dialectId);
    if (dialect === null) throw new Error(`${dialectId} is not registered`);
    return dialect.compilePositive({
      claims: selectImagePositiveClaims(anchoredWorld(concealed)),
      operation: operation(),
      references: [{ position: 1, role: "identity", subjectRef: "nyx" }],
      entityLabels: { nyx: "Nyx" },
      budget: {},
    }).text;
  };

  /**
   * The prose family's lock and the tag family's face-visibility phrase are
   * this file's to pin — no application suite compiles either on a covered
   * subject. The lock drops its hair clause and nothing else; the tag phrase
   * drops "hair" from its preserved list and keeps the no-rotation half.
   */
  it("drops hair from the prose family's lock only when somebody's hair is covered", () => {
    expect(anchoredText("seedream_45_prose", false)).toContain(PROSE_FAMILY_IDENTITY_LOCK);
    const concealed = anchoredText("seedream_45_prose", true);
    expect(concealed).toContain(PROSE_FAMILY_IDENTITY_LOCK_HAIR_CONCEALED);
    expect(concealed).not.toContain(PROSE_FAMILY_IDENTITY_LOCK);
  });

  it.each([
    [false, "Nyx's face not visible, hair, build and skin tone preserved, do not rotate Nyx to face the camera"],
    [true, "Nyx's face not visible, build and skin tone preserved, do not rotate Nyx to face the camera"],
  ])("words the tag family's hidden-face preservation with hair concealed: %s", (concealed, phrase) => {
    expect(anchoredText("pony_compel_tags", concealed)).toContain(phrase);
  });
});

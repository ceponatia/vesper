import { describe, expect, it } from "vitest";
// Through the barrel, exactly as a consumer reaches this layer. Dialects and packs
// register themselves at import time, so a test that reached for
// `./compile-program` directly would compile against an empty registry and refuse
// every case with `dialect_unregistered` — which is the behavior a consumer WANTS
// (nothing falls back to a generic prompt) and the wrong thing to test around.
import {
  buildImageWorldDigest,
  compileImagePromptProgram,
  imageNegativeGuardOf,
  imagePositiveProtections,
  lintImagePromptCollisions,
  qwenImage2512Bindings,
  qwenImage2512NegativePack,
  qwenImage2512PositivePack,
  selectImageNegativeConstraints,
  selectImagePositiveClaims,
  QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK,
  type CompileImagePromptProgramInput,
  type ImageCameraFact,
  type ImageConflictKey,
  type ImageEntityDigest,
  type ImageNegativePackVersion,
  type ImageOperationContract,
  type ImagePositivePackVersion,
  type ImagePromptProfileBinding,
  type ImageWorldDigest,
  type ImageWorldDigestInput,
  type ImageWorldFact,
  type ImageWorldRelation,
} from "./index";

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
 * 4. **The 2511 delta-edit dialect honors its cutover contract.** The identity
 *    lock is the exact bytes the render kernel's quirk writes (owner ruling
 *    2026-08-29), references are numbered from the final send order, an
 *    identity claim with nothing to reference refuses, and every exclusion
 *    drops with the endpoint's own recorded reason.
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
  ])("refuses $name before provider spend", ({ input, code }) => {
    const result = compileImagePromptProgram(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe(code);
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
        preserve: ["outfit", "hair"],
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
      fact({ key: "s1.exposure", concept: "subject.exposure", value: "bare from the waist up" }),
    ]),
    label: "Wren",
  });

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
   * The byte contract of the cutover (owner ruling 2026-08-29): the compiled
   * identity claim IS the sentence the render kernel's quirk writes today, so a
   * shadow compile can be checked byte-for-byte against the shipping edit path.
   * The exact-literal `toContain` is the assertion — a paraphrase that "means
   * the same" is precisely the defect it kills, and emitted-once is what keeps
   * a two-fixture prompt from carrying the sentence twice.
   *
   * Compiled twice because the renderer keeps per-compile state (the lock
   * emits once, send slots are consumed): state leaking across compiles would
   * make the second compile of one digest differ from the first, which breaks
   * the layer's determinism guarantee.
   */
  it("emits the single-reference identity lock byte-exactly, once, and delta-first", () => {
    const digest = editWorld();
    const first = compile2511(digest);
    const second = compile2511(digest);
    if (!first.ok || !second.ok) throw new Error("unexpected refusal");
    expect(second.compiled.positiveText).toBe(first.compiled.positiveText);
    expect(second.compiled.program.fingerprint).toBe(first.compiled.program.fingerprint);

    const text = first.compiled.positiveText;
    expect(text).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(text.indexOf(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK)).toBe(
      text.lastIndexOf(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK),
    );
    expect(text).not.toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);

    // The research doc's delta-first order: the numbered assignment, then the
    // one requested change, then the LIMITED preserve set. The blanket wording
    // is asserted absent because it is the documented squashed-figure failure:
    // "preserve everything" fighting a requested pose change.
    const assignment = text.indexOf("Image 1 shows Wren.");
    const change = text.indexOf("Make exactly this change: raise her left hand to shoulder height.");
    const preserve = text.indexOf("Keep hair and outfit unchanged from the source.");
    expect(assignment).toBeGreaterThanOrEqual(0);
    expect(change).toBeGreaterThan(assignment);
    expect(preserve).toBeGreaterThan(change);
    expect(text.toLowerCase()).not.toContain("everything else");

    // An exposure fragment composes as a subject-scoped sentence, not as a bare
    // fragment dropped into the payload.
    expect(text).toContain("Wren is bare from the waist up.");
  });

  /**
   * Falsified against a compiler that numbered references from array index or
   * from the digest's own order: the slots below arrive scrambled, and each
   * sentence must carry the slot's SEND position. Also pins the multi lock —
   * chosen by reference count, exactly as the kernel quirk chooses — emitted
   * once for the whole render.
   */
  it("chooses the multi-reference lock and numbers references by send order", () => {
    const digest = editWorld({
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

    expect(text).toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
    expect(text.indexOf(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK)).toBe(
      text.lastIndexOf(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK),
    );
    expect(text).not.toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);

    expect(text).toContain("Image 1 shows Wren.");
    expect(text).toContain("Image 2 shows the place, the tea shop.");
    expect(text).toContain("Image 3 is the style reference; take only its rendering style.");
  });

  /**
   * The lock's sentence contract, held in the COMPILED output (owner
   * correction 2026-08-29 #4): the multi lock promises "Use numbered
   * references as assigned below", and the canonical operation-first segment
   * order emitted the `Image N` assignments AHEAD of the identity-kind lock —
   * so "below" was false in the very prompt that said it. The lock bytes are
   * frozen for kernel-quirk parity, so the dialect's own emission order moved
   * instead: lock first, then the assignments, then the delta-first tail the
   * research doc names — the one change, the limited preserve set, the
   * geometry permission. Falsified against the canonical order (assignments
   * lead) and against a reorder that scrambled the operation band while moving
   * the lock.
   */
  it("emits the identity lock before the numbered assignments, delta order intact", () => {
    const digest = editWorld({
      operation: operation({
        kind: "edit",
        task: "variant",
        strategy: "instruction_edit",
        change: {
          concept: "subject.pose",
          value: "raise her left hand to shoulder height",
          replacements: [],
          preserve: ["outfit", "hair"],
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
      ],
    });
    const result = compile2511(digest, {
      references: [
        { position: 1, role: "identity", subjectRef: "s1" },
        { position: 2, role: "location", subjectRef: "l1" },
      ],
    });
    if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal.code}`);
    const text = result.compiled.positiveText;

    // "as assigned below" is now TRUE: the lock opens the prompt, and every
    // numbered assignment sits after it.
    expect(text.startsWith(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK)).toBe(true);
    const lockIndex = text.indexOf(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
    const firstAssignment = text.indexOf("Image ");
    expect(firstAssignment).toBeGreaterThan(lockIndex);

    // The delta-first properties survive the move: assignments, then the one
    // change, then the preserve set, then the geometry permission.
    const secondAssignment = text.indexOf("Image 2 shows the place, the tea shop.");
    const change = text.indexOf("Make exactly this change: raise her left hand to shoulder height.");
    const preserve = text.indexOf("Keep hair and outfit unchanged from the source.");
    const geometry = text.indexOf(
      "You may extend the canvas and paint in the newly required space rather than compressing the subject to fit.",
    );
    expect(secondAssignment).toBeGreaterThan(firstAssignment);
    expect(change).toBeGreaterThan(secondAssignment);
    expect(preserve).toBeGreaterThan(change);
    expect(geometry).toBeGreaterThan(preserve);

    // The single-reference lock opens its prompt the same way; its own first
    // sentence IS an assignment ("Image 1 is the identity reference."), so the
    // pin is that the lane's other numbered sentence follows it.
    const single = compile2511(editWorld());
    if (!single.ok) throw new Error(`unexpected refusal: ${single.refusal.code}`);
    expect(single.compiled.positiveText.startsWith(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK)).toBe(true);
    expect(single.compiled.positiveText.indexOf("Image 1 shows Wren.")).toBeGreaterThan(
      single.compiled.positiveText.indexOf(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK),
    );
  });

  /**
   * The fail-closed half of the identity contract. On this endpoint the
   * reference IS the identity transport, so an identity claim with nothing to
   * lock to must refuse — compiling prose that describes a face instead would
   * have the endpoint repaint a stranger, which is the failure the lock exists
   * to prevent. The second case is the send-order rule biting: a reference the
   * planner trimmed out of the payload may not be described, and the digest's
   * intent alone cannot resurrect it.
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

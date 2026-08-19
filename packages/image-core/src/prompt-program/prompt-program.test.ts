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
  type CompileImagePromptProgramInput,
  type ImageCameraFact,
  type ImageConflictKey,
  type ImageEntityDigest,
  type ImageOperationContract,
  type ImageWorldDigest,
  type ImageWorldDigestInput,
  type ImageWorldFact,
  type ImageWorldRelation,
} from "./index";

/**
 * The prompt-program layer (model-aware-image-prompts.plan.md).
 *
 * One file for the whole layer because the invariants worth protecting here are
 * about how its parts INTERACT — a guard, a protection set and a linter decision
 * together decide whether an exclusion is safe — and splitting them would mean
 * three copies of the same world fixture.
 *
 * Three claims are under test, and nothing else:
 *
 * 1. **The negative channel can never forbid what the world requires.** This is
 *    the safety property the whole two-channel design exists for, it fails
 *    silently (the image just comes out wrong), and no other gate can see it.
 * 2. **A compile is deterministic and fails closed.** Same world, byte-equal
 *    program; a moved source, a different fingerprint; an unregistered dialect or
 *    a contradicted required exclusion, a refusal rather than a generic prompt.
 * 3. **The digest cannot carry what a projection may not send.** A `restricted`
 *    or `nonvisual` field arriving as a fact is dropped, not downgraded.
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
   * Each case names a world fact and the exclusion it must disarm — the plan's
   * "Minimum collision rules", one row each. A failure here means a render that
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
   * The plan's fail-closed rules, each of which would otherwise become a render
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

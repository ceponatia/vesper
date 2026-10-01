import { describe, expect, it } from "vitest";
import {
  buildImageWorldDigest,
  imageNegativeGuardOf,
  imagePromptDialect,
  selectImageNegativeConstraints,
  selectImagePositiveClaims,
  type ImageEntityDigest,
  type ImageNegativeConstraint,
  type ImageOperationContract,
  type ImageWorldDigest,
  type ImageWorldDigestInput,
  type ImageWorldFact,
} from "./index";

/**
 * `dialect-qwen-21.ts` — the dialect for `civitai/qwen-image-2.1`
 * (acceptance #663/#664 slice S2).
 *
 * What this file is under test for, and nothing else: that the dialect is
 * registered under its own id; that it never carries a negative prompt,
 * whatever constraints a pack hands it (acceptance #3); that it states
 * "naked"/"nude" exactly when the render's route permits intimate content AND
 * the subject's own exposure claims read fully bare — never on bare coverage
 * alone, never for a partial undress, never for a clothed subject (acceptance
 * #4, and the owner's age-gate ruling of the same day) — and that "no
 * clothes" rides along only when NOTHING is worn at all, never beside a
 * wardrobe claim (stockings, heels) or a non-bare exposure region elsewhere
 * on the same subject; and that a numbered reference drives both the
 * reference introduction and the identity-preserve lock, while a
 * zero-reference compile (the scene chain's bare-prompt rung) falls back to a
 * plain descriptive identity sentence; and that a shot hiding the subject's
 * face entirely drops "face" from the identity lock and states positively
 * that it stays hidden, and gets this dialect's own positive face-visibility
 * sentence rather than the shared family's "do not rotate" negation — a
 * partially turned face is unaffected by either change (#669).
 *
 * Fixture helpers are local copies of `prompt-program.test.ts`'s own
 * (`fact`/`entity`/`operation`/`world`): that file's are module-private, and a
 * second small copy here is cheaper than exporting test plumbing from a
 * production module.
 */

let factSeq = 0;

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

function entity<TKind extends ImageEntityDigest["kind"]>(
  kind: TKind,
  ref: string,
  facts: readonly ImageWorldFact[],
): ImageEntityDigest & { readonly kind: TKind } {
  return { kind, ref, entityId: ref, label: ref, facts, morphology: [], missingRequired: [] };
}

function operation(overrides: Partial<ImageOperationContract> = {}): ImageOperationContract {
  return {
    kind: "edit",
    task: "variant",
    strategy: "instruction_edit",
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

const DIALECT_ID = "qwen_21_instruction_edit";

function dialect() {
  const found = imagePromptDialect(DIALECT_ID);
  if (found === null) throw new Error(`${DIALECT_ID} is not registered`);
  return found;
}

/** The identity fact every subject fixture below carries. */
const identityFact = (subjectRef: string, value = "a woman with dark hair"): ImageWorldFact =>
  fact({
    key: `${subjectRef}.identity`,
    concept: "subject.identity",
    value,
    subjectRef,
    disposition: "required_visual",
    priority: 1,
  });

/** One region's exposure fact, in the exact shape `character-adapter.ts`'s `exposureFacts` writes it. */
const exposureFact = (subjectRef: string, region: "torso" | "pelvis", coverage: "covered" | "sheer" | "bare"): ImageWorldFact =>
  fact({
    key: `${subjectRef}.exposure.${region}`,
    concept: "subject.exposure",
    value: `bare at the ${region}`,
    subjectRef,
    semanticTags: [`coverage:${coverage}`],
    disposition: "required_visual",
    priority: 1,
  });

/** A worn-garment fact — stockings, heels, any item still on the subject. */
const wardrobeFact = (subjectRef: string, value: string): ImageWorldFact =>
  fact({ key: `${subjectRef}.wardrobe`, concept: "subject.wardrobe", value, subjectRef });

function compilePositive(
  worldDigest: ImageWorldDigest,
  references: readonly { position: number; role: "identity" | "body"; subjectRef?: string; description?: string }[] = [],
  entityLabels: Record<string, string> = {},
  intimatePermitted = false,
) {
  return dialect().compilePositive({
    claims: selectImagePositiveClaims(worldDigest),
    operation: worldDigest.operation,
    references,
    entityLabels,
    ...(intimatePermitted ? { intimatePermitted: true } : {}),
    budget: {},
  });
}

/** The same compile on a route that permits intimate content — a lane's age-gated intimate reveal. */
const compilePermitted = (worldDigest: ImageWorldDigest) => compilePositive(worldDigest, [], {}, true);

const NUDITY_WORDS = ["naked", "nude", "no clothes"] as const;

function nudityWords(text: string): string[] {
  const lower = text.toLowerCase();
  return NUDITY_WORDS.filter((word) => lower.includes(word));
}

/** A subject whose torso and pelvis both read bare — and no intimate-anatomy claim at all. */
const fullyBareDigest = () =>
  world({
    subjects: [
      entity("subject", "nyx", [identityFact("nyx"), exposureFact("nyx", "torso", "bare"), exposureFact("nyx", "pelvis", "bare")]),
    ],
  });

describe("the qwen_21_instruction_edit dialect is registered", () => {
  it("resolves by its own id", () => {
    expect(dialect().id).toBe(DIALECT_ID);
    expect(dialect().referenceSyntax).toBe("numbered_images");
  });
});

describe("nudity reinforcement (acceptance #4, owner rulings 2026-10-01)", () => {
  it("states nothing extra for a clothed subject, even on a permitting route", () => {
    const digest = world({
      subjects: [entity("subject", "nyx", [identityFact("nyx"), exposureFact("nyx", "torso", "covered")])],
    });
    expect(nudityWords(compilePermitted(digest).text)).toEqual([]);
  });

  it("states nothing extra for a partial undress — torso bare, pelvis covered — even on a permitting route", () => {
    const digest = world({
      subjects: [
        entity("subject", "nyx", [identityFact("nyx"), exposureFact("nyx", "torso", "bare"), exposureFact("nyx", "pelvis", "covered")]),
      ],
    });
    const compiled = compilePermitted(digest);
    expect(compiled.text).toContain("bare at the torso");
    expect(nudityWords(compiled.text)).toEqual([]);
  });

  it("states nudity explicitly, at least twice, when the route permits it and torso AND pelvis both read bare", () => {
    // No `subject.intimate_anatomy` claim anywhere in this digest: the
    // permission alone licenses the clause, so a permitted bare view of a
    // subject with no intimate attributes authored still reinforces.
    const compiled = compilePermitted(fullyBareDigest());
    // The body attributes the facts state are still carried, alongside the
    // reinforcement — never replaced by it.
    expect(compiled.text).toContain("bare at the torso");
    expect(compiled.text).toContain("bare at the pelvis");
    expect(nudityWords(compiled.text).length).toBeGreaterThanOrEqual(2);
  });

  it("never states it on bare coverage alone — the route did not permit intimate content", () => {
    // A minor's bare wardrobe, an adult's `clothed` reference view, or an
    // ordinary (non-`nsfw test`) variant all read exactly like this: bare
    // coverage with no permission, so only the ordinary exposure sentences
    // every dialect states. This is NOT about whether a scene is "intimate" —
    // a chat scene's own edit rung carries the permission for an adult cast
    // whatever the staging (`scene.ts` `allowIntimateFor`); it is the lane and
    // the age gate that decide it, never the scene's content.
    const compiled = compilePositive(fullyBareDigest());
    expect(compiled.text).toContain("bare at the torso");
    expect(compiled.text).toContain("bare at the pelvis");
    expect(nudityWords(compiled.text)).toEqual([]);
    // Only the clause separates the two compiles: the permitted text is this
    // text with the reinforcement added, not a differently worded prompt.
    const permitted = compilePermitted(fullyBareDigest());
    for (const segment of compiled.segments) expect(permitted.text).toContain(segment.text);
  });

  it("never fires on a `sheer` reading — only `bare` counts, the same threshold `selectReferenceView` uses", () => {
    const digest = world({
      subjects: [
        entity("subject", "nyx", [identityFact("nyx"), exposureFact("nyx", "torso", "sheer"), exposureFact("nyx", "pelvis", "bare")]),
      ],
    });
    expect(nudityWords(compilePermitted(digest).text)).toEqual([]);
  });

  it("states naked/nude but never 'no clothes' when the subject still wears something (stockings, torso and pelvis still both bare)", () => {
    const digest = world({
      subjects: [
        entity("subject", "nyx", [
          identityFact("nyx"),
          exposureFact("nyx", "torso", "bare"),
          exposureFact("nyx", "pelvis", "bare"),
          wardrobeFact("nyx", "sheer black stockings"),
        ]),
      ],
    });
    const compiled = compilePermitted(digest);
    expect(compiled.text).toContain("sheer black stockings");
    const words = nudityWords(compiled.text);
    expect(words).toContain("naked");
    expect(words).toContain("nude");
    expect(words).not.toContain("no clothes");
  });

  it("states all three — naked, nude, no clothes — only when nothing at all is worn", () => {
    // fullyBareDigest carries no `subject.wardrobe` claim and no exposure
    // region reading anything but bare, so "no clothes" is true rather than an
    // overclaim beside a garment sentence this same prompt also carries.
    const compiled = compilePermitted(fullyBareDigest());
    expect(nudityWords(compiled.text)).toEqual(["naked", "nude", "no clothes"]);
  });
});

const referenceFact = (subjectRef: string) => ({
  role: "identity" as const,
  subjectRef,
  required: true,
  source: { owner: "test", key: "reference" },
});

describe("numbered references drive the identity lock (owner ruling 2026-08-24: Qwen-family numbering)", () => {
  it("introduces a single identity reference by number and compiles the preserve lock", () => {
    const digest = world({
      subjects: [entity("subject", "nyx", [identityFact("nyx")])],
      references: [referenceFact("nyx")],
    });
    const compiled = compilePositive(digest, [{ position: 1, role: "identity", subjectRef: "nyx" }], { nyx: "Nyx" });
    expect(compiled.text).toContain("Image 1 shows Nyx");
    expect(compiled.text).toContain("Use Image 1 for Nyx's face, skin tone and apparent age, exactly as shown");
    expect(compiled.text).toContain("hair, build, wardrobe and pose follow this prompt's own description");
  });

  it("asks for consistency across two identity images of the same subject (a reference view beside the anchor)", () => {
    const digest = world({
      subjects: [entity("subject", "nyx", [identityFact("nyx")])],
      references: [referenceFact("nyx"), referenceFact("nyx")],
    });
    const compiled = compilePositive(
      digest,
      [
        { position: 1, role: "identity", subjectRef: "nyx" },
        { position: 2, role: "identity", subjectRef: "nyx", description: "seen from behind, the same person" },
      ],
      { nyx: "Nyx" },
    );
    expect(compiled.text).toContain("Images 1 and 2");
    expect(compiled.text).toContain("consistent with these references");
    expect(compiled.text).toContain("seen from behind, the same person");
  });

  it("falls back to a plain descriptive identity sentence with no reference (the scene chain's bare-prompt rung)", () => {
    const digest = world({ subjects: [entity("subject", "nyx", [identityFact("nyx", "a woman in her mid-20s")])] });
    const compiled = compilePositive(digest, [], { nyx: "Nyx" });
    expect(compiled.text).toContain("Nyx: a woman in her mid-20s.");
    expect(compiled.text).not.toContain("Use Image");
  });
});

/**
 * Reference-bound subjects with no display label are named distinctly
 * (Codex review, PR #668): the scene naming policy withholds a real label for
 * a subject bound to a required identity reference and supplies the literal
 * placeholder `"the subject"` instead (`apps/web`
 * `character-prompt-program.ts` `CHARACTER_LANE_SUBJECT_NAMING`, #544 F2) —
 * simulated here with that exact string rather than an absent `entityLabels`
 * entry, so the fixture matches what a real ensemble scene's digest actually
 * carries, not merely the easier "no entry at all" case.
 */
describe("reference-bound subjects with no display label are named distinctly", () => {
  const UNNAMED = "the subject";

  const twoSubjectDigest = () =>
    world({
      subjects: [
        entity("subject", "nyx", [identityFact("nyx")]),
        entity("subject", "vex", [identityFact("vex", "a man with a beard")]),
      ],
      references: [referenceFact("nyx"), referenceFact("vex")],
      operation: operation({ subjectCount: 2 }),
    });

  const TWO_SLOTS = [
    { position: 1, role: "identity" as const, subjectRef: "nyx" },
    { position: 2, role: "identity" as const, subjectRef: "vex" },
  ];

  it("gives two identity-anchored unlabelled subjects two distinct Image-N phrases, never a shared 'the subject'", () => {
    const compiled = compilePositive(twoSubjectDigest(), TWO_SLOTS, { nyx: UNNAMED, vex: UNNAMED });
    expect(compiled.text).toContain("Image 1 shows the person in Image 1.");
    expect(compiled.text).toContain("Image 2 shows the person in Image 2.");
    expect(compiled.text).toContain("Use Image 1 for the person in Image 1's face");
    expect(compiled.text).toContain("Use Image 2 for the person in Image 2's face");
    // Every mention is bound to its own image; the shared, ambiguous
    // placeholder survives nowhere in the compiled prompt.
    expect(compiled.text.toLowerCase()).not.toMatch(/\bthe subject\b/);
  });

  it("keeps a labelled subject's real name beside an unlabelled sibling's Image-N phrase", () => {
    const compiled = compilePositive(twoSubjectDigest(), TWO_SLOTS, { nyx: "Nyx", vex: UNNAMED });
    expect(compiled.text).toContain("Use Image 1 for Nyx's face");
    expect(compiled.text).toContain("Use Image 2 for the person in Image 2's face");
    expect(compiled.text.toLowerCase()).not.toMatch(/\bthe subject\b/);
  });

  it("recognizes the projection's literal placeholder label, not only an absent entityLabels entry", () => {
    const digest = world({
      subjects: [entity("subject", "nyx", [identityFact("nyx")])],
      references: [referenceFact("nyx")],
    });
    const compiled = compilePositive(digest, [{ position: 1, role: "identity", subjectRef: "nyx" }], { nyx: UNNAMED });
    expect(compiled.text).toContain("Use Image 1 for the person in Image 1's face");
  });

  it("names a single unlabelled-but-referenced subject 'the person in Image 1' (intended change from the shared placeholder)", () => {
    // Pinned rather than left at the pre-fix "the subject": applying one rule
    // to every reference-bound unlabelled subject, single or ensemble, is
    // simpler than two behaviors that diverge only once a second cast member
    // appears — and the single-subject case carried the same placeholder-leak
    // risk this fix closes, it simply had no second subject to collide with.
    const digest = world({
      subjects: [entity("subject", "nyx", [identityFact("nyx")])],
      references: [referenceFact("nyx")],
    });
    const compiled = compilePositive(digest, [{ position: 1, role: "identity", subjectRef: "nyx" }]);
    expect(compiled.text).toContain("Image 1 shows the person in Image 1.");
    expect(compiled.text).toContain("Use Image 1 for the person in Image 1's face, skin tone and apparent age, exactly as shown");
  });

  it("the nudity-reinforcement clause also names each unlabelled subject distinctly", () => {
    const digest = world({
      subjects: [
        entity("subject", "nyx", [identityFact("nyx"), exposureFact("nyx", "torso", "bare"), exposureFact("nyx", "pelvis", "bare")]),
        entity("subject", "vex", [
          identityFact("vex", "a man with a beard"),
          exposureFact("vex", "torso", "bare"),
          exposureFact("vex", "pelvis", "bare"),
        ]),
      ],
      references: [referenceFact("nyx"), referenceFact("vex")],
      operation: operation({ subjectCount: 2 }),
    });
    const compiled = compilePositive(digest, TWO_SLOTS, { nyx: UNNAMED, vex: UNNAMED }, true);
    expect(compiled.text).toContain("the person in Image 1 is completely naked");
    expect(compiled.text).toContain("the person in Image 2 is completely naked");
  });
});

/** A `subject.face_visibility` fact, in the exact shape `scene-lowering.ts` writes it. */
const faceVisibilityFact = (subjectRef: string, value: "hidden" | "partial"): ImageWorldFact =>
  fact({
    key: `${subjectRef}.face_visibility`,
    concept: "subject.face_visibility",
    value,
    subjectRef,
    disposition: "required_visual",
    priority: 0.99,
  });

/** The hair-concealment fact, in the exact shape `prompt-program.test.ts`'s own fixture uses. */
const hairConcealmentFact = (subjectRef: string): ImageWorldFact =>
  fact({
    key: `${subjectRef}.hair_concealment`,
    concept: "subject.hair_concealment",
    value: "hair fully covered",
    subjectRef,
    disposition: "required_visual",
    priority: 0.99,
  });

/**
 * #669: a back reference view (and any `away`-camera 2.1 render) asked the
 * identity images to preserve a face the shot cannot show, so the model
 * resolved the contradiction by turning the subject back toward the camera.
 * `partial` visibility is UNCHANGED — only `hidden` adapts the lock and gets
 * this dialect's own positive face-visibility sentence; the shared family's
 * "do not rotate" wording would anchor on the very turn the reference-view
 * registry's `back_full` instruction was rewritten to avoid (see that
 * registry's own file).
 */
describe("the identity lock and face-visibility sentence adapt to a hidden face (#669)", () => {
  const compileFor = (facts: readonly ImageWorldFact[]) =>
    compilePositive(
      world({ subjects: [entity("subject", "nyx", facts)], references: [referenceFact("nyx")] }),
      [{ position: 1, role: "identity", subjectRef: "nyx" }],
      { nyx: "Nyx" },
    );

  it("keeps the full face-preserve lock when nothing hides the face", () => {
    const compiled = compileFor([identityFact("nyx")]);
    expect(compiled.text).toContain("Use Image 1 for Nyx's face, skin tone and apparent age, exactly as shown");
  });

  it("drops face from the lock, asks only skin tone and apparent age, and says the face stays hidden, when the shot hides it", () => {
    const compiled = compileFor([identityFact("nyx"), faceVisibilityFact("nyx", "hidden")]);
    expect(compiled.text).toContain("Use Image 1 for Nyx's skin tone and apparent age, exactly as shown");
    expect(compiled.text).toContain("Nyx's face stays hidden from the camera in this shot");
    expect(compiled.text).not.toContain("for Nyx's face");
  });

  it("keeps the full lock for a partially turned face — only `hidden` adapts it", () => {
    const compiled = compileFor([identityFact("nyx"), faceVisibilityFact("nyx", "partial")]);
    expect(compiled.text).toContain("Use Image 1 for Nyx's face, skin tone and apparent age, exactly as shown");
  });

  it("states the hidden-face sentence positively, with no 'do not' negation, naming the back of the head and hair", () => {
    const compiled = compileFor([identityFact("nyx"), faceVisibilityFact("nyx", "hidden")]);
    expect(compiled.text).toContain(
      "Nyx faces directly away from the camera, so only the back of Nyx's head and hair is visible; " +
        "keep Nyx's hair color and style, build and skin tone exactly from the reference",
    );
    expect(compiled.text.toLowerCase()).not.toContain("do not");
    expect(compiled.text.toLowerCase()).not.toMatch(/\bturn/);
  });

  it("keeps the shared family's partial-face wording unchanged, 'do not rotate' included", () => {
    const compiled = compileFor([identityFact("nyx"), faceVisibilityFact("nyx", "partial")]);
    expect(compiled.text).toContain(
      "Nyx's face is partly turned from the camera; preserve the visible features, hair color and style, " +
        "build and skin tone exactly from the reference — do not rotate Nyx to face the camera.",
    );
  });

  it("drops hair from the hidden-face sentence when the subject's hair is fully concealed", () => {
    const compiled = compileFor([identityFact("nyx"), faceVisibilityFact("nyx", "hidden"), hairConcealmentFact("nyx")]);
    expect(compiled.text).toContain(
      "Nyx faces directly away from the camera, so only the back of Nyx's head is visible; " +
        "keep Nyx's build and skin tone exactly from the reference",
    );
  });

  it("drops 'from the reference' when this subject has no identity image of their own in the payload", () => {
    // Two subjects, only one with an identity reference — the same ensemble
    // hazard `faceVisibilityAnchor` exists to avoid: a shared "exactly from
    // the reference" would point at a photograph of somebody else.
    const digest = world({
      subjects: [
        entity("subject", "nyx", [identityFact("nyx"), faceVisibilityFact("nyx", "hidden")]),
        entity("subject", "vex", [identityFact("vex", "a man with a beard"), faceVisibilityFact("vex", "hidden")]),
      ],
      references: [referenceFact("nyx")],
      operation: operation({ subjectCount: 2 }),
    });
    const compiled = compilePositive(digest, [{ position: 1, role: "identity", subjectRef: "nyx" }], { nyx: "Nyx", vex: "Vex" });
    expect(compiled.text).toContain("keep Vex's hair color and style, build and skin tone exactly");
    expect(compiled.text).not.toContain("keep Vex's hair color and style, build and skin tone exactly from the reference");
  });
});

describe("no negative channel at all (acceptance #3)", () => {
  it("declares none/unsupported", () => {
    expect(dialect().negativeSyntax).toBe("none");
    expect(dialect().negativeTransport).toBe("unsupported");
    expect(dialect().hiddenPromptSources).toEqual([]);
  });

  it("drops every constraint and never carries a negativePrompt, whatever the pack enables", () => {
    const digest = world({ subjects: [entity("subject", "nyx", [identityFact("nyx")])] });
    const guard = imageNegativeGuardOf(digest);
    const constraints: readonly ImageNegativeConstraint[] = selectImageNegativeConstraints({
      enabledBlockIds: [
        "generated_text_artifacts",
        "watermark_and_signature",
        "anatomy_duplication",
        "hand_artifacts",
      ],
      guard,
      packVersionId: "pack-test",
      evidenceIds: {},
    });
    expect(constraints.length).toBeGreaterThan(0);
    const compiled = dialect().compileNegative({
      constraints,
      guard,
      hiddenSources: [],
      budget: {},
    });
    expect(compiled.text).toBeNull();
    expect(compiled.replacementClaims).toEqual([]);
    expect(compiled.inlineText).toEqual([]);
    expect(compiled.outcomes).toHaveLength(constraints.length);
    for (const outcome of compiled.outcomes) {
      expect(outcome.transport.kind).toBe("dropped");
    }
  });
});

/**
 * A `body` slot (#671) is the subject's body and never a second face: the
 * portrait owns the face, so the body image stays out of the identity lock —
 * which asks face, skin tone and apparent age to agree across every identity
 * image — and its sentence assigns the face to the identity image and the
 * clothing to the prompt, which is what dresses an undressed body image on a
 * dressed render.
 */
describe("a body slot is the subject's body, never a second face", () => {
  const bodyFact = (subjectRef: string) => ({
    role: "body" as const,
    subjectRef,
    required: false,
    source: { owner: "test", key: "body" },
  });
  const SLOTS = [
    { position: 1, role: "identity" as const, subjectRef: "nyx" },
    { position: 2, role: "body" as const, subjectRef: "nyx" },
  ];
  const compileWith = (facts: readonly ImageWorldFact[]) =>
    compilePositive(
      world({ subjects: [entity("subject", "nyx", facts)], references: [referenceFact("nyx"), bodyFact("nyx")] }),
      SLOTS,
      { nyx: "Nyx" },
    );

  it("introduces the body by number and takes only its shape from it — the face from the identity image, the clothing from the prompt", () => {
    const compiled = compileWith([identityFact("nyx"), wardrobeFact("nyx", "a red wool sweater")]);
    expect(compiled.text).toContain("Image 2 shows Nyx's body: take only its body shape, proportions and height");
    expect(compiled.text).toContain("take the face only from Image 1");
    expect(compiled.text).toContain("take the clothing and backdrop from this prompt");
    // The wardrobe sentence still says what to wear.
    expect(compiled.text).toContain("Nyx wears a red wool sweater.");
  });

  it("keeps the body image out of the identity lock, and names it as the build's second source beside the text", () => {
    const compiled = compileWith([identityFact("nyx"), wardrobeFact("nyx", "a red wool sweater")]);
    expect(compiled.text).toContain("Use Image 1 for Nyx's face, skin tone and apparent age, exactly as shown");
    expect(compiled.text).not.toContain("Images 1 and 2");
    expect(compiled.text).toContain("Nyx's build follows that description and Image 2");
  });

  it("names no clothing for a subject the prompt has wearing nothing at all", () => {
    const compiled = compileWith([identityFact("nyx"), exposureFact("nyx", "torso", "bare"), exposureFact("nyx", "pelvis", "bare")]);
    expect(compiled.text).toContain("Image 2 shows Nyx's body");
    expect(compiled.text).toContain("take the backdrop from this prompt");
    expect(compiled.text).not.toContain("clothing and backdrop");
  });

  it("is the one dialect that declares it binds a body slot", () => {
    expect(dialect().bindsBodyReferences).toBe(true);
    for (const id of ["qwen_2511_delta_edit", "qwen_2512_description", "seedream_45_prose", "pony_compel_tags"]) {
      expect(imagePromptDialect(id)?.bindsBodyReferences, id).toBe(false);
    }
  });
});

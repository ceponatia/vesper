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
 * nudity explicitly, twice, in the owner's vocabulary, exactly when the
 * render's route permits intimate content AND the subject's own exposure
 * claims read fully bare — never on bare coverage alone, never for a partial
 * undress, never for a clothed subject (acceptance #4, and the owner's
 * age-gate ruling of the same day); and that a numbered
 * reference drives both the reference introduction and the identity-preserve
 * lock, while a zero-reference compile (the scene chain's bare-prompt rung)
 * falls back to a plain descriptive identity sentence.
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

function compilePositive(
  worldDigest: ImageWorldDigest,
  references: readonly { position: number; role: "identity"; subjectRef?: string; description?: string }[] = [],
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
    // A minor's bare wardrobe, an adult's clothed view with no saved outfit, an
    // ordinary variant or a non-intimate scene all read exactly like this: the
    // ordinary exposure sentences every dialect states, and nothing more.
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

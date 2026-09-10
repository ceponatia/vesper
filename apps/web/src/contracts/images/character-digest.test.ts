import { buildImageWorldDigest, type ImageSubjectDigest, type ImageWorldFact } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { visualAttentionContextFixture, visualAttentionSnapshotFixture } from "../affordances/recognition";
import { crookedNoseAttributes, freckleClusterFact, missingFingerState, projectFixture } from "../appearance-features";
import type { AttributeValue } from "../attributes";
import { FULLY_COVERED } from "../items/visibility";
import { realizeBody } from "../species";
import { adaptProjectedAppearanceTruth } from "../visual-state";
import type { CharacterSubjectSources } from "./character-adapter";
import {
  assembleCharacterWorldDigest,
  characterChangeContract,
  characterPortraitImageOperation,
  characterSceneImageOperation,
  characterVariantImageOperation,
} from "./character-digest";
import { standaloneCharacterReadToken } from "./subject-digest";
import { buildVisualImageDigest, type VisualImageDigest } from "./visual-digest";

/**
 * The character world-digest assembly — the glue between the adapter stack and
 * `buildImageWorldDigest`, and nothing below it. The adapter's own behavior
 * (value resolution, the age floor, exposure claims) is `subject-digest.test.ts`'s;
 * what has to be true HERE is the three properties the glue alone can lose:
 * an assembly is deterministic and mints the token the standalone lanes already
 * mint, the adapter's fail-closed records survive the trip into the built
 * digest, and an edit's preserve set is derived rather than "everything".
 */

const FEATURES = adaptProjectedAppearanceTruth(
  projectFixture({
    attributes: crookedNoseAttributes(),
    locatedFacts: [freckleClusterFact()],
    anatomy: [missingFingerState()],
  }),
);
const SUBJECT = FEATURES[0]?.subjectId ?? "";
const REVISION = "2026-08-30T00:00:00.000Z";
const AGE: AttributeValue = { id: "identity.apparent_age", value: "late_twenties", source: "creation" };
const REQUIRED_APPEARANCE: readonly AttributeValue[] = [
  { id: "identity.gender", value: "female", source: "creation" },
  { id: "skin.tone", value: "light", source: "creation" },
  { id: "hair.color", value: "platinum", source: "creation" },
  { id: "hair.length", value: "shoulder_length", source: "creation" },
  { id: "eyes.color", value: "blue", source: "creation" },
  { id: "face.shape", value: "oval", source: "creation" },
  { id: "build.frame", value: "slight", source: "creation" },
  { id: "build.weight_presentation", value: "average", source: "creation" },
];

function visualDigest(): VisualImageDigest {
  return buildVisualImageDigest({
    snapshot: visualAttentionSnapshotFixture([...FEATURES]),
    context: visualAttentionContextFixture("image", { framing: { status: "known", value: "full_figure" } }),
  });
}

function joinedSources(): Readonly<Record<string, CharacterSubjectSources>> {
  return {
    [SUBJECT]: {
      attributes: [...REQUIRED_APPEARANCE, ...crookedNoseAttributes(), AGE],
      locatedFacts: [freckleClusterFact()],
      anatomy: [missingFingerState()],
      exposure: FULLY_COVERED,
    },
  };
}

describe("assembleCharacterWorldDigest", () => {
  /**
   * Retry-same-composition for characters: two assemblies of the same values
   * must build byte-equal digests (one fingerprint), and a single-character
   * standalone read must mint EXACTLY the token `standaloneCharacterReadToken`
   * mints — the avatar and variant lanes already store that token, so an
   * assembly that derived a different one would invalidate every stored
   * composition at cutover. Kills a map-ordered or freshly-salted read.
   */
  it("assembles deterministically and mints the standalone token the lanes already use", () => {
    const digest = visualDigest();
    const assemble = (): ReturnType<typeof assembleCharacterWorldDigest> =>
      assembleCharacterWorldDigest({
        digest,
        sources: joinedSources(),
        operation: characterPortraitImageOperation(),
        read: {
          kind: "standalone_character",
          characters: [{ characterId: SUBJECT, revision: REVISION }],
        },
      });
    const first = assemble();
    const second = assemble();
    expect(first.missingRequired).toEqual([]);

    const builtA = buildImageWorldDigest(first.input);
    const builtB = buildImageWorldDigest(second.input);
    expect(builtA.issues).toEqual([]);
    expect(builtA.digest.fingerprint).toBe(builtB.digest.fingerprint);
    expect(builtA.digest.camera.length).toBeGreaterThan(0);
    expect(builtA.digest.operation.task).toBe("portrait");
    expect(first.input.read.token).toBe(
      standaloneCharacterReadToken({ characterId: SUBJECT, revision: REVISION }),
    );
    // An extra owner moving mints a different token — the retry-staleness half.
    const moved = assembleCharacterWorldDigest({
      digest,
      sources: joinedSources(),
      operation: characterPortraitImageOperation(),
      read: {
        kind: "standalone_character",
        characters: [{ characterId: SUBJECT, revision: REVISION }],
        extraRevisions: [{ owner: "item.library", entityId: "itm_1", revision: "r2" }],
      },
    });
    expect(moved.input.read.token).not.toBe(first.input.read.token);
  });

  /**
   * Fail-closed flows THROUGH, not merely out: an unjoined subject's missing
   * mandatory keys and suppression records must survive into the built world
   * digest (and the flat aggregate), and a committed-cut read must carry the
   * caller's cut token verbatim — the assembly never mints one for a chat
   * render, because the cut id IS the staleness check. Kills an assembly that
   * re-projects the slices but drops the loss records on the way in, which
   * would let a `refuseOnMissingRequired` lane render a subject with no
   * wardrobe-coverage authority.
   */
  it("forwards the adapter's fail-closed records and the committed cut token verbatim", () => {
    const digest = visualDigest();
    const assembly = assembleCharacterWorldDigest({
      digest,
      sources: {},
      operation: characterPortraitImageOperation(),
      read: { kind: "committed_cut", token: digest.cutId },
    });
    const exposureKey = `subject.${SUBJECT}.exposure`;
    const ageKey = `subject.${SUBJECT}.apparent_age`;
    expect(assembly.missingRequired).toContain(exposureKey);
    expect(assembly.missingRequired).toContain(ageKey);

    const built = buildImageWorldDigest(assembly.input).digest;
    expect(built.read).toMatchObject({ kind: "committed_cut", token: digest.cutId, atMinutes: digest.atMinutes });
    expect(built.subjects[0]?.missingRequired).toContain(exposureKey);
    expect(built.suppressions.some((entry) => entry.key === exposureKey)).toBe(true);
  });

  it("relaxes stable-sheet completeness only for a planned required subject-bound identity reference", () => {
    const sources = joinedSources();
    const source = sources[SUBJECT];
    if (source === undefined) throw new Error("fixture subject source is missing");
    const withoutHair: Readonly<Record<string, CharacterSubjectSources>> = {
      ...sources,
      [SUBJECT]: {
        ...source,
        attributes: (source.attributes ?? []).filter(
          (value) => value.id !== "hair.color" && value.id !== "identity.apparent_age",
        ),
      },
    };
    const reference = {
      role: "identity" as const,
      required: true,
      subjectRef: `subject.${SUBJECT}`,
      source: { owner: "test.fixture", key: "identity", entityId: SUBJECT },
    };
    const assembly = assembleCharacterWorldDigest({
      digest: visualDigest(),
      sources: withoutHair,
      operation: characterVariantImageOperation(),
      read: { kind: "committed_cut", token: "cut_fixture" },
      references: [reference],
    });
    const subject = assembly.input.subjects?.[0];
    expect(assembly.missingRequired).not.toContain(`subject.${SUBJECT}.appearance.hair.color`);
    expect(assembly.missingRequired).not.toContain(`subject.${SUBJECT}.apparent_age`);
    expect(subject?.facts.some((fact) => fact.concept === "subject.identity")).toBe(true);
    // The registry words eye colour as prose (#547); the label form is gone.
    expect(subject?.facts.find((fact) => fact.source.key === "eyes.color")?.value).toEqual({
      text: "blue eyes",
      phrase: { group: "eyes", role: "adjective", fragment: "blue", order: 1 },
    });
  });

  it("lets an intimate route replace the ordinary bust silhouette instead of stating it twice", () => {
    const sources = joinedSources();
    const source = sources[SUBJECT];
    if (source === undefined) throw new Error("fixture subject source is missing");
    const reveal: ImageWorldFact = {
      key: `subject.${SUBJECT}.reveal.breasts.size`,
      concept: "subject.intimate_anatomy",
      value: "breast size: medium",
      subjectRef: `subject.${SUBJECT}`,
      locus: "breasts",
      semanticTags: ["reveal:shape"],
      disposition: "optional_visual",
      priority: 5_000,
      source: { owner: "images.subject_reveal", key: "breasts.size", entityId: SUBJECT },
    };
    const assembly = assembleCharacterWorldDigest({
      digest: visualDigest(),
      sources: {
        ...sources,
        [SUBJECT]: {
          ...source,
          attributes: [
            ...(source.attributes ?? []),
            { id: "breasts.size", value: "medium", source: "creation" },
          ],
          realizedBody: realizeBody({ intimateRegions: ["breasts"] }),
        },
      },
      operation: characterSceneImageOperation({ subjectCount: 1 }),
      read: { kind: "committed_cut", token: "cut_fixture" },
      subjectFacts: { [SUBJECT]: [reveal] },
    });
    expect(assembly.input.subjects?.[0]?.facts.filter((fact) => fact.source.key === "breasts.size")).toEqual([
      reveal,
    ]);
  });
});

describe("characterChangeContract", () => {
  /**
   * The instruction-edit ruling made checkable: the preserve set is the
   * REQUIRED anchors the change does not touch — facts of the changed concept
   * and the replacement keys excluded, optional detail excluded. Kills
   * "preserve everything", the wording the research blames for the
   * squashed-figure geometry failure, and a derivation that pins the outfit
   * being replaced.
   */
  it("derives the preserve set from the untouched required anchors", () => {
    const fact = (
      key: string,
      concept: ImageWorldFact["concept"],
      disposition: ImageWorldFact["disposition"],
    ): ImageWorldFact => ({
      key,
      concept,
      value: "stated",
      semanticTags: [],
      disposition,
      priority: 1,
      source: { owner: "test.fixture", key },
    });
    const subjects: ImageSubjectDigest[] = [
      {
        kind: "subject",
        ref: "subject.s1",
        entityId: "s1",
        label: "Mira",
        facts: [
          fact("s1/identity", "subject.identity", "required_visual"),
          fact("s1/morphology", "subject.morphology", "required_visual"),
          fact("s1/wardrobe", "subject.wardrobe", "required_visual"),
          fact("s1/detail", "subject.appearance", "optional_visual"),
        ],
        morphology: [],
        missingRequired: [],
      },
    ];
    const change = characterChangeContract(
      {
        concept: "subject.wardrobe",
        value: "a floor-length wine-red silk kimono",
        replacements: [fact("s1/outfit-change", "subject.wardrobe", "required_visual")],
      },
      subjects,
    );
    expect(change.preserve).toEqual(["s1/identity", "s1/morphology"]);
    expect(change.geometry).toBe("locked");
  });
});

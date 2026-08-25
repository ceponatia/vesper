import { describe, expect, it } from "vitest";
import {
  IMAGE_TARGET_ASPECT,
  imageModelProfileSchema,
  imageModelSchema,
  type ImageProfileOperation,
  type ImageProfileTask,
  type ImagePromptStrategy,
  type ImageRenderIntent,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import {
  duplicatedVisualFacts,
  LANE_PROBE_NAME,
  LANE_PROBE_SECOND_NAME,
  LANE_PROBE_SECOND_SUBJECT_ID,
  LANE_PROBE_SUBJECT_ID,
  laneProbeAvatarSegments,
  laneProbeCastMember,
  laneProbeCastScenePlan,
  laneProbeCastSubjects,
  laneProbeDressedExposure,
  laneProbeProfile,
  laneProbeScenePlan,
  laneProbeShadowInput,
  laneProbeVariantSegments,
  laneProbeWardrobe,
  presentVisualFacts,
  SECOND_SUBJECT_VISUAL_FACT_PROBES,
  VISUAL_FACT_PROBES,
  type VisualFactProbe,
} from "@/server/test-support";
import { resolveAttributes } from "@/contracts/attributes/value";
import { buildChatLookPrompt } from "./chat-look";
import { buildChatLookSegments } from "./chat-look-segments";
import { apparentAgeAnchor } from "./prompts-appearance";
import { buildAvatarPrompt } from "./prompts-avatar";
import { buildVariantInstruction } from "./prompts-variant";
import { buildSceneRenderPrompt } from "./prompts-scene-render";
import { sha256Hex } from "./render-fingerprint";
import {
  captureRenderIntent,
  type CaptureRenderIntentResult,
  type RenderIntentCapture,
} from "./render-intent-capture";
import {
  applySceneCastVisual,
  applySceneSubjectVisual,
  type SceneSubjectVisualBuild,
} from "./scene-subject-visual";

/**
 * THE LEGACY-vs-DIGEST CUTOVER COMPARISON (image-lane-consolidation
 * spec.prompts.md §Characterization and comparison: "Comparison should
 * normalize intentional wording changes but fail on lost, duplicated, newly
 * exposed, or route-specific character facts") — the gate the spec requires
 * before the legacy fallback assemblies can ever be removed.
 *
 * `lane-characterization.test.ts` freezes what the NEW path emits; this file
 * owns the comparison AGAINST THE RETAINED LEGACY BUILDERS. Both sides of each
 * cut-over lane are built from the SAME fixture — `buildAvatarPrompt` beside
 * `buildAvatarSegments`, `buildVariantInstruction` beside
 * `buildVariantSegments`, the legacy `presentCharacter`-field scene plan beside
 * `applySceneSubjectVisual` — and the fact probes are read off both. The digest
 * side must equal the legacy side MODULO the named delta allowlists below, so a
 * lost fact, a new leak, or an unexplained divergence fails here even if the
 * characterization matrix were re-blessed to match it. It kills the quiet
 * failure mode of every "same facts, new wording" migration: a cutover that
 * changed the fact set while everyone was reading the wording diff.
 *
 * The TRANSPORT half is the render-intent capture (`captureRenderIntent`):
 * both sides of a lane are captured as full intents and must agree on
 * everything a provider is configured with — task, profile, strategy, model,
 * reference roles in send order, target shape, negative, controls. Only the
 * prompt hash may move, because moving the prompt is the migration; it is
 * asserted PRESENT on both sides, never equal. The digest side must
 * additionally carry the provenance's required-fact keys and camera
 * fingerprint, which the legacy side by definition cannot.
 *
 * ## Reading a cast of two
 *
 * The Stage 4 cast ≥2 rows are compared PER SUBJECT, and the mechanism is the
 * fixture rather than a parser: the second cast member's every probed value is
 * disjoint from the focal's (`image-lane-probe.ts` §the probe table's second
 * column), so a fact read off a two-subject prompt can only have come from the
 * person who owns that word. `duplicatedVisualFacts` therefore keeps its
 * meaning across subjects too — a production that described the bystander from
 * the FOCAL's digest would state the focal's morphology twice and the
 * bystander's not at all, and both halves fail.
 */

// ---------------------------------------------------------------------------
// Fixtures: both assemblies per lane, over one character — and over two
// where the lane draws a cast
// ---------------------------------------------------------------------------

const dressed = laneProbeWardrobe();
const avatarAssembly = laneProbeAvatarSegments(dressed);
const legacyAvatarPrompt = buildAvatarPrompt(LANE_PROBE_NAME, laneProbeProfile(), "realistic", dressed);

/** The variant/edit lane's two builds, from the same fixture and the same requested change. */
const VARIANT_INSTRUCTION = "wearing a floor-length wine-red silk kimono";
const variantAssembly = laneProbeVariantSegments("outfit", VARIANT_INSTRUCTION);
const legacyVariantPrompt = buildVariantInstruction("outfit", VARIANT_INSTRUCTION, {
  // The caller-supplied anchor is the coupling the cutover removes; the legacy
  // side must be built WITH it, or the comparison would credit the digest with
  // an age fact the old lane also had.
  ageAnchor: apparentAgeAnchor(LANE_PROBE_NAME, resolveAttributes(laneProbeProfile().attributes, [])),
});

const member = laneProbeCastMember();
/** The legacy plan — `presentCharacter` fields, no digest patch. */
const legacyPlan = laneProbeScenePlan(member);
/** The digest patch over that exact plan — the production cast-1 seam. */
const applied = applySceneSubjectVisual({ plan: legacyPlan, member, shadow: laneProbeShadowInput() });

/** The reserve-time meta fragment a build produced, or a loud failure if it refused. */
function digestMetaOf(build: SceneSubjectVisualBuild): Record<string, unknown> {
  if (build.refusal !== null || build.digestMeta === undefined) {
    throw new Error(`the digest patch refused the fixture: ${build.refusal ?? "no digestMeta"}`);
  }
  return build.digestMeta;
}

/**
 * The cast of TWO — the Stage 4 multi-character scene. The bystander is a
 * different species with their own morphology, their own colours and a wardrobe
 * that leaves the feet bare where the focal's slippers do not, so one prompt
 * carries both directions of the coverage gate and no word in it is ambiguous
 * about whom it describes.
 */
const castSubjects = laneProbeCastSubjects();
/** The legacy cast plan — `presentCharacter` fields for BOTH people, no digest patch. */
const legacyCastPlan = laneProbeCastScenePlan(castSubjects.map((subject) => subject.member));
/** The cast digest production over that exact plan — one pass, every subject. */
const castApplied = applySceneCastVisual({ plan: legacyCastPlan, members: castSubjects });

/** The chat-look mint's two builds, from the same fixture and the same requested outfit. */
const CHAT_LOOK_OUTFIT = "a floor-length wine-red silk kimono";
const chatLookAssembly = buildChatLookSegments({
  outfit: CHAT_LOOK_OUTFIT,
  outfitExposed: false,
  shadow: laneProbeShadowInput(),
  exposure: laneProbeDressedExposure(),
});
const legacyChatLookPrompt = buildChatLookPrompt({ outfit: CHAT_LOOK_OUTFIT, outfitExposed: false });

// ---------------------------------------------------------------------------
// Fact-set comparison — intentional deltas as named allowlists
// ---------------------------------------------------------------------------

interface CutoverDelta {
  /** Probe keys the legacy build states that the digest build deliberately does not. */
  readonly removed: readonly string[];
  /** Probe keys the digest build states that the legacy build never did. */
  readonly added: readonly string[];
}

/** The avatar cutover promised an unchanged fact set, and this holds it to that. */
const AVATAR_DELTA: CutoverDelta = { removed: [], added: [] };

/**
 * The text-to-image scene fix the plan promised: the exposure-blind appearance
 * summary leaked covered `imageReveal: "skin"` detail (painted toenails under
 * slippers); the digest's coverage-aware residue does not.
 */
const SCENE_T2I_DRESSED_DELTA: CutoverDelta = { removed: ["toenails"], added: [] };

/**
 * The reference-lane gain: pre-cutover reference rows carried no morphology at
 * all — they leaned entirely on the reference image, and a species appendage is
 * exactly the anchor an edit model "corrects" away. The digest's mandatory
 * morphology clauses close that gap.
 */
const SCENE_REFERENCE_DELTA: CutoverDelta = { removed: [], added: ["horns", "wings", "tail"] };

/**
 * The variant lane's gain, and the whole of it: the same morphology anchors,
 * for the same reason. The owner ruling that sized this cutover kept hair, eye
 * and skin colour OUT — the reference photograph states them better than any
 * sentence — so a row that started adding those would be a scope breach, not an
 * improvement, and would fail here.
 */
const VARIANT_DELTA: CutoverDelta = { removed: [], added: ["horns", "wings", "tail"] };

/**
 * The chat-look mint's gain, and the whole of it: the same morphology anchors,
 * for the same reason as its sibling edit lane. Everything else the legacy
 * builder said, it still says — the outfit change is the only fact those three
 * hard-coded sentences ever carried.
 *
 * What this delta deliberately does NOT list is the cataloged distinctive mark.
 * The chat SHADOW road projects none (the standalone snapshot road does), so
 * this lane states none, and the asymmetry is a measured projection fact left
 * to `visual-state.plan.md` rather than a delta to be allowlisted away here.
 * `lane-characterization.test.ts` owns the pin for it, over the marked profile
 * this fixture deliberately does not use.
 */
const CHAT_LOOK_DELTA: CutoverDelta = { removed: [], added: ["horns", "wings", "tail"] };

/**
 * The cast ≥2 text-to-image row, for the FOCAL: the same covered-skin fix the
 * cast-1 row records, unchanged by the second person in frame.
 */
const SCENE_CAST_T2I_FOCAL_DELTA: CutoverDelta = { removed: ["toenails"], added: [] };

/**
 * The cast ≥2 text-to-image row, for the BYSTANDER: not one fact moved.
 *
 * That is the claim worth having. Everything the bystander used to get from the
 * legacy per-person summary is still there, now sourced from their OWN
 * committed cut, and nothing new leaked in with it. Their `imageReveal: "skin"`
 * toenails survive
 * on both sides while the focal's disappear from the digest side in the very
 * same prompt, which is the coverage gate proven per subject rather than per
 * render: the bystander's wardrobe leaves the feet bare, the focal's slippers
 * do not.
 */
const SCENE_CAST_T2I_BYSTANDER_DELTA: CutoverDelta = { removed: [], added: [] };

/**
 * The cast ≥2 multi-reference row, applied to BOTH subjects from this ONE
 * constant — which is the point of it. The plan's ruling is "reference count
 * does not change character wording", and the failure mode it guards is a
 * second appearance algorithm growing for `others`. Asserting the bystander's
 * delta EQUALS the focal's, rather than merely being non-empty, is what makes
 * that testable: the bystander gains the digest's mandatory morphology anchors
 * exactly as the focal does, in their own species' words, because the same one
 * production wrote both.
 */
const SCENE_CAST_REFERENCE_DELTA: CutoverDelta = { removed: [], added: ["horns", "wings", "tail"] };

/**
 * Legacy facts ± the NAMED deltas must be exactly the digest facts — and the
 * deltas must be REAL (a "removed" key the legacy build never stated, or an
 * "added" key it already had, is a stale allowlist hiding drift). Zero
 * duplicated facts on the digest side is the comparison rule's own clause.
 *
 * `probes` chooses WHOSE facts are read. Passing the second cast member's probe
 * set reads their facts off the same two-subject prompt, because their every value
 * is disjoint from the focal's.
 */
function expectCutoverFacts(
  legacyPrompt: string,
  digestPrompt: string,
  delta: CutoverDelta,
  probes: readonly VisualFactProbe[] = VISUAL_FACT_PROBES,
): void {
  const legacy = presentVisualFacts(legacyPrompt, probes);
  for (const key of delta.removed) expect(legacy).toContain(key);
  for (const key of delta.added) expect(legacy).not.toContain(key);
  const expected = probes
    .map((probe) => probe.key)
    .filter((key) => delta.added.includes(key) || (legacy.includes(key) && !delta.removed.includes(key)));
  expect(presentVisualFacts(digestPrompt, probes)).toEqual(expected);
  expect(duplicatedVisualFacts(digestPrompt, probes)).toEqual([]);
}

describe("lane cutover comparison — character facts, legacy vs digest", () => {
  it("avatar: the digest assembly changed no fact", () => {
    expect(avatarAssembly.missingRequired).toEqual([]);
    expectCutoverFacts(legacyAvatarPrompt, avatarAssembly.prompt, AVATAR_DELTA);
  });

  it("portrait variant: only the digest's morphology anchors joined", () => {
    expect(variantAssembly.missingRequired).toEqual([]);
    expectCutoverFacts(legacyVariantPrompt, variantAssembly.prompt, VARIANT_DELTA);
  });

  it("scene, text-to-image: only the covered-skin leak closed", () => {
    expectCutoverFacts(buildSceneRenderPrompt(legacyPlan, {}), buildSceneRenderPrompt(applied.plan, {}), SCENE_T2I_DRESSED_DELTA);
  });

  it("scene, single reference: only the morphology anchors joined", () => {
    const options = { referenceName: LANE_PROBE_NAME };
    expectCutoverFacts(
      buildSceneRenderPrompt(legacyPlan, options),
      buildSceneRenderPrompt(applied.plan, options),
      SCENE_REFERENCE_DELTA,
    );
  });

  it("scene, multi reference: the same gain through the second assembler", () => {
    const options = {
      multiReferences: [
        { name: LANE_PROBE_NAME, kind: "character" as const },
        { name: "the study", kind: "location" as const },
      ],
    };
    expectCutoverFacts(
      buildSceneRenderPrompt(legacyPlan, options),
      buildSceneRenderPrompt(applied.plan, options),
      SCENE_REFERENCE_DELTA,
    );
  });

  it("chat look: only the digest's morphology anchors joined the outfit change", () => {
    expect(chatLookAssembly.refusal).toBeNull();
    expectCutoverFacts(legacyChatLookPrompt, chatLookAssembly.prompt, CHAT_LOOK_DELTA);
  });

  it("scene cast of two, text-to-image: the focal's covered-skin leak closed, the bystander unchanged", () => {
    expect(castApplied.refusal).toBeNull();
    const legacy = buildSceneRenderPrompt(legacyCastPlan, {});
    const digest = buildSceneRenderPrompt(castApplied.plan, {});
    expectCutoverFacts(legacy, digest, SCENE_CAST_T2I_FOCAL_DELTA);
    expectCutoverFacts(legacy, digest, SCENE_CAST_T2I_BYSTANDER_DELTA, SECOND_SUBJECT_VISUAL_FACT_PROBES);
  });

  it("scene cast of two, multi reference: the bystander gains the same anchors the focal does", () => {
    expect(castApplied.refusal).toBeNull();
    // BOTH people are reference images here, which is the rung where the gain
    // lives: the legacy identity-anchor whitelist carried no morphology for
    // anybody, so each subject's `identityAnchors` gains their own species'
    // appendages — and a `others` production that had drifted from the focal's
    // would fail on the SAME delta constant being applied to both.
    const options = {
      multiReferences: [
        { name: LANE_PROBE_NAME, kind: "character" as const },
        { name: LANE_PROBE_SECOND_NAME, kind: "character" as const },
      ],
    };
    const legacy = buildSceneRenderPrompt(legacyCastPlan, options);
    const digest = buildSceneRenderPrompt(castApplied.plan, options);
    expectCutoverFacts(legacy, digest, SCENE_CAST_REFERENCE_DELTA);
    expectCutoverFacts(legacy, digest, SCENE_CAST_REFERENCE_DELTA, SECOND_SUBJECT_VISUAL_FACT_PROBES);
  });
});

// ---------------------------------------------------------------------------
// Transport comparison — the render-intent capture over both builds
// ---------------------------------------------------------------------------

/** One task profile the way the pure suites build them: schema-parsed rows, no registry read. */
function laneProfile(over: {
  task: ImageProfileTask;
  operation: ImageProfileOperation;
  promptStrategy: ImagePromptStrategy;
}): ResolvedImageProfile {
  return {
    model: imageModelSchema.parse({
      id: `mdl-${over.task}`,
      slug: `vesper-test/cutover-${over.task}`,
      label: "Cutover Fixture",
      canGenerate: true,
      canEdit: true,
      referenceField: "image",
      referenceArity: "array",
      maxReferences: 3,
      supportedAspects: ["3:4"],
      advancedCapabilities: {
        controls: { negativePrompt: { field: "negative_prompt", type: "string" } },
        knownInputFields: ["negative_prompt"],
      },
    }),
    profile: imageModelProfileSchema.parse({
      id: `prf-${over.task}`,
      imageModelId: `mdl-${over.task}`,
      key: `cutover-${over.task}`,
      label: "Cutover Fixture",
      task: over.task,
      operation: over.operation,
      promptStrategy: over.promptStrategy,
      // A real negative on the profile, so the capture's negative half is
      // exercised rather than vacuously null-equal.
      controlDefaults: { negativePrompt: "blurry, watermark" },
    }),
  };
}

const RUNTIME = { safetyCheckerDisabled: false };
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function must(result: CaptureRenderIntentResult): RenderIntentCapture {
  if (!result.ok) throw new Error(`capture refused: ${result.refusal.message}`);
  return result.capture;
}

/** Everything but the fields a cutover is ALLOWED to move. */
function transportOf(capture: RenderIntentCapture): Omit<
  RenderIntentCapture,
  "promptHash" | "requiredFactKeys" | "cameraFingerprint"
> {
  const { promptHash, requiredFactKeys, cameraFingerprint, ...transport } = capture;
  void promptHash;
  void requiredFactKeys;
  void cameraFingerprint;
  return transport;
}

/**
 * The shared parity claim: transport identical, a real prompt hash on each side
 * (equality deliberately NOT asserted — rewording is the migration), a real
 * shared negative, and the digest provenance only where a digest exists.
 */
function expectTransportParity(legacy: RenderIntentCapture, digest: RenderIntentCapture): void {
  expect(transportOf(digest)).toEqual(transportOf(legacy));
  expect(legacy.promptHash).toMatch(HEX_SHA256);
  expect(digest.promptHash).toMatch(HEX_SHA256);
  expect(legacy.negativeHash).toBe(sha256Hex("blurry, watermark"));
  expect(legacy.requiredFactKeys).toEqual([]);
  expect(legacy.cameraFingerprint).toBeNull();
  expect(digest.requiredFactKeys.length).toBeGreaterThan(0);
  expect(digest.cameraFingerprint).toMatch(/./);
}

/** One lane's two intents: identical configuration, the wording the cutover moved. */
interface LaneTransportPair {
  readonly profile: ResolvedImageProfile;
  readonly requestedOperation: ImageProfileOperation;
  readonly references: ImageRenderIntent["references"];
  readonly legacyPrompt: string;
  readonly digestPrompt: string;
  /**
   * The segment channel, set ONLY by the lanes whose production sets it on the
   * intent. It is deliberately absent for the scene lane: that lane hands the
   * provider an adapted STRING (identity-lock dialects, the 1,500-char
   * budgeter), and segments would become authoritative over it.
   */
  readonly digestSegments?: ImageRenderIntent["promptSegments"];
  readonly digestMeta: Record<string, unknown>;
  readonly subjectIds?: readonly string[];
}

/**
 * Capture both sides of one lane and assert the shared parity claim. Every lane
 * differs only in its profile, its references and its two prompts, so the
 * construction lives here once — a per-lane copy of it would be four
 * near-identical blocks whose drift is invisible.
 */
function captureCutoverPair(lane: LaneTransportPair): {
  legacy: RenderIntentCapture;
  digest: RenderIntentCapture;
} {
  const subjectIds = lane.subjectIds ?? [LANE_PROBE_SUBJECT_ID];
  const intent = (prompt: string, segments?: ImageRenderIntent["promptSegments"]): ImageRenderIntent => ({
    profile: lane.profile,
    prompt,
    ...(segments === undefined ? {} : { promptSegments: segments }),
    references: lane.references,
    target: { aspectRatio: IMAGE_TARGET_ASPECT },
  });
  const shared = { runtime: RUNTIME, requestedOperation: lane.requestedOperation, subjectIds };
  const legacy = must(captureRenderIntent({ intent: intent(lane.legacyPrompt), ...shared }));
  const digest = must(
    captureRenderIntent({
      intent: intent(lane.digestPrompt, lane.digestSegments),
      ...shared,
      digestMeta: lane.digestMeta,
    }),
  );
  expectTransportParity(legacy, digest);
  return { legacy, digest };
}

/** The one identity reference an edit lane sends. */
const IDENTITY_REFERENCE: ImageRenderIntent["references"] = [
  { role: "identity", required: true, buffer: Buffer.from("identity-anchor"), name: LANE_PROBE_NAME },
];

describe("lane cutover comparison — transport, legacy vs digest", () => {
  it("avatar: same configuration, moved wording, provenance only on the digest side", () => {
    const { digest } = captureCutoverPair({
      profile: laneProfile({ task: "portrait", operation: "generate", promptStrategy: "text_to_image_description" }),
      requestedOperation: "generate",
      references: [],
      legacyPrompt: legacyAvatarPrompt,
      digestPrompt: avatarAssembly.prompt,
      digestSegments: avatarAssembly.segments,
      digestMeta: avatarAssembly.digestMeta,
    });
    expect(digest.referenceRoles).toEqual([]);
    expect(digest.targetAspect).toBe(IMAGE_TARGET_ASPECT);
    // The avatar lane's stated seam contract: with every seeded prompt budget
    // empty, the intent's segment channel compiles to exactly the stored
    // fallback string — the two spellings of the request cannot diverge.
    expect(digest.promptHash).toBe(sha256Hex(avatarAssembly.prompt));
  });

  it("portrait variant: the segment channel and the stored prompt are the same bytes", () => {
    const { digest } = captureCutoverPair({
      profile: laneProfile({ task: "variant", operation: "edit", promptStrategy: "instruction_edit" }),
      requestedOperation: "edit",
      references: IDENTITY_REFERENCE,
      legacyPrompt: legacyVariantPrompt,
      digestPrompt: variantAssembly.prompt,
      digestSegments: variantAssembly.segments,
      digestMeta: variantAssembly.digestMeta,
    });
    expect(digest.referenceRoles).toEqual(["identity"]);
    // The claim this case exists for, and the reason the variant lane sets a
    // channel the scene lane deliberately does not: `generateVariant` puts the
    // SAME request on `prompt` and on `intent.promptSegments`, and the two
    // spellings must not diverge — the row stores the string while the provider
    // is sent whatever the plan compiles, so a divergence means every variant
    // row documents a prompt nobody rendered. The lane's stated justification is
    // that its profiles run `instruction_edit`, which passes the base prompt
    // through unchanged; move one onto a rewriting strategy, or stop compiling
    // the segments the way the kernel does, and this is where it shows.
    // (Whether segments WIN over the string is the kernel's own contract, tested
    // where `resolveIntentPrompt` lives, not re-proved here.)
    expect(digest.promptHash).toBe(sha256Hex(variantAssembly.prompt));
  });

  it("scene, single-reference rung: same roles in send order around the digest patch", () => {
    const options = { referenceName: LANE_PROBE_NAME };
    const { digest } = captureCutoverPair({
      profile: laneProfile({ task: "scene", operation: "edit", promptStrategy: "instruction_edit" }),
      requestedOperation: "edit",
      references: IDENTITY_REFERENCE,
      legacyPrompt: buildSceneRenderPrompt(legacyPlan, options),
      digestPrompt: buildSceneRenderPrompt(applied.plan, options),
      digestMeta: digestMetaOf(applied),
    });
    expect(digest.referenceRoles).toEqual(["identity"]);
  });

  it("scene cast of two: both references in send order, and the row's fact keys cover both people", () => {
    const options = {
      multiReferences: [
        { name: LANE_PROBE_NAME, kind: "character" as const },
        { name: LANE_PROBE_SECOND_NAME, kind: "character" as const },
      ],
    };
    const { digest } = captureCutoverPair({
      profile: laneProfile({ task: "scene", operation: "edit", promptStrategy: "instruction_edit" }),
      requestedOperation: "edit",
      references: [
        ...IDENTITY_REFERENCE,
        { role: "identity", required: true, buffer: Buffer.from("second-anchor"), name: LANE_PROBE_SECOND_NAME },
      ],
      legacyPrompt: buildSceneRenderPrompt(legacyCastPlan, options),
      digestPrompt: buildSceneRenderPrompt(castApplied.plan, options),
      digestMeta: digestMetaOf(castApplied),
      subjectIds: [LANE_PROBE_SUBJECT_ID, LANE_PROBE_SECOND_SUBJECT_ID],
    });
    expect(digest.referenceRoles).toEqual(["identity", "identity"]);
    // The merge's own claim, and the only place it is observable: one render,
    // N cuts, ONE `meta.visualState` record — and `mergeVisualImageProvenance`
    // CONCATENATES the per-subject records rather than letting the head or the
    // last write win. Required-fact keys are subject-scoped, so a merge that
    // kept one record would leave the row unable to answer "did this render
    // actually state the bystander's wings?", which is the question the
    // provenance exists for. Counts are compared rather than key strings: the
    // ruling is that the bystander is described by the same production, not
    // that the two fixtures happen to hold the same anchors.
    const requiredFor = (subjectId: string): string[] =>
      digest.requiredFactKeys.filter((key) => key.startsWith(`${subjectId}/`));
    expect(requiredFor(LANE_PROBE_SUBJECT_ID).length).toBeGreaterThan(0);
    expect(requiredFor(LANE_PROBE_SECOND_SUBJECT_ID).length).toBe(requiredFor(LANE_PROBE_SUBJECT_ID).length);
  });
});

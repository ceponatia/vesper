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
  LANE_PROBE_SUBJECT_ID,
  laneProbeAvatarSegments,
  laneProbeCastMember,
  laneProbeProfile,
  laneProbeScenePlan,
  laneProbeShadowInput,
  laneProbeWardrobe,
  presentVisualFacts,
  VISUAL_FACT_PROBES,
} from "@/server/test-support";
import { buildAvatarPrompt } from "./prompts-avatar";
import { buildSceneRenderPrompt } from "./prompts-scene-render";
import { sha256Hex } from "./render-fingerprint";
import {
  captureRenderIntent,
  type CaptureRenderIntentResult,
  type RenderIntentCapture,
} from "./render-intent-capture";
import { applySceneSubjectVisual } from "./scene-subject-visual";

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
 * `buildAvatarSegments`, the legacy `presentCharacter`-field scene plan beside
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
 */

// ---------------------------------------------------------------------------
// Fixture: one character, both assemblies per lane
// ---------------------------------------------------------------------------

const dressed = laneProbeWardrobe();
const avatarAssembly = laneProbeAvatarSegments(dressed);
const legacyAvatarPrompt = buildAvatarPrompt(LANE_PROBE_NAME, laneProbeProfile(), "realistic", dressed);

const member = laneProbeCastMember();
/** The legacy plan — `presentCharacter` fields, no digest patch. */
const legacyPlan = laneProbeScenePlan(member);
/** The digest patch over that exact plan — the production cast-1 seam. */
const applied = applySceneSubjectVisual({ plan: legacyPlan, member, shadow: laneProbeShadowInput() });

function appliedDigestMeta(): Record<string, unknown> {
  if (applied.refusal !== null || applied.digestMeta === undefined) {
    throw new Error(`the digest patch refused the fixture: ${applied.refusal ?? "no digestMeta"}`);
  }
  return applied.digestMeta;
}

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
 * Legacy facts ± the NAMED deltas must be exactly the digest facts — and the
 * deltas must be REAL (a "removed" key the legacy build never stated, or an
 * "added" key it already had, is a stale allowlist hiding drift). Zero
 * duplicated facts on the digest side is the comparison rule's own clause.
 */
function expectCutoverFacts(legacyPrompt: string, digestPrompt: string, delta: CutoverDelta): void {
  const legacy = presentVisualFacts(legacyPrompt);
  for (const key of delta.removed) expect(legacy).toContain(key);
  for (const key of delta.added) expect(legacy).not.toContain(key);
  const expected = VISUAL_FACT_PROBES.map((probe) => probe.key).filter(
    (key) => delta.added.includes(key) || (legacy.includes(key) && !delta.removed.includes(key)),
  );
  expect(presentVisualFacts(digestPrompt)).toEqual(expected);
  expect(duplicatedVisualFacts(digestPrompt)).toEqual([]);
}

describe("lane cutover comparison — character facts, legacy vs digest", () => {
  it("avatar: the digest assembly changed no fact", () => {
    expect(avatarAssembly.missingRequired).toEqual([]);
    expectCutoverFacts(legacyAvatarPrompt, avatarAssembly.prompt, AVATAR_DELTA);
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

describe("lane cutover comparison — transport, legacy vs digest", () => {
  it("avatar: same configuration, moved wording, provenance only on the digest side", () => {
    const portrait = laneProfile({ task: "portrait", operation: "generate", promptStrategy: "text_to_image_description" });
    const intent = (prompt: string, segments?: ImageRenderIntent["promptSegments"]): ImageRenderIntent => ({
      profile: portrait,
      prompt,
      ...(segments === undefined ? {} : { promptSegments: segments }),
      references: [],
      target: { aspectRatio: IMAGE_TARGET_ASPECT },
    });
    const legacy = must(
      captureRenderIntent({
        intent: intent(legacyAvatarPrompt),
        runtime: RUNTIME,
        requestedOperation: "generate",
        subjectIds: [LANE_PROBE_SUBJECT_ID],
      }),
    );
    const digest = must(
      captureRenderIntent({
        intent: intent(avatarAssembly.prompt, avatarAssembly.segments),
        runtime: RUNTIME,
        requestedOperation: "generate",
        subjectIds: [LANE_PROBE_SUBJECT_ID],
        digestMeta: avatarAssembly.digestMeta,
      }),
    );
    expectTransportParity(legacy, digest);
    expect(digest.referenceRoles).toEqual([]);
    expect(digest.targetAspect).toBe(IMAGE_TARGET_ASPECT);
    // The avatar lane's stated seam contract: with every seeded prompt budget
    // empty, the intent's segment channel compiles to exactly the stored
    // fallback string — the two spellings of the request cannot diverge.
    expect(digest.promptHash).toBe(sha256Hex(avatarAssembly.prompt));
  });

  it("scene, single-reference rung: same roles in send order around the digest patch", () => {
    const scene = laneProfile({ task: "scene", operation: "edit", promptStrategy: "instruction_edit" });
    const references = [
      { role: "identity" as const, required: true, buffer: Buffer.from("identity-anchor"), name: LANE_PROBE_NAME },
    ];
    const options = { referenceName: LANE_PROBE_NAME };
    const intent = (prompt: string): ImageRenderIntent => ({
      profile: scene,
      prompt,
      references,
      target: { aspectRatio: IMAGE_TARGET_ASPECT },
    });
    const legacy = must(
      captureRenderIntent({
        intent: intent(buildSceneRenderPrompt(legacyPlan, options)),
        runtime: RUNTIME,
        requestedOperation: "edit",
        subjectIds: [LANE_PROBE_SUBJECT_ID],
      }),
    );
    const digest = must(
      captureRenderIntent({
        intent: intent(buildSceneRenderPrompt(applied.plan, options)),
        runtime: RUNTIME,
        requestedOperation: "edit",
        subjectIds: [LANE_PROBE_SUBJECT_ID],
        digestMeta: appliedDigestMeta(),
      }),
    );
    expectTransportParity(legacy, digest);
    expect(digest.referenceRoles).toEqual(["identity"]);
  });
});

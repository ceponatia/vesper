import {
  affordancePerceptionView,
  bodyLocationRegistry,
  exposedRegions,
  FULLY_COVERED,
  resolveVisualViewingConditions,
  selectVisualImageFacts,
  visualCameraReadsOfSceneCamera,
  type AffordanceExposure,
  type AffordancePerceptionView,
  type AttributeValue,
  type DiagnosticSink,
  type RealizedBody,
  type RegionExposure,
  type SceneCameraSpec,
  type VisualAttentionContext,
  type VisualImageDigest,
  type WornItemInput,
} from "@/contracts";
import {
  buildVisualSubjectSegments,
  type VisualSegmentTaskPolicy,
  type VisualSubjectSegmentsBuild,
} from "@/contracts/images/visual-segments";
import type { CharacterProfile } from "@/contracts/world/profile";
import { assembleVisualStateSnapshot, buildVisualStateImageDigest } from "@/server/visual-state";
import { apparentAgeAnchor } from "./prompts-appearance";
import { visualFactClauseResolver } from "./visual-fact-clauses";

/**
 * THE STANDALONE-CHARACTER DIGEST ASSEMBLY — one snapshot → one camera-bound
 * selection → one digest → one
 * subject's semantic segments, for every lane that renders a character with NO
 * chat behind it.
 *
 * A chat-backed render assembles its cut through the shadow factory
 * (`chatVisualStateShadowInput` → `applySceneSubjectVisual`), because a live
 * conversation owns garments, conditions, body surface and scene relations.
 * A standalone render has none of those owners: the character sheet, its
 * default wardrobe and a read token ARE the committed cut. That difference is
 * what this module exists to hold in one place — the avatar lane wrote it
 * inline first (Stage 3), the variant/edit lane needed exactly the same six
 * steps (Stage 4), and the Image Lab's staged bench is the third caller. Three
 * copies of a snapshot → perception → selection → digest → segments chain is
 * precisely the duplication the consolidation plan exists to end.
 *
 * ## What it decides, and what it does not
 *
 * It decides the CUT: which snapshot, which camera, which perception, which
 * exposure readout, and which clause resolver phrase the digest's facts. It
 * decides NOTHING about a lane's own prose — the subject line, the framing
 * sentence, the operation contract, the quality tail and the wardrobe line all
 * stay with the lane, which appends them beside {@link
 * StandaloneSubjectVisual.subject}'s segments.
 *
 * Every lane-specific knob is a parameter rather than a branch, so a second
 * caller cannot quietly acquire the first caller's framing: the camera and its
 * id, the {@link VisualSegmentTaskPolicy}, the clause-resolver omit set, and
 * whether the attention context may see intimate anatomy at all.
 *
 * ## Failure behavior
 *
 * Non-empty `subject.missingRequired` means a required digest fact resolved no
 * clause: the CALLER must refuse before provider spend rather than render a
 * character whose anchors quietly
 * vanished. Nothing here throws for a degraded owner.
 *
 * Pure: no IO, no env, no clock — which is what lets the lane characterization
 * freeze re-run the production assembly without a database.
 */

// ---------------------------------------------------------------------------
// Coverage degradation and the camera's perception
// ---------------------------------------------------------------------------

/**
 * The wardrobe the degraded perception reads instead of an unreadable one:
 * opaque cover over the four exposure-region roots — exactly the regions
 * `FULLY_COVERED` claims — so the camera's per-location answers and the
 * exposure readout degrade to the SAME fully-covered body. Locations no
 * exposure region reaches (head, face, hair, hands, arms, wings, horns, tail)
 * stay in plain view, which is what keeps a portrait's identity and morphology
 * facts resolvable; the mandatory lane never consults perception at all
 * (selection invariant 7), so this degrade can only suppress OPTIONAL detail —
 * a chest tattoo under the saved outfit goes unstated instead of being
 * asserted onto a body the camera could not actually see.
 */
const UNKNOWN_COVERAGE_WORN: readonly WornItemInput[] = [
  {
    instanceId: "wardrobe:unknown",
    garmentId: "wardrobe:unknown",
    name: "unknown wardrobe",
    coverage: ["torso", "pelvis", "legs", "feet"],
    layer: 3,
    opacity: "opaque",
  },
];

/**
 * Per-body-location exposure from the worn coverage — the camera's perception
 * view. The optional selection lane fails closed on an unlisted location, so a
 * studio portrait must positively answer for the whole body: an opaque garment
 * hides what it covers, a sheer one hints it, and everything else is in plain
 * view of the camera. Same coverage expansion as `exposedRegions`, read per
 * location instead of per region.
 *
 * `coverageUnreadable` is the perception half of the FULLY_COVERED degrade:
 * when the wardrobe (or its coverage) could not be read, the camera reads
 * {@link UNKNOWN_COVERAGE_WORN} instead of the failed-empty list — every
 * location a fully-covering wardrobe hides answers `hidden`, never `visible`.
 * Exported so the degrade's per-location answers stay pinned by test, and
 * re-exported from `avatar-segments.ts` where that pin has always imported it.
 */
export function portraitPerception(
  worn: readonly WornItemInput[],
  coverageUnreadable = false,
): AffordancePerceptionView {
  const opaque = new Set<string>();
  const sheer = new Set<string>();
  for (const item of coverageUnreadable ? UNKNOWN_COVERAGE_WORN : worn) {
    const into = item.opacity === "sheer" ? sheer : opaque;
    for (const cover of item.coverage) {
      if (bodyLocationRegistry.byId(cover) === undefined) continue;
      for (const location of bodyLocationRegistry.expand(cover)) into.add(location);
    }
  }
  const exposure: Record<string, AffordanceExposure> = {};
  for (const location of bodyLocationRegistry.all) {
    exposure[location.id] = opaque.has(location.id) ? "hidden" : sheer.has(location.id) ? "hinted" : "visible";
  }
  return affordancePerceptionView({ exposure });
}

/**
 * The one attention context the selection AND the digest run under. Lighting
 * and motion are the release's declared bases (nothing owns a studio lamp as
 * typed data); distance, angle and framing are the lane camera's own reads, so
 * a full-figure edit camera and a waist-up portrait camera select different
 * optional detail without either lane hand-picking facts.
 */
function standaloneVisualContext(
  perception: AffordancePerceptionView,
  camera: SceneCameraSpec,
  cameraId: string,
  intimateAllowed: boolean,
): VisualAttentionContext {
  const reads = visualCameraReadsOfSceneCamera(camera);
  return {
    viewpoint: { kind: "camera", cameraId },
    perception,
    ...resolveVisualViewingConditions(),
    distance: reads.distance,
    angle: reads.angle,
    framing: reads.framing,
    intimateAllowed,
    consumer: "image",
  };
}

// ---------------------------------------------------------------------------
// Input and result
// ---------------------------------------------------------------------------

export interface StandaloneSubjectVisualInput {
  readonly characterId: string;
  /** The character's display name — the age anchor's grammatical subject. */
  readonly name: string;
  readonly profile: CharacterProfile;
  /**
   * The standalone read token (`standaloneCharacterReadToken`) — the character
   * row's revision plus the wardrobe rows'. Stands in for a committed cut: it
   * is the snapshot's `cutId`, the digest's `forCutId`, and the provenance's
   * committed-cut name.
   */
  readonly readToken: string;
  /**
   * The default outfit as shared worn inputs (`toWornInputs`) — the ONE source
   * for both the coverage readout and the camera's per-location perception, so
   * the two halves can never disagree about what a garment hides.
   */
  readonly worn: readonly WornItemInput[];
  /**
   * The wardrobe lookup FAILED — `worn` is unknown state, not a confirmed
   * undressed character. Coverage then reads as unreadable: no exposure claims
   * and no coverage-gated reveals (`images.avatar.outfit_load_failed` fires at
   * the load site).
   */
  readonly wardrobeUnavailable?: boolean;
  /**
   * ≥1 loaded garment's coverage column was unreadable
   * (`AvatarWardrobeLoad.coverageUnreliableIds`) — the wardrobe LIST is real
   * but its coverage is unknown state. Exposure and the camera's perception
   * degrade exactly as `wardrobeUnavailable`'s do: fully covered, no reveals —
   * a malformed row must not undress the body it dresses.
   */
  readonly coverageUnreliable?: boolean;
  /** The lane's fixed viewpoint; its shot distance decides the framing band. */
  readonly camera: SceneCameraSpec;
  /** The camera id the selection fingerprints — a lane's studio viewpoint, not a committed scene camera. */
  readonly cameraId: string;
  readonly policy: VisualSegmentTaskPolicy;
  /** Attribute ids this lane's curated policy withholds from the DIGEST's clauses. */
  readonly omitAttributeIds?: ReadonlySet<string>;
  /**
   * Whether the attention context may see intimate anatomy at all — the
   * digest's own consent gate, upstream of `policy.intimate`. A lane that
   * states intimate anatomy from its own route-owned sheet leaves this false,
   * so the digest never carries a second copy of it.
   */
  readonly intimateAllowed: boolean;
  readonly sink?: DiagnosticSink;
}

export interface StandaloneSubjectVisual {
  /** The digest's segments for this subject, plus its suppressions and missing anchors. */
  readonly subject: VisualSubjectSegmentsBuild;
  /**
   * The realized visual image digest itself — the ONE cut both prompt roads
   * describe. The Round 2 shadow instrumentation (`character-shadow.ts`) reads
   * it to assemble the compiled-program side from the very selection the
   * segments were built from, never a re-select.
   */
  readonly digest: VisualImageDigest;
  /** The `meta.visualState` fragment the row records at reserve time. */
  readonly digestMeta: Record<string, unknown>;
  /** Base + persisted overlays — the canonical owner a lane's own prose phrases from. */
  readonly resolved: readonly AttributeValue[];
  /** The realized body, so a lane's residue can drop attributes this body does not have. */
  readonly realizedBody: RealizedBody;
  /** The canonical garment-coverage readout, computed once over the FULL wardrobe. */
  readonly exposure: RegionExposure;
  /**
   * `apparentAgeAnchor` over the resolved attributes — empty for the minor and
   * unknown bands. Derived here rather than per lane so the two lanes that
   * state age (avatar, variant) cannot word it differently.
   */
  readonly ageAnchor: string;
}

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

/**
 * Build one standalone character's visual cut and its subject segments.
 *
 * ONE snapshot, ONE camera-bound selection pass, one digest realized from that
 * exact selection — never a re-select, which would fingerprint a camera nobody
 * selected under (`image-digest.ts` §Reuse the selection).
 */
export function buildStandaloneSubjectVisual(input: StandaloneSubjectVisualInput): StandaloneSubjectVisual {
  const { profile, sink } = input;
  // The canonical exposure readout, computed ONCE over the FULL wardrobe
  // (before any lane's waist-up garment filter): a covering garment still hides
  // its region even when it is dropped from the visible outfit. A FAILED
  // wardrobe load — or one whose coverage columns could not be parsed — is
  // unknown state, not a bare body: coverage degrades to fully covered so the
  // prompt stays silent about exposure (silence IS covered in the builder's
  // contract) instead of asserting a nudity the saved outfit denies. ONE flag
  // drives the exposure readout AND the perception below, so the two halves
  // cannot disagree about what the camera may see.
  const coverageUnreadable = input.wardrobeUnavailable === true || input.coverageUnreliable === true;
  const exposure = coverageUnreadable ? FULLY_COVERED : exposedRegions(input.worn);

  const assembly = assembleVisualStateSnapshot({
    scope: { kind: "standalone_character", characterId: input.characterId },
    cutId: input.readToken,
    // A standalone render has no story clock; zero is the fixed, honest
    // "no elapsed time" answer and keeps the token the only variance source.
    atMinutes: 0,
    subjectId: input.characterId,
    attributes: profile.attributes,
    realize: {
      speciesId: profile.speciesId,
      heritageId: profile.heritageId,
      bodyPlanId: profile.bodyPlanId,
      intimateRegions: profile.intimateRegions,
      bodyFeatures: profile.bodyFeatures,
    },
    ...(sink === undefined ? {} : { sink }),
  });

  const context = standaloneVisualContext(
    portraitPerception(input.worn, coverageUnreadable),
    input.camera,
    input.cameraId,
    input.intimateAllowed,
  );
  const selection = selectVisualImageFacts({
    snapshot: assembly.snapshot,
    context,
    ...(sink === undefined ? {} : { sink }),
  });
  const digestBuild = buildVisualStateImageDigest({
    snapshot: assembly.snapshot,
    context,
    selection,
    forCutId: input.readToken,
    ...(sink === undefined ? {} : { sink }),
  });

  const resolved = assembly.stableResolved;
  const subject = buildVisualSubjectSegments({
    digest: digestBuild.digest,
    subjectId: input.characterId,
    exposure,
    policy: input.policy,
    clause: visualFactClauseResolver({
      attributes: resolved,
      realizedBody: assembly.realizedBody,
      ...(input.omitAttributeIds === undefined ? {} : { omitAttributeIds: input.omitAttributeIds }),
    }),
    ...(sink === undefined ? {} : { sink }),
  });

  return {
    subject,
    digest: digestBuild.digest,
    digestMeta: digestBuild.meta,
    resolved,
    realizedBody: assembly.realizedBody,
    exposure,
    ageAnchor: apparentAgeAnchor(input.name, resolved),
  };
}

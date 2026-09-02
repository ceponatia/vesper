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
import type { CharacterProfile } from "@/contracts/world/profile";
import { assembleVisualStateSnapshot, buildVisualStateImageDigest } from "@/server/visual-state";
import { toWornInputs, type AvatarWardrobeItem } from "./avatar-wardrobe";
import type { CharacterPromptSubjectCut } from "./character-prompt-program";

/**
 * THE STANDALONE-CHARACTER CUT — one snapshot → one camera-bound selection →
 * one digest, for every lane that renders a character with NO chat behind it.
 *
 * A chat-backed render assembles its cut through the shadow factory
 * (`chatVisualStateShadowInput` → `applySceneSubjectVisual`), because a live
 * conversation owns garments, conditions, body surface and scene relations.
 * A standalone render has none of those owners: the character sheet, its
 * default wardrobe and a read token ARE the committed cut. The avatar and
 * variant lanes compile their prompt programs from exactly this cut
 * (`character-prompt-program.ts`), and the Image Lab's staged bench compiles
 * its program from the same cut (`image-lab-staged-visual.ts`).
 *
 * ## What it decides, and what it does not
 *
 * It decides the CUT: which snapshot, which camera, which perception, and which
 * exposure readout. It decides NOTHING about a lane's operation contract, its
 * references or its identity policy — those are the program's inputs, stated
 * by the lane beside the cut. Every lane-specific knob is a parameter rather
 * than a branch, so a second caller cannot quietly acquire the first caller's
 * framing: the camera and its id, and whether the attention context may see
 * intimate anatomy at all.
 *
 * ## Failure behavior
 *
 * Nothing here throws for a degraded owner. A thrown build is a defect, and the
 * CALLER degrades it to a failed row with a diagnostic before provider spend.
 *
 * Pure: no IO, no env, no clock.
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
 * Exported so the degrade's per-location answers stay pinned by test.
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

export interface StandaloneSubjectCutInput {
  readonly characterId: string;
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
  /**
   * Whether the attention context may see intimate anatomy at all — the
   * digest's own consent gate. A route that permits the reveal projects it
   * beside the digest from the same cut (`intimateReveal` on the program), so
   * the digest never carries a second copy of it.
   */
  readonly intimateAllowed: boolean;
  readonly sink?: DiagnosticSink;
}

/**
 * One standalone character's realized cut — the vocabulary the prompt program
 * compiles a subject from (`CharacterPromptSubjectCut`).
 */
export interface StandaloneSubjectCut {
  /** The realized visual image digest itself — the ONE cut every consumer describes. */
  readonly digest: VisualImageDigest;
  /** The `meta.visualState` fragment the row records at reserve time. */
  readonly digestMeta: Record<string, unknown>;
  /** Base + persisted overlays — the canonical owner the program's adapter values facts from. */
  readonly resolved: readonly AttributeValue[];
  /** The realized body, so a stale attribute cannot outlive the body it describes. */
  readonly realizedBody: RealizedBody;
  /** The canonical garment-coverage readout, computed once over the FULL wardrobe. */
  readonly exposure: RegionExposure;
}

/**
 * The lane-facing spelling of {@link StandaloneSubjectCutInput}: the default
 * outfit as loaded wardrobe rows, with the viewpoint supplied by the lane.
 */
export type StandaloneLaneCutInput = Omit<StandaloneSubjectCutInput, "worn" | "camera" | "cameraId" | "intimateAllowed"> & {
  readonly wardrobe: ReadonlyArray<AvatarWardrobeItem>;
};

/** A lane's fixed studio viewpoint. */
export interface StandaloneLaneViewpoint {
  readonly camera: SceneCameraSpec;
  readonly cameraId: string;
}

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

/**
 * Build one standalone character's visual cut.
 *
 * ONE snapshot, ONE camera-bound selection pass, one digest realized from that
 * exact selection — never a re-select, which would fingerprint a camera nobody
 * selected under (`image-digest.ts` §Reuse the selection).
 */
export function buildStandaloneSubjectCut(input: StandaloneSubjectCutInput): StandaloneSubjectCut {
  const { profile, sink } = input;
  // The canonical exposure readout, computed ONCE over the FULL wardrobe. A
  // FAILED wardrobe load — or one whose coverage columns could not be parsed —
  // is unknown state, not a bare body: coverage degrades to fully covered so
  // the prompt stays silent about exposure (silence IS covered in the adapter's
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

  return {
    digest: digestBuild.digest,
    digestMeta: digestBuild.meta,
    resolved: assembly.stableResolved,
    realizedBody: assembly.realizedBody,
    exposure,
  };
}

/**
 * A standalone LANE's cut: the loaded wardrobe rows mapped to worn inputs, under
 * the lane's own viewpoint. The digest never carries intimate anatomy for a
 * standalone lane — the portrait studio is intimate-free by rule, and the
 * variant lane edits from a reference that shows the body — so the consent
 * gate is shut here for both.
 */
export function buildStandaloneLaneCut(
  input: StandaloneLaneCutInput,
  viewpoint: StandaloneLaneViewpoint,
): StandaloneSubjectCut {
  const { wardrobe, ...rest } = input;
  return buildStandaloneSubjectCut({
    ...rest,
    worn: toWornInputs(wardrobe),
    camera: viewpoint.camera,
    cameraId: viewpoint.cameraId,
    intimateAllowed: false,
  });
}

/**
 * The cut in the prompt program's subject vocabulary — the ONE mapping every
 * standalone lane hands `buildCharacterPromptProgram`, so a lane cannot
 * compile from a cut's exposure while stating another's attributes.
 */
export function standaloneSubjectPromptCut(
  cut: StandaloneSubjectCut,
  subject: { readonly subjectId: string; readonly name?: string },
): CharacterPromptSubjectCut {
  return {
    subjectId: subject.subjectId,
    ...(subject.name === undefined ? {} : { name: subject.name }),
    digest: cut.digest,
    attributes: cut.resolved,
    exposure: cut.exposure,
    realizedBody: cut.realizedBody,
  };
}


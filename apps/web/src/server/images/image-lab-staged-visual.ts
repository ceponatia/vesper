import type { ImagePromptSegment } from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { SceneStaging } from "@/contracts/images/scene-staging";
import { standaloneCharacterReadToken } from "@/contracts/images/subject-digest";
import { FULLY_COVERED, type RegionExposure, type WornItemInput } from "@/contracts/items/visibility";
import type { CharacterProfile } from "@/contracts/world/profile";
import { identityAnchorSummary, sceneRevealAppearance } from "./prompts-appearance";
import { SCENE_SEGMENT_POLICY } from "./scene-subject-visual";
import { buildStandaloneSubjectVisual } from "./standalone-subject-visual";
import { RECOGNITION_RESIDUE_ATTRIBUTE_IDS } from "./visual-fact-clauses";

/**
 * THE STAGED BENCH'S SUBJECT FACTS (image-lane-consolidation.plan.md Stage 4;
 * spec.prompts.md §Lane migration order → "Chat look/selfie and staged character
 * renders: Consume the same digest"; owner ruling 2026-08-25).
 *
 * The Image Lab's `staged_scene` kind exists to send the sentence production
 * sends. It was built name-only — the focal spec carried no appearance, no
 * identity anchors and no intimate anatomy, and
 * `intimate-scene-lora.spec.md §"What the bench does NOT reproduce"` recorded
 * that gap deliberately (2026-08-16). The chat scene lane has since moved its
 * character fields onto the visual digest, which turned that recorded gap into a
 * parity BREAK: the bench's prompt is now strictly shorter than the one a chat
 * would have sent for the same staging, and a verdict on the shorter prompt is
 * not a verdict on production's. This module closes it for the default arm.
 *
 * ## The same cut every other chat-less character render takes
 *
 * A bench has no conversation, so it takes the STANDALONE assembly
 * (`buildStandaloneSubjectVisual`) — one snapshot, one camera-bound selection,
 * one digest, one segments pass — exactly as the avatar and variant lanes do.
 * Every knob is set to the CHAT SCENE lane's value rather than a bench-local
 * one, because parity with that lane is the entire claim:
 *
 * - `SCENE_SEGMENT_POLICY` is imported rather than restated. A staged bench that
 *   kept its own copy would keep rendering the old policy the day the scene lane
 *   moved, and the drift would be invisible — the prompts would simply stop
 *   matching, on a paid render, with nothing saying so.
 * - `RECOGNITION_RESIDUE_ATTRIBUTE_IDS` is the same omit set the scene lane's
 *   resolver runs with: a cataloged distinctive mark is phrased by
 *   `identityAnchorSummary` below, so the digest clause omits rather than saying
 *   it twice.
 * - `intimateAllowed: false`, matching the chat lane's own image context
 *   (`buildVisualStateSelections` hard-codes it). Intimate anatomy reaches a
 *   staged prompt through `sceneRevealAppearance` on the uncensored rung, which
 *   is where the per-route gate belongs; letting the digest carry a second copy
 *   would state the same anatomy twice on exactly the prompts that can least
 *   afford the characters.
 *
 * ## The camera and the coverage are the STAGING's, not the character's
 *
 * The camera is `entry.camera` under this lane's own viewpoint id — the staging
 * owns the shot (a surviving staging replaces the plan's camera outright), and
 * the selection has to be fingerprinted under the camera the facts were chosen
 * for.
 *
 * The COVERAGE is the staging's premise and nothing else, and that is the rule
 * this whole file is arranged around. `stagedSubjectExposure` invents an
 * exposure from `entry.requiresBare`: bare exactly where the template describes
 * bare skin, covered everywhere else. It is a statement about the ACT, not about
 * the character's closet, and a real wardrobe read would switch several stagings
 * off — a dressed character would suppress the bare-region phrasing the template
 * is written around, and the bench would quietly pay for an ordinary portrait.
 * So the worn list handed to the standalone assembly is {@link stagedPremiseWorn},
 * which encodes that invented exposure as coverage: the digest's exposure
 * readout and the camera's per-location perception then both answer the premise,
 * and the two halves cannot disagree about what this shot shows.
 *
 * ## Failure behavior (spec.prompts.md §Failure behavior)
 *
 * A required digest fact with no clause refuses the run before provider spend.
 * It does NOT fall back to the name-only ablation: that is an arm the operator
 * did not choose, and silently running it would answer a different question than
 * the row asks. The caller settles the row with `visual_digest_unavailable`.
 *
 * Pure: no IO, no env, no clock.
 */

// ---------------------------------------------------------------------------
// Lane constants
// ---------------------------------------------------------------------------

/**
 * The camera id the selection fingerprints. Named for THIS lane rather than
 * borrowed from the chat scene (`chat_scene`) or the portrait studio
 * (`variant_edit`): the viewpoint id is provenance, and a bench row claiming a
 * committed chat camera would describe a conversation that never happened.
 */
export const STAGED_VISUAL_CAMERA_ID = "image_lab_staged_scene";

/** The standalone assembly threw; the run refuses before any provider spend. */
export const STAGED_VISUAL_DIGEST_UNAVAILABLE = "images.image_lab_staged.visual_digest_unavailable";
/** A required digest fact resolved no clause; the run refuses before any spend. */
export const STAGED_VISUAL_REQUIRED_MISSING = "images.image_lab_staged.visual_required_missing";

// ---------------------------------------------------------------------------
// The staging's premise, as coverage
// ---------------------------------------------------------------------------

/**
 * The subject's coverage: bare for exactly the regions this staging's template
 * describes as bare, covered everywhere else.
 *
 * A bench row states its own exposure because there is no wardrobe state here to
 * derive one from, and it states the MINIMUM the template needs rather than
 * undressing the subject wholesale — `astride_viewer_away` needs a bare pelvis
 * and describes a clothed back, and a prompt that stripped her torso as well
 * would contradict the registry's own wording. An entry with no bare regions
 * (`requiresBare: []`) stays fully covered, and the prompt then falls through to
 * "Keep the same outfit as the reference image", which is the honest instruction
 * for a bench that said nothing about clothes.
 */
export function stagedSubjectExposure(entry: SceneStaging): RegionExposure {
  const exposure: RegionExposure = { ...FULLY_COVERED };
  for (const region of entry.requiresBare) exposure[region] = "bare";
  return exposure;
}

/**
 * The invented exposure expressed as worn coverage — one opaque garment over
 * exactly the regions the staging leaves clothed.
 *
 * It exists because the standalone assembly derives both its exposure readout
 * (`exposedRegions`) and the camera's per-location perception
 * (`portraitPerception`) from ONE worn list, which is the property that keeps
 * those two halves from disagreeing. A bench cannot hand it the character's real
 * closet — see the module note — so it hands it the premise instead, in the same
 * shape the standalone module's own unreadable-coverage sentinel uses: the four
 * exposure-region roots, opaque, minus the ones this act bares.
 *
 * Round-trips for every entry the registry holds: `exposedRegions(stagedPremiseWorn(e))`
 * is `e` again, so nothing downstream can read a coverage the staging did not
 * state. The census in `image-lab-staged.test.ts` pins that per entry rather
 * than trusting it, because the four region roots NEST — `feet` is a child of
 * `legs` in the body-location registry, so covering the leg covers the foot. No
 * entry bares a foot while clothing the leg today, and if one ever does the pin
 * fails loudly and the fix is to name the leg's own locations (thighs, calves,
 * ankles) here instead of its root. A silent over-cover would be the exact
 * failure this file exists to prevent, one region further down.
 */
export function stagedPremiseWorn(exposure: RegionExposure): readonly WornItemInput[] {
  const covered = (Object.keys(FULLY_COVERED) as (keyof RegionExposure)[]).filter(
    (region) => exposure[region] === "covered",
  );
  if (covered.length === 0) return [];
  return [
    {
      instanceId: "staging:premise",
      garmentId: "staging:premise",
      name: "the staging's own coverage",
      coverage: covered,
      layer: 3,
      opacity: "opaque",
    },
  ];
}

// ---------------------------------------------------------------------------
// Field production
// ---------------------------------------------------------------------------

/**
 * The `ScenePresentCharacter` fields the digest produces for the staged subject
 * — the same four the chat scene lane's own field production emits, so a spec
 * built from these is a spec the transport cannot tell apart from a chat's.
 */
export interface StagedSubjectFacts {
  readonly appearance: string;
  readonly identityAnchors: string;
  readonly lowerBody: string;
  readonly intimateAppearance: string;
}

/**
 * The `reference_only` ablation's facts: none at all.
 *
 * A named constant rather than four inline empty strings, because "this arm
 * states nothing about the subject" is the arm's whole definition and a reader
 * of the runner should meet it by name.
 */
export const REFERENCE_ONLY_SUBJECT_FACTS: StagedSubjectFacts = {
  appearance: "",
  identityAnchors: "",
  lowerBody: "",
  intimateAppearance: "",
};

/** The clauses of the named segment kinds, folded as field prose (no trailing period). */
function segmentText(segments: readonly ImagePromptSegment[], kinds: ReadonlySet<string>): string {
  return segments
    .filter((segment) => kinds.has(segment.kind))
    .map((segment) => segment.text.replace(/\.$/, ""))
    .join("; ");
}

const IDENTITY_SEGMENT_KINDS: ReadonlySet<string> = new Set(["identity", "morphology"]);
const STATE_SEGMENT_KINDS: ReadonlySet<string> = new Set(["current_state", "pose"]);

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

export interface StagedSubjectVisualInput {
  readonly characterId: string;
  /** The character's display name, as the staging template binds `{name}` to. */
  readonly name: string;
  readonly profile: CharacterProfile;
  /** `characters.updatedAt` as an ISO string — the read token's only source. */
  readonly revision: string;
  /** The staging being benched; its camera binds the selection. */
  readonly entry: SceneStaging;
  readonly sink?: DiagnosticSink;
}

export type StagedSubjectVisualBuild =
  | {
      readonly ok: true;
      readonly facts: StagedSubjectFacts;
      /**
       * The `meta.visualState` fragment a consuming lane records at reserve
       * time. The lab's shared runner has no per-kind asset-meta channel yet
       * (`storeLabRender` writes a fixed bag), so nothing stores this today —
       * it is returned rather than dropped because the alternative is deriving
       * the provenance a second time when that channel lands, from a digest
       * this function has already thrown away.
       */
      readonly digestMeta: Record<string, unknown>;
    }
  | { readonly ok: false; readonly refusal: string };

/**
 * Describe the staged subject from their own visual digest.
 *
 * The read token is the character row's revision alone. It names every owner
 * that fed this render and no more: the closet is deliberately not one of them
 * (the coverage is the staging's premise), and folding wardrobe revisions in
 * would claim an edit to a garment changes a prompt it cannot reach.
 */
export function buildStagedSubjectVisual(input: StagedSubjectVisualInput): StagedSubjectVisualBuild {
  const { entry, profile, sink } = input;
  const exposure = stagedSubjectExposure(entry);
  const visual = buildStandaloneSubjectVisual({
    characterId: input.characterId,
    name: input.name,
    profile,
    readToken: standaloneCharacterReadToken({ characterId: input.characterId, revision: input.revision }),
    worn: stagedPremiseWorn(exposure),
    camera: entry.camera,
    cameraId: STAGED_VISUAL_CAMERA_ID,
    policy: SCENE_SEGMENT_POLICY,
    omitAttributeIds: RECOGNITION_RESIDUE_ATTRIBUTE_IDS,
    intimateAllowed: false,
    ...(sink === undefined ? {} : { sink }),
  });

  if (visual.subject.missingRequired.length > 0) {
    sink?.push(
      diag("warn", STAGED_VISUAL_REQUIRED_MISSING, "required visual facts resolved no clause for this staged bench", {
        path: "images.image_lab_staged",
        context: { characterId: input.characterId, keys: [...visual.subject.missingRequired] },
      }),
    );
    return {
      ok: false,
      refusal:
        `the production-parity arm describes ${input.name} from their visual digest, and these required facts resolved no wording: ` +
        `${visual.subject.missingRequired.join(", ")}; fix the character sheet, or run the reference-only ablation deliberately`,
    };
  }

  const digestIdentity = segmentText(visual.subject.segments, IDENTITY_SEGMENT_KINDS);
  const digestState = segmentText(visual.subject.segments, STATE_SEGMENT_KINDS);
  return {
    ok: true,
    digestMeta: visual.digestMeta,
    facts: {
      // The transport emits `appearance` only for a TEXTUAL subject, and this
      // kind has none: it sends exactly one identity reference of its one
      // character, so the focal is always the referenced subject and this field
      // never reaches a prompt. It is produced anyway, from the digest, so the
      // plan says what the digest resolved rather than nothing — and the chat
      // lane's route-owned residual attribute sheet is deliberately NOT
      // reproduced beside it: that sheet is the legacy summary Stage 6 deletes,
      // a second copy of it here could only drift, and no staged prompt can
      // carry it in any case.
      appearance: [digestIdentity, digestState].filter(Boolean).join(". "),
      // The one field the identity lock leans on, and the reason the omit set
      // above exists: the whitelist phrase states the recognition catalog, the
      // digest clause states everything else.
      identityAnchors: [identityAnchorSummary(visual.resolved, profile), digestIdentity].filter(Boolean).join("; "),
      // Both reveal lines read the STAGING's exposure, not the closet's — the
      // shot is the premise, and a covered pelvis here would delete the anatomy
      // the act is about.
      lowerBody: sceneRevealAppearance(visual.resolved, exposure, profile, { intimate: false }),
      intimateAppearance: sceneRevealAppearance(visual.resolved, exposure, profile, { intimate: true }),
    },
  };
}

/**
 * {@link buildStagedSubjectVisual} at the runner's boundary: a throw here is a
 * defect, but the honest outcome is a failed row carrying a diagnostic rather
 * than a lost run (docs/resilience.md §diagnostics over exceptions). The same
 * shape the variant lane's `buildVariantDigest` takes, and for the same reason.
 */
export function tryBuildStagedSubjectVisual(
  input: Omit<StagedSubjectVisualInput, "sink">,
  sink?: DiagnosticSink,
): StagedSubjectVisualBuild {
  try {
    return buildStagedSubjectVisual({ ...input, ...(sink === undefined ? {} : { sink }) });
  } catch (err) {
    sink?.push(
      diag("warn", STAGED_VISUAL_DIGEST_UNAVAILABLE, "the staged bench's visual digest could not be assembled", {
        path: "images.image_lab_staged",
        context: {
          characterId: input.characterId,
          error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        },
      }),
    );
    return {
      ok: false,
      refusal: `the production-parity arm could not assemble ${input.name}'s visual digest, so this bench has no way to describe the subject the chat lane's own way`,
    };
  }
}

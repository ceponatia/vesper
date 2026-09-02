import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { SceneStaging } from "@/contracts/images/scene-staging";
import { standaloneCharacterReadToken } from "@/contracts/images/subject-digest";
import type { VisualSegmentTaskPolicy } from "@/contracts/images/visual-segments";
import { FULLY_COVERED, type RegionExposure, type WornItemInput } from "@/contracts/items/visibility";
import type { CharacterProfile } from "@/contracts/world/profile";
import type { CharacterPromptSubjectCut } from "./character-prompt-program";
import { buildStandaloneSubjectVisual } from "./standalone-subject-visual";

/**
 * THE STAGED BENCH'S SUBJECT CUT — the staged character render compiles the
 * same kind of committed visual cut the chat scene lane compiles (owner ruling
 * 2026-08-25).
 *
 * The Image Lab's `staged_scene` kind exists to send the prompt production
 * sends. Production describes a person from ONE source: their committed visual
 * cut, folded into a world digest and worded by the endpoint's dialect
 * (`buildCharacterPromptProgram`). So the bench's subject has to arrive as that
 * same cut, and this module is where a bench — which has no chat to commit one
 * — realizes it.
 *
 * ## The same cut every other chat-less character render takes
 *
 * A bench has no conversation, so it takes the STANDALONE assembly
 * (`buildStandaloneSubjectVisual`) — one snapshot, one camera-bound selection,
 * one digest — exactly as the avatar and variant lanes do. Every knob is set to
 * the CHAT SCENE lane's value rather than a bench-local one, because parity with
 * that lane is the entire claim:
 *
 * - `intimateAllowed: false`, matching the chat lane's own image context
 *   (`buildVisualStateSelections` hard-codes it). Intimate anatomy reaches a
 *   staged prompt the way it reaches a chat's — as the ROUTE's typed reveal
 *   over the cut's coverage (`intimateReveal` on the program), spent on the
 *   uncensored rung — so the digest never carries a second copy of it.
 * - the segment policy is the scene lane's, for the assembly's own segments
 *   pass ({@link STAGED_SEGMENT_POLICY}); the bench reads the assembly's DIGEST
 *   and never its segments, so the policy shapes nothing the render sends.
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
 * off — a dressed character would cover the regions the template is written
 * around, and the bench would quietly pay for an ordinary portrait. So the worn
 * list handed to the standalone assembly is {@link stagedPremiseWorn}, which
 * encodes that invented exposure as coverage: the digest's exposure readout and
 * the camera's per-location perception then both answer the premise, and the
 * two halves cannot disagree about what this shot shows.
 *
 * ## Failure behavior
 *
 * An assembly that throws refuses the run before provider spend, and it does
 * NOT fall back to a name-only render: a prompt production never sends would
 * answer a different question than the row asks. The caller settles the row
 * with `visual_digest_unavailable`. A cut that assembles but cannot be compiled
 * — a lost required anchor, most likely — is the prompt program's own refusal,
 * settled under its code by the runner.
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

/**
 * The segment policy the standalone assembly runs its subject-segments pass
 * under: the chat scene lane's own rules — never state age, full-figure frame,
 * intimate skin only where the region reads bare, coverage stated. The bench
 * compiles the assembly's digest, not its segments, so nothing the render sends
 * turns on this; it is stated so the assembly runs under the rules of the lane
 * this bench claims parity with rather than a portrait's.
 */
const STAGED_SEGMENT_POLICY: VisualSegmentTaskPolicy = {
  age: "omit",
  frame: "full_figure",
  intimate: "when_bare",
  exposure: "state",
};

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
 * and describes a clothed back, and a cut that bared her torso as well would
 * contradict the registry's own wording. An entry with no bare regions
 * (`requiresBare: []`) stays fully covered, and the program then states no bare
 * region at all, which is the honest claim for a bench that said nothing about
 * clothes.
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
// The assembly
// ---------------------------------------------------------------------------

/**
 * The staged subject as the program takes them: the cut shape every character
 * lane hands `buildCharacterPromptProgram`, with the name the staging template
 * binds `{name}` to.
 */
export type StagedSubjectCut = CharacterPromptSubjectCut & { readonly name: string };

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
      readonly cut: StagedSubjectCut;
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
 * Realize the staged subject's visual cut from their own committed state.
 *
 * The read token is the character row's revision alone. It names every owner
 * that fed this render and no more: the closet is deliberately not one of them
 * (the coverage is the staging's premise), and folding wardrobe revisions in
 * would claim an edit to a garment changes a prompt it cannot reach.
 */
export function buildStagedSubjectVisual(input: StagedSubjectVisualInput): StagedSubjectVisualBuild {
  const { entry, profile, sink } = input;
  const visual = buildStandaloneSubjectVisual({
    characterId: input.characterId,
    name: input.name,
    profile,
    readToken: standaloneCharacterReadToken({ characterId: input.characterId, revision: input.revision }),
    worn: stagedPremiseWorn(stagedSubjectExposure(entry)),
    camera: entry.camera,
    cameraId: STAGED_VISUAL_CAMERA_ID,
    policy: STAGED_SEGMENT_POLICY,
    intimateAllowed: false,
    ...(sink === undefined ? {} : { sink }),
  });
  return {
    ok: true,
    digestMeta: visual.digestMeta,
    cut: {
      subjectId: input.characterId,
      name: input.name,
      digest: visual.digest,
      attributes: visual.resolved,
      // The assembly's own readout over the premise coverage — the same value
      // the camera's perception was derived from, so the cut's exposure claims
      // and its selected detail answer one shot.
      exposure: visual.exposure,
      realizedBody: visual.realizedBody,
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
      refusal: `${input.name}'s visual digest could not be assembled, so this bench has no way to describe the subject the chat lane's own way`,
    };
  }
}

import {
  compileImagePromptSegments,
  orderImagePromptSegments,
  type ImagePromptSegment,
} from "@vesper/image-core";
import {
  AFFORDANCE_UNIT_ONE,
  conditionAttributeOverlays,
  diag,
  exposedRegions,
  FULLY_COVERED,
  realizeBody,
  resolveAttributes,
  type AttributeValue,
  type DiagnosticSink,
  type RealizedBody,
  type RegionExposure,
  type SceneCameraSpec,
  type VisualImageDigest,
  type VisualImageFact,
  type VisualStateSuppression,
} from "@/contracts";
import { buildVisualSubjectSegments, type VisualFactClauseResolver } from "@/contracts/images/visual-segments";
import {
  safeBuildVisualStateShadow,
  visualStateImageDigestOfShadow,
  type VisualStateShadowInput,
} from "@/server/visual-state";
import { PORTRAIT_IDENTITY_LOCK } from "./prompts-variant";
import { visualFactClauseResolver } from "./visual-fact-clauses";

/**
 * THE CHAT-LOOK MINT'S VISUAL-DIGEST CUTOVER — the pure seam
 * that replaces `buildChatLookPrompt`'s three hard-coded sentences with the
 * committed visual digest plus semantic prompt segments.
 *
 * `renderChatLookImage` calls {@link buildChatLookSegments} once, hands the
 * segments to `renderImageIntent`, records `digestMeta` on the row beside
 * `lookKey`, and REFUSES before reserving anything when the assembly says so.
 * The committed cut arrives from `runChatLookImage`, which builds it through the
 * shared chat factory (`chatVisualStateShadowInput`) — the same one the scene
 * queue and the visual-state inspector use, so a look anchor and the scene that
 * anchors on it can never assemble two different cuts of one conversation.
 *
 * ## Why this lane's fact set is deliberately narrow
 *
 * The look mint is an identity-locked EDIT of the character's canonical
 * portrait. Hair colour, eye colour and skin tone are already in the reference
 * photograph, pixel-perfect, and restating them in text is how an edit model is
 * invited to repaint them. So this lane ships no route-owned identity residual
 * sheet at all — the avatar and scene lanes carry one because they describe a
 * body from scratch, and this one does not.
 *
 * What the digest owns here is exactly what a photograph cannot be trusted to
 * hold on its own: species feature groups and anatomy departures — the
 * morphology an image model "corrects" away between generations. Because there
 * is no residue beside them, the shared clause resolver runs with NO omit set,
 * unlike the avatar and scene lanes, whose `RECOGNITION_RESIDUE_ATTRIBUTE_IDS`
 * cut exists solely to stop their residual sheets from stating a fact the
 * digest also states. Carrying that cut here would omit facts nothing else
 * says.
 *
 * Cataloged distinctive marks are the measured exception, and this lane is
 * where the seam shows. A mark reaches a lane by two roads: the STANDALONE
 * snapshot road (avatar, variant) projects a cataloged distinctive value into
 * the digest as a mark, while the chat SHADOW road (this lane and the scene
 * lane) projects none — the avatar build records `nose/shape` as a
 * `lane_curated` suppression, and both chat builds record no such fact at all.
 * The scene lane never noticed, because its route-owned residual sheet states
 * the mark regardless; the mint has no residue, so here the silence shows.
 * Left silent deliberately: this lane edits FROM an identity reference, and
 * identity detail the reference photo already carries is exactly what the
 * owner ruled stays unstated on the sibling edit lane (2026-08-25). Closing
 * the asymmetry belongs to the visual-state projection —
 * when it lands, this lane gains the mark with no change here. The claim is
 * pinned by `lane-characterization.test.ts`'s distinctive-mark test.
 *
 * Route-owned segments carry today's wording unchanged:
 *
 * - the outfit change / undress / keep-casual line as the `operation` segment —
 *   this lane's edit delta, and the one thing the mint exists to change;
 * - `PORTRAIT_IDENTITY_LOCK` as the `identity` segment, BYTE-IDENTICAL to the
 *   exported constant (see {@link CHAT_LOOK_IDENTITY_SEGMENT});
 * - the framing sentence as the `framing` segment.
 *
 * ## Why current state is suppressed rather than stated
 *
 * The look anchor is CACHED. `chatLookKey` hashes worn item ids, the free-text
 * overlay, the coverage-computed exposure fingerprint, the persisted attribute
 * overlays and the garment store's structural fingerprint — and NOTHING about
 * transient body state. `latestChatLook` then treats a key match as "this
 * anchor is still current". So a digest clause reading "skin damp" or "soaked"
 * would bake a body state into an image whose key cannot see it: the wetness
 * dries, the key does not move, and every later scene keeps anchoring on a damp
 * character forever.
 *
 * The discriminator is `VisualImageFact.layer === "current"` — the projection's
 * own word for "current state", covering active conditions, body-surface
 * wetness, garment condition/presentation/deposit/damage/material effects and
 * affordance observations. It is the only clean one: `stability` disagrees with
 * itself here (a rolled sleeve is `presentation` stability on the `current`
 * layer), and `segmentKind` describes where a clause would LAND rather than
 * what the fact is about. Suppression runs through the caller's clause resolver
 * as a deliberate `{ omit }` ({@link VISUAL_CLAUSE_OMIT_CHAT_LOOK_CACHE}), so
 * it is recorded as lane policy in `meta.visualState`, never as degradation.
 * Every current-layer kind is optional in the attention priors, so nothing here
 * can cost the mint its render eligibility.
 *
 * Body-language facts (posture, facing, support, contact) reach the shared
 * resolver's own `{ omit }` for the scene plan and never appear either, which
 * is the right answer for this lane too: its framing sentence states one fixed
 * pose, and a second pose beside it would put the same body in two positions.
 *
 * ## Failure behavior
 *
 * A failed shadow assembly, or a REQUIRED digest fact with no resolvable
 * clause, returns a non-null `refusal`. This lane's refusal shape is NOT
 * `failedPrecondition`: the look mint checks its preconditions BEFORE reserving
 * a row, because an ineligible chat re-fires this job on every outfit and
 * appearance change and a reserving refusal would accumulate one failed row per
 * change forever. No row, no mint, retry on the next change.
 *
 * A cut the caller could not build at all (a missing `chat_participants` row —
 * corrupt membership) is NOT a refusal: the assembly falls back to the
 * route-owned segments alone, which is the same degraded-default-over-failed-turn
 * rule the scene queue applies to the same missing row.
 *
 * Pure: no IO, no env, no clock.
 */

// ---------------------------------------------------------------------------
// Lane policy
// ---------------------------------------------------------------------------

/**
 * The look mint's task policy.
 *
 * - `age: "omit"` — the narrative/visual age split (#143) made this lane
 *   age-neutral: visible age is inherited from the portrait reference, and
 *   `age-context-separation.test.ts` tripwires the lane's sources for an
 *   apparent-age identifier.
 * - `frame: "waist_up"` — the framing segment below asks for "waist-up to
 *   three-quarter frame", and the avatar's portrait rule is the precedent for
 *   how a waist-up lane cuts below-the-waist facts (signature morphology, such
 *   as a pelvis-rooted tail, is exempt by the builder's own rule).
 * - `intimate: "never"` — a wardrobe anchor is not an anatomy study.
 * - `exposure: "omit"` — the operation segment already states coverage once, as
 *   the change being requested. An authoritative "the torso is bare" beside
 *   "Remove the outfit: undressed." either restates it or, when the operation
 *   dresses the character, contradicts it outright.
 */
export const CHAT_LOOK_SEGMENT_POLICY = {
  age: "omit",
  frame: "waist_up",
  intimate: "never",
  exposure: "omit",
} as const;

/**
 * The look mint's fixed viewpoint: facing the camera at medium distance, which
 * `visualCameraReadsOfSceneCamera` maps to the `waist_up` framing band — the
 * same band the policy above cuts to and the same spec the avatar's portrait
 * studio uses. This is a studio viewpoint, not a committed scene camera: the
 * mint is a wardrobe anchor, and a look keyed to whatever the fiction's camera
 * happened to be doing would invalidate on every shot change.
 */
export const CHAT_LOOK_CAMERA: SceneCameraSpec = {
  orientation: "toward_viewer",
  distance: "medium",
  height: "eye_level",
};

/** The camera id the selection fingerprints. */
export const CHAT_LOOK_CAMERA_ID = "chat_look_studio";

/** Diagnostic provenance for the route-owned segments. Never reaches a provider. */
const CHAT_LOOK_SEGMENT_SOURCE = "images.chat_look";

/** The shadow assembly failed; the mint refuses before reserving a row. */
export const CHAT_LOOK_VISUAL_DIGEST_UNAVAILABLE = "images.chat_look.visual_digest_unavailable";
/** A required digest fact resolved no clause; the mint refuses before reserving a row. */
export const CHAT_LOOK_VISUAL_REQUIRED_MISSING = "images.chat_look.visual_required_missing";

/**
 * A current-state fact withheld because this lane's asset is CACHED under a key
 * that cannot see transient body state (`chatLookKey`). Lane policy, recorded
 * per fact in `meta.visualState`; never degradation.
 */
export const VISUAL_CLAUSE_OMIT_CHAT_LOOK_CACHE = "chat_look_cache_key_blind";

// ---------------------------------------------------------------------------
// Route-owned segments — wording preserved from `buildChatLookPrompt`
// ---------------------------------------------------------------------------

/**
 * The identity lock, BYTE-IDENTICAL to `PORTRAIT_IDENTITY_LOCK`.
 *
 * `qwenEditPromptDialect` rewrites exactly this sentence — and only this
 * sentence — into the family's numbered-reference spelling, matching on the
 * literal string. A paraphrase here would silently stop matching and every Qwen
 * look edit would quietly revert to the generic wording with no error anywhere.
 * That is why the constant is imported rather than restated.
 */
const CHAT_LOOK_IDENTITY_SEGMENT = PORTRAIT_IDENTITY_LOCK;

/** The one framing sentence this lane has ever sent. */
const CHAT_LOOK_FRAMING =
  "Standing, relaxed neutral pose, facing the viewer; plain softly lit neutral backdrop; waist-up to three-quarter frame.";

/**
 * The edit delta: what the mint is being asked to change. Three cases, exactly
 * as `buildChatLookPrompt` has always spelled them — a named outfit, a
 * confirmed-exposed body with nothing to name, and the silent default.
 */
function chatLookOperation(outfit: string, outfitExposed: boolean): string {
  const named = outfit.trim();
  if (named) {
    return `Change the outfit: now wearing ${named}. Depict only this clothing — remove anything the reference wears that is not listed.`;
  }
  return outfitExposed ? "Remove the outfit: undressed." : "Keep a simple, casual outfit.";
}

function segment(kind: ImagePromptSegment["kind"], text: string): ImagePromptSegment {
  return { kind, text, mandatory: true, priority: AFFORDANCE_UNIT_ONE, source: CHAT_LOOK_SEGMENT_SOURCE };
}

// ---------------------------------------------------------------------------
// Clause resolution
// ---------------------------------------------------------------------------

/**
 * The shared clause table under this lane's one cut: every `current`-layer fact
 * is a deliberate omission, because the cache key that reproduces this asset
 * cannot see current state (see the module header).
 *
 * No `omitAttributeIds` — the deliberate difference from the avatar and scene
 * resolvers. Their catalog-derived cut exists to stop a route-owned residual
 * sheet from stating a fact the digest also states; this lane has no residue,
 * so a cut here would drop facts nothing else carries. (It would not recover
 * the cataloged marks either way — the chat shadow road projects none; see the
 * module header.)
 */
function chatLookClauseResolver(
  attributes: readonly AttributeValue[],
  realizedBody: RealizedBody,
): VisualFactClauseResolver {
  const shared = visualFactClauseResolver({ attributes, realizedBody });
  return (fact: VisualImageFact) =>
    fact.layer === "current" ? { omit: VISUAL_CLAUSE_OMIT_CHAT_LOOK_CACHE } : shared(fact);
}

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

/** One subject's committed chat cut, as the shared factory hands it over. */
export type ChatLookVisualCut = Omit<VisualStateShadowInput, "sink" | "camera">;

export interface ChatLookSegmentInput {
  /** The tracked outfit text; empty means "nothing named", not "nothing worn". */
  readonly outfit: string;
  /** True when the resolved wardrobe positively says the body is exposed. */
  readonly outfitExposed: boolean;
  /**
   * The subject's committed chat cut. ABSENT degrades to the route-owned
   * segments alone (no digest facts, no refusal) — the caller could not build a
   * cut, and a wardrobe anchor is worth more than a continuity id.
   */
  readonly shadow?: ChatLookVisualCut;
  /**
   * The canonical garment-coverage readout — the SAME `wardrobe.exposure` the
   * look key hashed. Absent falls back to the caller's binary exposed flag, the
   * scene lane's own default for a member with no resolved readout.
   */
  readonly exposure?: RegionExposure;
  readonly sink?: DiagnosticSink;
}

/**
 * The realized cut the mint's segments were built from — everything the Round 2
 * shadow instrumentation (`character-shadow.ts`) needs to assemble the
 * compiled-program side over the SAME selection. Absent exactly when the mint
 * had no cut to describe; nothing production sends reads it.
 */
export interface ChatLookVisualBuild {
  readonly digest: VisualImageDigest;
  /** The three-layer resolve the clause table ran under. */
  readonly attributes: readonly AttributeValue[];
  readonly realizedBody: RealizedBody;
  /** The canonical coverage readout the exposure claims are made over. */
  readonly exposure: RegionExposure;
}

export interface ChatLookSegmentAssembly {
  /** The full ordered segment list the render intent carries. */
  readonly segments: readonly ImagePromptSegment[];
  /** The same segments compiled — the row's stored prompt and the intent's string form. */
  readonly prompt: string;
  /** The `meta.visualState` fragment the row records at reserve time; absent with no cut. */
  readonly digestMeta?: Record<string, unknown>;
  /** Required digest facts with nothing to say. */
  readonly missingRequired: readonly string[];
  /** Every fact a policy or the resolver excluded, and why. */
  readonly suppressions: readonly VisualStateSuppression[];
  /**
   * The digest fact keys this build ACTUALLY emitted as segment text — the
   * builder's emission ledger, recorded fact by fact as each clause landed
   * (owner correction 2026-08-29 #3); the shadow's legacy fact coverage reads
   * this, never digest-minus-suppressions. Present exactly when `visual` is:
   * the route-only mint emitted no digest fact and has no ledger to state.
   */
  readonly emittedFactKeys?: readonly string[];
  /** The realized cut behind the segments, for the shadow; absent with no cut. */
  readonly visual?: ChatLookVisualBuild;
  /** Non-null refuses the mint BEFORE a row is reserved (this lane's refusal shape). */
  readonly refusal: string | null;
}

/**
 * Build the look mint's render segments from a committed chat cut. One shadow
 * assembly, ONE camera-bound selection pass, one digest realized from that
 * exact selection — never a re-select (`image-digest.ts` §Reuse the selection).
 * Deterministic over its inputs.
 */
export function buildChatLookSegments(input: ChatLookSegmentInput): ChatLookSegmentAssembly {
  const { shadow, sink } = input;
  const route: ImagePromptSegment[] = [
    segment("operation", chatLookOperation(input.outfit, input.outfitExposed)),
    segment("identity", CHAT_LOOK_IDENTITY_SEGMENT),
    segment("framing", CHAT_LOOK_FRAMING),
  ];
  const routeOnly = (refusal: string | null): ChatLookSegmentAssembly => {
    const ordered = orderImagePromptSegments(route);
    return {
      segments: ordered,
      prompt: compileImagePromptSegments(ordered),
      missingRequired: [],
      suppressions: [],
      refusal,
    };
  };

  // No cut to describe: the caller already recorded why (a missing participant
  // row is the only path here today). The anchor still mints, stating the edit
  // and the identity lock and nothing about the body — which is exactly what
  // this lane sent before the digest existed.
  if (shadow === undefined) return routeOnly(null);

  const build = safeBuildVisualStateShadow(
    {
      ...shadow,
      // The look mint's own studio viewpoint, bound into the ONE selection pass.
      camera: { cameraId: CHAT_LOOK_CAMERA_ID, spec: CHAT_LOOK_CAMERA },
      ...(sink === undefined ? {} : { sink }),
    },
    sink,
  );
  if (build === null) {
    sink?.push(
      diag("error", CHAT_LOOK_VISUAL_DIGEST_UNAVAILABLE, "the visual digest could not be assembled for this look", {
        path: "images.chat_look",
        context: { subjectId: shadow.subjectId, cutId: shadow.cutId },
      }),
    );
    return routeOnly("visual digest unavailable for the look anchor");
  }

  // This job realizes the cut it just assembled, so `forCutId` names the same
  // id and the digest's stale-cut gate stays a seam contract rather than a live
  // branch.
  const realized = visualStateImageDigestOfShadow(build, {
    forCutId: shadow.cutId,
    ...(sink === undefined ? {} : { sink }),
  });

  // The same three-layer resolve the projection was taken over (base →
  // persisted narrative overlays → condition overlays), read back off the cut
  // so the clause table can never disagree with the digest about a recorded
  // haircut or dye.
  const attributes = resolveAttributes(shadow.attributes, [
    ...(shadow.attributeOverlays ?? []),
    ...conditionAttributeOverlays([...(shadow.conditions ?? [])]),
  ]);
  const realizedBody = realizeBody(shadow.realize ?? {});
  const exposure: RegionExposure =
    input.exposure ?? (input.outfitExposed ? exposedRegions([]) : FULLY_COVERED);

  const subject = buildVisualSubjectSegments({
    digest: realized.digest,
    subjectId: shadow.subjectId,
    exposure,
    policy: CHAT_LOOK_SEGMENT_POLICY,
    clause: chatLookClauseResolver(attributes, realizedBody),
    ...(sink === undefined ? {} : { sink }),
  });

  if (subject.missingRequired.length > 0) {
    sink?.push(
      diag("error", CHAT_LOOK_VISUAL_REQUIRED_MISSING, "required visual facts resolved no clause for this look", {
        path: "images.chat_look",
        context: { subjectId: shadow.subjectId, keys: [...subject.missingRequired] },
      }),
    );
    return {
      ...routeOnly(`required visual facts unresolved for the look anchor: ${subject.missingRequired.join(", ")}`),
      digestMeta: realized.meta,
      missingRequired: subject.missingRequired,
      suppressions: subject.suppressions,
    };
  }

  // Route segments first, so a priority tie inside a kind keeps the identity
  // lock ahead of any digest mark; the canonical kind order does the rest.
  const segments = orderImagePromptSegments([...route, ...subject.segments]);
  return {
    segments,
    // Budgets resolve empty for every seeded model, so the kernel's own compile
    // of these segments produces this exact string. No sink here: the planner
    // reports fitting when the render actually runs.
    prompt: compileImagePromptSegments(segments),
    digestMeta: realized.meta,
    missingRequired: subject.missingRequired,
    suppressions: subject.suppressions,
    emittedFactKeys: subject.emitted.map((emission) => emission.key),
    visual: { digest: realized.digest, attributes, realizedBody, exposure },
    refusal: null,
  };
}

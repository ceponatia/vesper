import { diag, type DiagnosticSink } from "../../diagnostics";
import type { AffordanceEvidence, AffordanceStoryTime, AffordanceSubjectId } from "../core";
import { SCENE_CONTROL_UNAVAILABLE, SCENE_INTENT_INVALID, SCENE_INTENT_STALE } from "./diagnostics";
import { sceneFact, sceneProvenance, type SceneEventRef, type SceneFact, type SceneProvenance } from "./provenance";
import {
  SCENE_MAX_SUPPORT_RELATIONS,
  sceneFacingFact,
  sceneParticipant,
  sceneProximityFact,
  sceneSupportSetsEqual,
  sceneSupportSurface,
  withSceneFacing,
  withSceneParticipant,
  withSceneProximity,
  type SceneParticipant,
  type SceneState,
  type SceneSupportRelation,
} from "./state";
import {
  SCENE_CONTROL_ORIGINS,
  SCENE_ORIGIN_PROVENANCE,
  type SceneControlMode,
  type SceneFacing,
  type SceneIntentOrigin,
  type ScenePosture,
  type SceneProximityBand,
} from "./vocabulary";

/**
 * Structured movement intents, and the actor-control law that gates them
 * (romantic-contact-affordances.spec.scene.md §"Actor-control law").
 *
 * A movement enters the scene as a TYPED intent — a posture, an orientation, a
 * distance, a support change — and never as a sentence. That is the whole point
 * of the module: prose describing a movement is evidence that a movement was
 * described, and the lane that produced the prose still has to decide, on the
 * side that owns the body, whether it happened.
 *
 * **The law** (owner ruling, 2026-07-30 —
 * romantic-contact-affordances.audit.md §"Owner decisions needed" 2):
 *
 * - a **player** intent may move only a **player-controlled** participant;
 * - an **NPC** movement must originate NPC- or simulation-side;
 * - narrator mode is not an exception. It grants authorship of the narration,
 *   not authority over another body, and it does not bypass target agency or
 *   consent — which is why there is no narrator origin to check for.
 *
 * The rule itself lives in `SCENE_CONTROL_ORIGINS` as data, so it can be read
 * and extended without re-deriving it from branches here.
 *
 * ## Committed, rejected, superseded, unresolved — and only one carries a scene
 *
 * The contact core separates attempt from commitment with three types rather
 * than a status field, for the reason a collapsed boundary lets a possibility
 * reach a narrator as a fact. The same separation applies here in the cheapest
 * possible form: **only the `committed` branch of `SceneIntentOutcome` has a
 * `state`.** A refused, stale, or unreadable intent has no new scene to pick up
 * by mistake.
 *
 * A rejection is an ANSWER (the player does not control that body) and files no
 * diagnostic. `unresolved` means the scene could not be read — an unusable
 * intent, a participant nobody placed, a control nobody stated — and files one,
 * because it is a gap somebody has to close. `superseded` is the ordering law
 * below.
 *
 * ## The ordering law
 *
 * A scene fact records **when it became true**, so an intent has to be weighed
 * against the fact it would overwrite rather than simply landing on top of it:
 *
 * 1. An intent that **restates** the standing fact — the same posture, the same
 *    band, the same orientation, the same support set — never writes, at any
 *    story time. Only the provenance would change, and rewriting provenance for
 *    a fact that did not change is how a scene where nothing happened produces a
 *    new snapshot every turn. (The contact core's `contentKey` refuses the same
 *    churn on the same grounds.) `already_asserted`, no diagnostic: the scene
 *    agrees, and agreement is not a fault.
 * 2. An intent **older** than the fact it targets never overwrites it —
 *    `newer_fact_present` plus `scene.intent_stale`. Out-of-order delivery is an
 *    adapter or replay gap, and letting yesterday's posture land on today's is
 *    exactly the silent corruption a provenance-carrying fact exists to prevent.
 * 3. An intent at the **same** story time as the fact, asserting something
 *    DIFFERENT, writes. Two movements inside one story minute are ordinary, and
 *    within an instant the delivery order is the only ordering that exists — a
 *    fold's order is causal, unlike the array order of a stored blob, which is
 *    why the boundary may never make the same choice (`parseSceneState`).
 *
 * A body with no fact of that kind yet has nothing to be stale against, so a
 * first placement always writes.
 */

// ---------------------------------------------------------------------------
// The intent
// ---------------------------------------------------------------------------

export const sceneIntentKinds = ["set_posture", "set_facing", "set_proximity", "set_support"] as const;
export type SceneIntentKind = (typeof sceneIntentKinds)[number];

/**
 * What the intent changes. One case per fact this module owns; there is no
 * free-text case and no "other".
 *
 * `set_support` replaces the participant's WHOLE support set rather than
 * patching one relation. Standing up off a chair changes what bears the weight
 * and what the hands are doing at the same time, and a partial patch would let
 * a scene keep a stale relation to furniture the body has left.
 */
export type SceneMovementChange =
  | { readonly kind: "set_posture"; readonly posture: ScenePosture }
  | { readonly kind: "set_facing"; readonly towardId: AffordanceSubjectId; readonly facing: SceneFacing }
  | { readonly kind: "set_proximity"; readonly otherId: AffordanceSubjectId; readonly band: SceneProximityBand }
  | { readonly kind: "set_support"; readonly support: readonly SceneSupportRelation[] };

/**
 * One attempted movement. Nothing here is true yet.
 *
 * `subjectId` is the body that MOVES, and it is the only body the control check
 * consults — closing the distance to someone is the mover's own movement, so an
 * intent to approach never needs the other participant's authority. What the
 * other participant may then do about it is a contact/consent question, and
 * this module deliberately does not answer it.
 */
export interface SceneMovementIntent {
  readonly intentId: string;
  readonly subjectId: AffordanceSubjectId;
  readonly origin: SceneIntentOrigin;
  readonly change: SceneMovementChange;
  /** The lane's id for the event behind this intent; it becomes the fact's provenance ref. */
  readonly ref: SceneEventRef;
  readonly storyTime: AffordanceStoryTime;
  readonly evidence: readonly AffordanceEvidence[];
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Why an intent was refused. An answer the fiction can carry, not a degradation. */
export const sceneIntentRejections = [
  "npc_movement_requires_npc_authority",
  "player_movement_requires_player_authority",
] as const;
export type SceneIntentRejection = (typeof sceneIntentRejections)[number];

/** Why the scene could not decide. Degradation — nothing moved and nothing is claimed. */
export const sceneIntentUnresolvedReasons = ["intent_invalid", "participant_absent", "control_unresolved"] as const;
export type SceneIntentUnresolvedReason = (typeof sceneIntentUnresolvedReasons)[number];

/**
 * Why a legal, authorized intent still wrote nothing.
 *
 * - `newer_fact_present` — the scene had already moved past it (stale delivery).
 * - `already_asserted` — the scene already says exactly this.
 *
 * In both cases the state the caller already holds is the correct one, which is
 * why this branch carries no `state`: there is nothing new to pick up.
 */
export const sceneIntentSupersededReasons = ["newer_fact_present", "already_asserted"] as const;
export type SceneIntentSupersededReason = (typeof sceneIntentSupersededReasons)[number];

/** What a committed intent wrote, for a replay log or a debug pane. */
export interface SceneIntentCommit {
  readonly intentId: string;
  readonly subjectId: AffordanceSubjectId;
  readonly kind: SceneIntentKind;
  readonly provenance: SceneProvenance;
}

export type SceneIntentOutcome =
  | { readonly status: "committed"; readonly state: SceneState; readonly commit: SceneIntentCommit }
  | {
      readonly status: "rejected";
      readonly reason: SceneIntentRejection;
      /** The control fact the refusal rests on — a refusal states its own authority. */
      readonly control: SceneFact<SceneControlMode>;
    }
  | {
      readonly status: "superseded";
      readonly reason: SceneIntentSupersededReason;
      /** The provenance of the fact that stands — when it became true, and on whose word. */
      readonly standing: SceneProvenance;
    }
  | {
      readonly status: "unresolved";
      readonly reason: SceneIntentUnresolvedReason;
      /** Short structured elaboration (a field name, a missing id). Never prose. */
      readonly detail?: string;
    };

export interface SceneIntentRequest {
  readonly state: SceneState;
  readonly intent: SceneMovementIntent;
  readonly sink?: DiagnosticSink;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** Everything about an intent that must hold before the control question is even meaningful. */
function intentStructureProblem(state: SceneState, intent: SceneMovementIntent): string | undefined {
  if (intent.intentId.trim().length === 0) return "intentId is blank";
  if (!Number.isInteger(intent.storyTime) || intent.storyTime < 0) return "storyTime is not a story minute";
  const change = intent.change;
  switch (change.kind) {
    case "set_posture":
      return undefined;
    case "set_facing":
      if (change.towardId === intent.subjectId) return "a participant cannot face themselves";
      return sceneParticipant(state, change.towardId) === undefined
        ? `facing target "${change.towardId}" is not in the scene`
        : undefined;
    case "set_proximity":
      if (change.otherId === intent.subjectId) return "a participant cannot be near themselves";
      return sceneParticipant(state, change.otherId) === undefined
        ? `proximity target "${change.otherId}" is not in the scene`
        : undefined;
    case "set_support":
      return supportSetProblem(state, intent.subjectId, change.support);
  }
}

/**
 * A support set that cannot be true.
 *
 * Two `borne_by` relations would give the body two base heights, and picking
 * one would be the module inventing an elevation — so it is refused at the
 * door. (Stored state can still carry the contradiction from an older release;
 * the reach read answers `elevation_ambiguous` for exactly that case rather
 * than trusting this gate to have run.)
 */
function supportSetProblem(
  state: SceneState,
  subjectId: AffordanceSubjectId,
  support: readonly SceneSupportRelation[],
): string | undefined {
  if (support.length > SCENE_MAX_SUPPORT_RELATIONS) return "too many support relations";
  if (support.filter((relation) => relation.role === "borne_by").length > 1) {
    return "a body cannot be borne by two anchors at once";
  }
  for (const relation of support) {
    if (relation.loadZones.length === 0) return `support relation "${relation.role}" carries no load zone`;
    if (relation.anchor.kind === "surface") {
      if (sceneSupportSurface(state, relation.anchor.supportId) === undefined) {
        return `support surface "${relation.anchor.supportId}" is not in the scene`;
      }
      continue;
    }
    if (relation.anchor.subjectId === subjectId) return "a body cannot support itself";
    if (sceneParticipant(state, relation.anchor.subjectId) === undefined) {
      return `support anchor "${relation.anchor.subjectId}" is not in the scene`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** The fact an intent would overwrite, and whether the intent merely restates it. */
interface SceneIntentTarget {
  readonly provenance: SceneProvenance;
  readonly restates: boolean;
}

/**
 * The single fact this change would replace, if the scene already holds one.
 *
 * One slot per change kind, and the slot is the unit of ordering: a posture
 * intent is weighed against that participant's posture, a facing intent against
 * that ORDERED pair's orientation, a support intent against the whole support
 * set. Weighing a facing intent against a posture would let an unrelated
 * movement make a legal one look stale.
 */
function targetedFact(
  state: SceneState,
  participant: SceneParticipant,
  change: SceneMovementChange,
): SceneIntentTarget | undefined {
  switch (change.kind) {
    case "set_posture": {
      const fact = participant.posture;
      return fact === undefined ? undefined : { provenance: fact.provenance, restates: fact.value === change.posture };
    }
    case "set_facing": {
      const fact = sceneFacingFact(state, participant.subjectId, change.towardId);
      return fact === undefined ? undefined : { provenance: fact.provenance, restates: fact.value === change.facing };
    }
    case "set_proximity": {
      const fact = sceneProximityFact(state, participant.subjectId, change.otherId);
      return fact === undefined ? undefined : { provenance: fact.provenance, restates: fact.value === change.band };
    }
    case "set_support": {
      const fact = participant.support;
      return fact === undefined
        ? undefined
        : { provenance: fact.provenance, restates: sceneSupportSetsEqual(fact.value, change.support) };
    }
  }
}

/**
 * The ordering law, applied to one intent (see the header).
 *
 * Returns the refusal, or `undefined` when the write may proceed. A refusal is
 * always the `superseded` branch, which carries no state — so no caller can pick
 * up a scene that was never written.
 */
function orderingRefusal(
  state: SceneState,
  participant: SceneParticipant,
  intent: SceneMovementIntent,
  sink?: DiagnosticSink,
): SceneIntentOutcome | undefined {
  const target = targetedFact(state, participant, intent.change);
  if (target === undefined) return undefined;
  if (target.restates) {
    return { status: "superseded", reason: "already_asserted", standing: target.provenance };
  }
  if (intent.storyTime >= target.provenance.storyTime) return undefined;
  sink?.push(
    diag("warn", SCENE_INTENT_STALE, "movement intent is older than the fact it would have overwritten", {
      context: {
        subjectId: intent.subjectId,
        kind: intent.change.kind,
        intentStoryTime: intent.storyTime,
        factStoryTime: target.provenance.storyTime,
      },
    }),
  );
  return { status: "superseded", reason: "newer_fact_present", standing: target.provenance };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function applyChange(
  state: SceneState,
  participant: SceneParticipant,
  change: SceneMovementChange,
  provenance: SceneProvenance,
): SceneState {
  switch (change.kind) {
    case "set_posture":
      return withSceneParticipant(state, { ...participant, posture: sceneFact(change.posture, provenance) });
    case "set_facing":
      return withSceneFacing(state, {
        subjectId: participant.subjectId,
        towardId: change.towardId,
        facing: sceneFact(change.facing, provenance),
      });
    case "set_proximity":
      return withSceneProximity(state, {
        subjectId: participant.subjectId,
        otherId: change.otherId,
        band: sceneFact(change.band, provenance),
      });
    case "set_support":
      // The whole set is one fact, so a CLEARING keeps a timestamp: `[]` stated
      // at story minute 40 is a fact about minute 40, and an intent from minute
      // 30 can be told it is late. A bare array had nothing to be late against.
      return withSceneParticipant(state, { ...participant, support: sceneFact(change.support, provenance) });
  }
}

/**
 * Apply one movement intent, or refuse it.
 *
 * Pure and total: same state + same intent ⇒ same outcome, in any process, on a
 * retake. It reads no clock — story time arrives on the intent — and throws for
 * nothing.
 *
 * Order is deliberate. Structure first (an intent naming a participant nobody
 * placed is an adapter bug, and asking who controls a body that is not there is
 * meaningless), then control, then ordering, then the write. The control
 * question is never skipped for a "small" change: a lean and a walk across the
 * room are the same question about whose body it is. Ordering runs LAST because
 * it is the only check that consults the fact being replaced — an intent nobody
 * was allowed to make is refused on that ground whether it was late or not.
 */
export function commitSceneIntent(request: SceneIntentRequest): SceneIntentOutcome {
  const { state, intent, sink } = request;

  const structural = intentStructureProblem(state, intent);
  if (structural !== undefined) {
    sink?.push(diag("error", SCENE_INTENT_INVALID, `movement intent is unusable: ${structural}`));
    return { status: "unresolved", reason: "intent_invalid", detail: structural };
  }

  const participant = sceneParticipant(state, intent.subjectId);
  if (participant === undefined) {
    sink?.push(
      diag("error", SCENE_INTENT_INVALID, "movement intent names a participant the scene does not contain", {
        context: { subjectId: intent.subjectId },
      }),
    );
    return { status: "unresolved", reason: "participant_absent", detail: intent.subjectId };
  }

  // --- The actor-control law --------------------------------------------
  const control = participant.control;
  if (control === undefined) {
    sink?.push(
      diag("warn", SCENE_CONTROL_UNAVAILABLE, "nobody stated who controls this body, so no movement can commit", {
        context: { subjectId: intent.subjectId },
      }),
    );
    return { status: "unresolved", reason: "control_unresolved", detail: intent.subjectId };
  }
  if (!SCENE_CONTROL_ORIGINS[control.value].includes(intent.origin)) {
    return {
      status: "rejected",
      reason:
        control.value === "npc_controlled"
          ? "npc_movement_requires_npc_authority"
          : "player_movement_requires_player_authority",
      control,
    };
  }

  // --- The ordering law -------------------------------------------------
  const superseded = orderingRefusal(state, participant, intent, sink);
  if (superseded !== undefined) return superseded;

  const provenance = sceneProvenance({
    source: SCENE_ORIGIN_PROVENANCE[intent.origin],
    ref: intent.ref,
    storyTime: intent.storyTime,
    evidence: intent.evidence,
  });
  return {
    status: "committed",
    state: applyChange(state, participant, intent.change, provenance),
    commit: {
      intentId: intent.intentId,
      subjectId: intent.subjectId,
      kind: intent.change.kind,
      provenance,
    },
  };
}

/**
 * Fold a sequence of intents.
 *
 * A refused, superseded, or unresolved intent leaves the state exactly as it was
 * and the fold continues — one participant's illegal movement is not a reason to
 * drop everybody else's legal one. Every outcome is returned in order, so a
 * replay can prove it reproduced not just the same scene but the same refusals.
 *
 * Folding the same list twice is therefore safe: the second pass restates every
 * fact the first one wrote and every intent comes back `already_asserted`,
 * leaving the state byte-identical rather than re-stamping it.
 */
export function applySceneIntents(
  state: SceneState,
  intents: readonly SceneMovementIntent[],
  sink?: DiagnosticSink,
): { state: SceneState; outcomes: readonly SceneIntentOutcome[] } {
  let current = state;
  const outcomes: SceneIntentOutcome[] = [];
  for (const intent of intents) {
    const outcome = commitSceneIntent({ state: current, intent, sink });
    if (outcome.status === "committed") current = outcome.state;
    outcomes.push(outcome);
  }
  return { state: current, outcomes };
}

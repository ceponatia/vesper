import { bodyLocationRegistry } from "../../body/locations";
import { diag, type DiagnosticSink } from "../../diagnostics";
import {
  adapterSupported,
  adapterUnavailable,
  type AdapterRead,
  type AffordanceSubjectId,
} from "../core";
import type {
  ContactBodySurfaceRef,
  ContactGeometryRead,
  ContactReach,
  ContactSupportMobility,
  ContactSupportRead,
  ContactSupportRole,
  ContactSurfaceRef,
} from "../contact";
import { SCENE_RELATION_UNAVAILABLE } from "./diagnostics";
import { sceneProvenanceEvidence, type SceneProvenance } from "./provenance";
import {
  sceneFacingFact,
  sceneParticipant,
  sceneProximityFact,
  sceneSupportSurface,
  type SceneParticipant,
  type SceneState,
} from "./state";
import {
  SCENE_HEIGHT_RUNG_INDEX,
  SCENE_MAX_RUNG_INDEX,
  SCENE_POSTURE_ZONE_RUNG,
  SCENE_ZONE_REACH_SPAN,
  sceneBodyZones,
  type SceneBodyZone,
  type SceneProximityBand,
} from "./vocabulary";

/**
 * The authoritative relation reads — reach, and whether a surface is free to
 * act (romantic-contact-affordances.spec.scene.md §"Reach rule").
 *
 * These are the two questions the contact core cannot answer for itself. Its
 * resolver takes `geometry` and `sourceSupport` as `AdapterRead`s precisely
 * because the truth-source audit found no owner for either in either lane; this
 * file is an owner, and `sceneGeometryRead` / `sceneSupportRead` hand back
 * exactly the shapes that resolver already consumes.
 *
 * Three laws run through every function here:
 *
 * 1. **An answer or an honest `unresolved` — never a guess.** A posture nobody
 *    stated does not become `standing`, and an unplaced body does not become
 *    reachable. Missing facts have their own reason codes so the gap is
 *    nameable.
 * 2. **Consult exactly the facts that could change the answer.** Two bodies
 *    already touching do not need an orientation, and two bodies in different
 *    rooms do not need a posture. A read that demanded a fact it would not use
 *    would manufacture `unresolved` answers out of irrelevance — and a read
 *    that used a fact it did not report would break law 3.
 * 3. **Every answer carries the provenance of every fact it consulted.**
 *    Including the unresolved ones, which report what they got as far as.
 */

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** Ancestor walks are bounded — the body tree is four deep today and a cycle must not hang a read. */
const ZONE_WALK_LIMIT = 16;

/**
 * The coarse zone a body location belongs to, by walking the shared body tree
 * upward until an ancestor is a member of `sceneBodyZones`.
 *
 * `foot_arch` → `sole` → `feet` → `legs`, without this module knowing that an
 * arch is part of a foot. A location the registry does not have, or one whose
 * ancestors contain no zone, has NO zone — and every read about it is
 * `unresolved`, because a body part with an invented height is worse than one
 * with no height.
 */
export function sceneBodyZoneOf(locationId: string): SceneBodyZone | undefined {
  let current = bodyLocationRegistry.byId(locationId);
  for (let depth = 0; depth < ZONE_WALK_LIMIT && current !== undefined; depth += 1) {
    const id = current.id;
    const zone = sceneBodyZones.find((candidate) => candidate === id);
    if (zone !== undefined) return zone;
    current = current.parentId === undefined ? undefined : bodyLocationRegistry.byId(current.parentId);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Why a relation read could not answer. Every one names a specific missing or contradictory fact. */
export const sceneUnresolvedReasons = [
  "participant_absent",
  "zone_unknown",
  "posture_unknown",
  "elevation_unknown",
  "elevation_ambiguous",
  "support_surface_absent",
  "support_unknown",
  "proximity_unknown",
  "facing_unknown",
  "object_surface_unanchored",
] as const;
export type SceneUnresolvedReason = (typeof sceneUnresolvedReasons)[number];

export type SceneReachAnswer =
  | {
      readonly status: "resolved";
      readonly reach: ContactReach;
      readonly provenance: readonly SceneProvenance[];
    }
  | {
      readonly status: "unresolved";
      readonly reason: SceneUnresolvedReason;
      /** What the read did manage to consult before it gave up. */
      readonly provenance: readonly SceneProvenance[];
    };

export type SceneSupportAnswer =
  | {
      readonly status: "resolved";
      readonly mobility: ContactSupportMobility;
      readonly supportRole: ContactSupportRole;
      readonly provenance: readonly SceneProvenance[];
    }
  | {
      readonly status: "unresolved";
      readonly reason: SceneUnresolvedReason;
      readonly provenance: readonly SceneProvenance[];
    };

function reachUnresolved(reason: SceneUnresolvedReason, provenance: readonly SceneProvenance[]): SceneReachAnswer {
  return { status: "unresolved", reason, provenance };
}

// ---------------------------------------------------------------------------
// Height
// ---------------------------------------------------------------------------

type SceneRungAnswer =
  | { readonly status: "resolved"; readonly rung: number; readonly provenance: readonly SceneProvenance[] }
  | {
      readonly status: "unresolved";
      readonly reason: SceneUnresolvedReason;
      readonly provenance: readonly SceneProvenance[];
    };

/**
 * The rung of the surface a body is standing, sitting, or lying ON.
 *
 * Exactly one `borne_by` relation answers it. None — whether the support fact is
 * absent or states an empty set — means nobody said what holds the body up, not
 * that it is on the floor. Two means the scene contradicts itself, and choosing
 * between them would be this module inventing an elevation, so it refuses.
 * (A stored scene can no longer carry that contradiction — `parseSceneState`
 * drops both claimants — but a programmatically built one can, and this is the
 * guard that keeps the read honest either way.) Weight borne by another
 * PARTICIPANT (`held_by`) is a real case with no answer here: how high a carried
 * body sits depends on how it is carried, and 3A does not model that
 * (spec §"Open design questions").
 */
function participantBaseRung(state: SceneState, participant: SceneParticipant): SceneRungAnswer {
  const support = participant.support;
  if (support === undefined) return { status: "unresolved", reason: "elevation_unknown", provenance: [] };
  const provenance = [support.provenance];
  const borne = support.value.filter((relation) => relation.role === "borne_by");
  const relation = borne[0];
  if (relation === undefined) return { status: "unresolved", reason: "elevation_unknown", provenance };
  if (borne.length > 1) return { status: "unresolved", reason: "elevation_ambiguous", provenance };
  const anchor = relation.anchor;
  if (anchor.kind === "participant") {
    return { status: "unresolved", reason: "elevation_unknown", provenance };
  }
  const surface = sceneSupportSurface(state, anchor.supportId);
  if (surface === undefined) {
    return { status: "unresolved", reason: "support_surface_absent", provenance };
  }
  return {
    status: "resolved",
    rung: SCENE_HEIGHT_RUNG_INDEX[surface.height.value],
    provenance: [...provenance, surface.height.provenance],
  };
}

/** Where one body zone actually is: the base it rests on, plus what the posture does with that zone. */
function zoneRung(state: SceneState, participant: SceneParticipant, zone: SceneBodyZone): SceneRungAnswer {
  const posture = participant.posture;
  if (posture === undefined) return { status: "unresolved", reason: "posture_unknown", provenance: [] };
  const base = participantBaseRung(state, participant);
  if (base.status === "unresolved") {
    return { status: "unresolved", reason: base.reason, provenance: [posture.provenance, ...base.provenance] };
  }
  const offset = SCENE_POSTURE_ZONE_RUNG[posture.value][zone];
  return {
    status: "resolved",
    rung: Math.min(Math.max(base.rung + offset, 0), SCENE_MAX_RUNG_INDEX),
    provenance: [posture.provenance, ...base.provenance],
  };
}

// ---------------------------------------------------------------------------
// The reach rule
// ---------------------------------------------------------------------------

/**
 * The four contact-core reaches, worst-last. Degradation walks DOWN this list,
 * never up: no fact this module holds can make a contact easier than the
 * distance between the two bodies already allows.
 */
const SCENE_REACH_LADDER: readonly ContactReach[] = [
  "in_contact",
  "within_reach",
  "within_reach_after_adjustment",
  "out_of_reach",
];

/**
 * Proximity band → the BEST reach it can support.
 *
 * This is the ceiling, before height, orientation, or anything else takes it
 * down. `near` maps to `within_reach_after_adjustment` rather than to a
 * rejection because the contact resolver already knows what to do with it: it
 * demands a visible reposition unless a minimal adjustment was proposed, which
 * is precisely what "one small movement away" should cost.
 */
const SCENE_PROXIMITY_CEILING: Readonly<Record<SceneProximityBand, ContactReach>> = {
  touching: "in_contact",
  close: "within_reach",
  near: "within_reach_after_adjustment",
  distant: "out_of_reach",
};

function degradeReach(reach: ContactReach, steps: number): ContactReach {
  const index = SCENE_REACH_LADDER.indexOf(reach);
  return SCENE_REACH_LADDER[Math.min(index + steps, SCENE_REACH_LADDER.length - 1)] ?? "out_of_reach";
}

/**
 * How much a height difference costs.
 *
 * Within the zone's span, nothing: an arm that can cross two rungs crosses them
 * without the body doing anything. One rung beyond, a single step down the
 * ladder — that is the bend, the stretch, the small lean the contact core calls
 * an adjustment. Past that, straight to `out_of_reach`, because the difference
 * between "she would have to lean" and "she would have to stand up and walk
 * round the bed" is exactly the difference this module exists to keep.
 */
function heightSteps(delta: number, span: number): number {
  if (delta <= span) return 0;
  if (delta <= span + 1) return 1;
  return SCENE_REACH_LADDER.length;
}

export interface SceneReachRequest {
  readonly state: SceneState;
  /** The acting surface. Always a body: this module answers who can reach, and objects do not reach. */
  readonly source: ContactBodySurfaceRef;
  readonly target: ContactSurfaceRef;
  readonly sink?: DiagnosticSink;
}

/**
 * Can this surface meet that one?
 *
 * ```text
 * proximity ceiling → height cost → orientation cost → reach
 * ```
 *
 * Support enters through ELEVATION only — how high the surface a body rests on
 * puts its zones. Whether the acting limb is free to move is a different
 * question with a different owner-facing answer, and it is `sceneSupportOf`
 * below; the contact resolver consults both and would double-count a limb that
 * was penalized here as well.
 *
 * An object target resolves only when the source body is anchored to that
 * object — resting on the bed, braced against the wall. The scene does not
 * model where furniture is relative to a body that is not touching it, and
 * saying so is better than a plausible number.
 */
export function sceneReach(request: SceneReachRequest): SceneReachAnswer {
  const { state, source, target } = request;

  const actor = sceneParticipant(state, source.subjectId);
  if (actor === undefined) return reachUnresolved("participant_absent", []);
  const sourceZone = sceneBodyZoneOf(source.locationId);
  if (sourceZone === undefined) return reachUnresolved("zone_unknown", []);
  const span = SCENE_ZONE_REACH_SPAN[sourceZone];

  if (target.kind === "object") {
    const surface = sceneSupportSurface(state, target.entityId);
    if (surface === undefined) return reachUnresolved("support_surface_absent", []);
    const support = actor.support;
    const anchored =
      support?.value.some(
        (relation) => relation.anchor.kind === "surface" && relation.anchor.supportId === target.entityId,
      ) ?? false;
    if (support === undefined || !anchored) return reachUnresolved("object_surface_unanchored", []);
    const actorRung = zoneRung(state, actor, sourceZone);
    if (actorRung.status === "unresolved") {
      return reachUnresolved(actorRung.reason, [support.provenance, ...actorRung.provenance]);
    }
    const provenance = [support.provenance, surface.height.provenance, ...actorRung.provenance];
    const delta = Math.abs(actorRung.rung - SCENE_HEIGHT_RUNG_INDEX[surface.height.value]);
    return { status: "resolved", reach: degradeReach("in_contact", heightSteps(delta, span)), provenance };
  }

  const other = sceneParticipant(state, target.subjectId);
  if (other === undefined) return reachUnresolved("participant_absent", []);
  const targetZone = sceneBodyZoneOf(target.locationId);
  if (targetZone === undefined) return reachUnresolved("zone_unknown", []);

  const proximity = sceneProximityFact(state, source.subjectId, target.subjectId);
  if (proximity === undefined) return reachUnresolved("proximity_unknown", []);
  const provenance: SceneProvenance[] = [proximity.provenance];

  // A ceiling of `out_of_reach` is an ANSWER. Nothing below can lift it, so no
  // further fact is consulted — and none is demanded, which is what lets a
  // scene say "they are in different rooms" without also stating two postures.
  const ceiling = SCENE_PROXIMITY_CEILING[proximity.value];
  if (ceiling === "out_of_reach") return { status: "resolved", reach: "out_of_reach", provenance };

  const actorRung = zoneRung(state, actor, sourceZone);
  if (actorRung.status === "unresolved") {
    return reachUnresolved(actorRung.reason, [...provenance, ...actorRung.provenance]);
  }
  provenance.push(...actorRung.provenance);
  const otherRung = zoneRung(state, other, targetZone);
  if (otherRung.status === "unresolved") {
    return reachUnresolved(otherRung.reason, [...provenance, ...otherRung.provenance]);
  }
  provenance.push(...otherRung.provenance);

  let steps = heightSteps(Math.abs(actorRung.rung - otherRung.rung), span);

  // Orientation is consulted only when it could matter. Bodies already touching
  // have settled the question between them — back-to-chest is contact — so a
  // scene is not forced to state a facing it does not have.
  if (proximity.value !== "touching") {
    const facing = sceneFacingFact(state, source.subjectId, target.subjectId);
    if (facing === undefined) return reachUnresolved("facing_unknown", provenance);
    provenance.push(facing.provenance);
    if (facing.value === "away") steps += 1;
  }

  return { status: "resolved", reach: degradeReach(ceiling, steps), provenance };
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

/**
 * Is this surface free to act, or is it holding something up?
 *
 * Answered from the load zones the scene's support relations declare, mapped
 * onto the contact core's own `mobility` / `supportRole` vocabulary rather than
 * a second one. A body with NO support relations answers `unresolved`: "nobody
 * said what she is doing with her hands" is not "her hands are free", and the
 * contact resolver is built to fall silent on the difference.
 *
 * A support set that was stated and is EMPTY answers `unresolved` too. The
 * clearing carries a timestamp so it can be ordered against later intents, but a
 * timestamp is not a claim: "nothing is named as holding her up" is the same
 * absence of information as "nobody said", and reading it as five free limbs
 * would turn a bookkeeping fact into a physical one.
 *
 * `trapped` has no producer here. Pinning, restraint, and a limb caught under
 * something are real, and 3A does not model them (spec §"Open design
 * questions") — inventing a shape for them now would be an untested guess.
 */
export function sceneSupportOf(state: SceneState, surface: ContactBodySurfaceRef): SceneSupportAnswer {
  const participant = sceneParticipant(state, surface.subjectId);
  if (participant === undefined) return { status: "unresolved", reason: "participant_absent", provenance: [] };
  const zone = sceneBodyZoneOf(surface.locationId);
  if (zone === undefined) return { status: "unresolved", reason: "zone_unknown", provenance: [] };
  const support = participant.support;
  if (support === undefined || support.value.length === 0) {
    return {
      status: "unresolved",
      reason: "support_unknown",
      provenance: support === undefined ? [] : [support.provenance],
    };
  }

  // The whole set is one fact, so every answer below rests on the same single
  // provenance entry — including `free`, which is an answer FROM the support
  // facts: the zone is free because every stated relation loads something else.
  const provenance = [support.provenance];
  const loading = support.value.filter((relation) => relation.loadZones.includes(zone));
  const bearing = loading.some((relation) => relation.role === "borne_by" || relation.role === "bearing");
  if (bearing) {
    return { status: "resolved", mobility: "fixed", supportRole: "weight_bearing", provenance };
  }
  if (loading.length > 0) {
    return { status: "resolved", mobility: "limited", supportRole: "partial", provenance };
  }
  return { status: "resolved", mobility: "free", supportRole: "free", provenance };
}

// ---------------------------------------------------------------------------
// Projections into the contact core
// ---------------------------------------------------------------------------

function reportUnresolved(reason: SceneUnresolvedReason, key: string, sink?: DiagnosticSink): void {
  sink?.push(
    diag("warn", SCENE_RELATION_UNAVAILABLE, `the scene could not answer ${key}`, { context: { reason } }),
  );
}

/**
 * The reach answer as the contact resolver's `geometry` input.
 *
 * `unresolved` becomes `unavailable` rather than `invalid`: nothing failed to
 * parse, the scene simply does not know, and the adapter result law reserves
 * `invalid` for a value that broke a trust boundary.
 */
export function sceneGeometryRead(request: SceneReachRequest): AdapterRead<ContactGeometryRead> {
  const answer = sceneReach(request);
  if (answer.status === "unresolved") {
    reportUnresolved(answer.reason, "reach", request.sink);
    return adapterUnavailable;
  }
  const evidence = sceneProvenanceEvidence(answer.provenance);
  return adapterSupported({ reach: answer.reach, evidence }, evidence);
}

/** The support answer as the contact resolver's `sourceSupport` / `targetSupport` input. */
export function sceneSupportRead(
  state: SceneState,
  surface: ContactBodySurfaceRef,
  sink?: DiagnosticSink,
): AdapterRead<ContactSupportRead> {
  const answer = sceneSupportOf(state, surface);
  if (answer.status === "unresolved") {
    reportUnresolved(answer.reason, "support", sink);
    return adapterUnavailable;
  }
  const evidence = sceneProvenanceEvidence(answer.provenance);
  return adapterSupported({ mobility: answer.mobility, supportRole: answer.supportRole, evidence }, evidence);
}

/** Every participant currently placed in the scene, in canonical order. */
export function sceneParticipantIds(state: SceneState): readonly AffordanceSubjectId[] {
  return state.participants.map((participant) => participant.subjectId);
}

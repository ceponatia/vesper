import type { CommittedContactRead } from "../affordances/contact";
import {
  affordanceEvidence,
  mergeAffordanceEvidence,
  type AffordanceEvidence,
} from "../affordances/core";
import {
  sceneProvenanceEvidence,
  sceneSupportSurface,
  type SceneParticipant,
  type SceneProvenance,
  type SceneState,
  type SceneSupportRelation,
} from "../affordances/scene";
import { bodyLocationRegistry } from "../body/locations";
import { diag, type DiagnosticSink } from "../diagnostics";
import { VISUAL_STATE_BODY_LANGUAGE_UNAVAILABLE, VISUAL_STATE_KIND_UNKNOWN } from "./diagnostics";
import {
  validateVisualStateFeature,
  visualStateFeatureKey,
  visualStateFingerprint,
  type VisualStateFeature,
} from "./feature";
import {
  VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
  type VisualStateBodyLanguageFacingValue,
  type VisualStateBodyLanguageHandOccupationValue,
  type VisualStateBodyLanguageMotionValue,
  type VisualStateBodyLanguagePostureValue,
  type VisualStateBodyLanguageSupportValue,
  type VisualStateHandSide,
} from "./kinds";
import type { VisualStateLocusRef } from "./locus";
import { visualStateKindRegistry } from "./registry";
import type { VisualStateKindDefinition } from "./definitions";
import type { VisualStateSuppression } from "./suppression";

/**
 * Body language from the scene / body-relations owner and the contact
 * lifecycle beside it (visual-state.plan.md §Slice 4;
 * visual-state.audit.md findings 12 and 13).
 *
 * ASSERTED FACTS ONLY. Everything projected here is a committed scene fact
 * with provenance — a stated posture, a stated support set, a stated facing, a
 * committed contact — and the value vocabularies are the owner's own. Nothing
 * here reads narrator prose, guesses an emotion from a stance, or defaults an
 * unstated fact: a participant whose posture nobody stated produces NO posture
 * feature, exactly as the scene owner's own reads answer `unresolved` for it.
 * That silence carries no diagnostic, because it is the owner answering — the
 * scene models absence as a first-class answer, not as degradation.
 *
 * Three body-language facts have NO owner anywhere in the app — gaze, fine
 * joint pose, and emotion-derived microexpression — and those are the ones
 * this module reports as suppressions with a diagnostic, once per projected
 * subject (plan §First-release source map; audit finding 14). The projection
 * returns them beside the features rather than folding them into a snapshot,
 * the same split `buildRecognitionCandidates` uses: the caller owns what the
 * inspector sees.
 *
 * ## Identity conventions
 *
 * - The `subjectsByParticipant` map selects which scene participants are in
 *   this snapshot and names the visual subject each features under; a
 *   participant not in the map is simply not in this snapshot (no diagnostic,
 *   matching the wardrobe adapter's actor map).
 * - Every id INSIDE a value or a relation locus is the owner's own identifier,
 *   carried verbatim — a scene subject id, a support surface id, a contact id —
 *   so the fingerprint depends on committed truth alone and never on how a
 *   caller happened to label its subjects.
 */

// ---------------------------------------------------------------------------
// Input and result
// ---------------------------------------------------------------------------

export interface VisualStateBodyLanguageProjectionInput {
  /** The committed scene state, contacts included — the owner, read verbatim. */
  readonly scene: SceneState;
  /**
   * Scene participant id → the visual subject id its features file under. The
   * caller scopes the snapshot; a participant absent from this map is not in
   * this snapshot and produces silence without a diagnostic.
   */
  readonly subjectsByParticipant: ReadonlyMap<string, string>;
  readonly sink?: DiagnosticSink;
  readonly path?: string;
}

export interface VisualStateBodyLanguageProjection {
  readonly features: readonly VisualStateFeature[];
  /**
   * The body-language facts this projection could not read because no owner
   * exists — one entry per unavailable fact per projected subject. Inspector
   * material; the caller decides where it surfaces.
   */
  readonly suppressions: readonly VisualStateSuppression[];
}

/**
 * The facts the plan names as explicitly unavailable: no owner anywhere in the
 * app can assert them, and the ruling is silence plus a diagnostic rather than
 * a plausible guess (plan §Missing owners mean silence).
 */
export const bodyLanguageUnavailableFacts = ["gaze", "fine_joint_pose", "microexpression"] as const;
export type BodyLanguageUnavailableFact = (typeof bodyLanguageUnavailableFacts)[number];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Evidence for one scene-fact feature: the adapter, then the owner's own
 * provenance trail (event ref, source kind, and whatever evidence the fact
 * already carried).
 */
function sceneFactEvidence(aspect: string, provenance: SceneProvenance): readonly AffordanceEvidence[] {
  return mergeAffordanceEvidence(
    [affordanceEvidence("adapter", "visual_state.body_language", aspect)],
    sceneProvenanceEvidence([provenance]),
  );
}

interface ProjectionState {
  readonly input: VisualStateBodyLanguageProjectionInput;
  readonly path: string;
  readonly features: VisualStateFeature[];
}

/** Registry lookup with the shared degraded path — a missing kind is silence plus a diagnostic. */
function kindOrReport(state: ProjectionState, kindId: string): VisualStateKindDefinition | null {
  const kind = visualStateKindRegistry.byId(kindId);
  if (kind) return kind;
  state.input.sink?.push(
    diag("warn", VISUAL_STATE_KIND_UNKNOWN, `${kindId} is not registered`, {
      path: state.path,
      context: { kindId },
    }),
  );
  return null;
}

function pushValidated(
  state: ProjectionState,
  candidate: VisualStateFeature,
): void {
  const accepted = validateVisualStateFeature(candidate, state.input.sink, state.path);
  if (accepted !== null) state.features.push(accepted);
}

/**
 * `changedAtMinutes` for a scene fact is the owner's own stamp. The owner
 * re-stamps a fact whenever an intent touches it, so this reads "last
 * asserted" rather than strictly "last moved" — the alternative, comparing
 * against a previous cut this pure function cannot see, would be inventing
 * history the owner never recorded.
 */
function sceneFactStamp(provenance: SceneProvenance): number {
  return provenance.storyTime;
}

// ---------------------------------------------------------------------------
// Posture and support
// ---------------------------------------------------------------------------

function projectPosture(state: ProjectionState, participant: SceneParticipant, subjectId: string): void {
  const fact = participant.posture;
  if (fact === undefined) return;
  const kind = kindOrReport(state, VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID);
  if (!kind) return;
  const value: VisualStateBodyLanguagePostureValue = { posture: fact.value };
  const locus: VisualStateLocusRef = { kind: "subject", subjectId };
  pushValidated(state, {
    version: 1,
    key: visualStateFeatureKey(subjectId, locus, VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID),
    subjectId,
    kindId: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
    layer: kind.layer,
    locus,
    sourceRef: { kind: "scene_relation", relationId: `posture:${participant.subjectId}` },
    value,
    truthFingerprint: visualStateFingerprint(value),
    semanticTags: [fact.value],
    stability: kind.stability,
    // A posture asserts nothing about other features; what it changes about
    // reach and elevation is the scene owner's own derivation, not an edge.
    relationships: [],
    priors: kind.priors,
    evidence: sceneFactEvidence("posture", fact.provenance),
    changedAtMinutes: sceneFactStamp(fact.provenance),
  });
}

/** One relation resolved into the value vocabulary, surface kind included when the scene holds the surface. */
function supportRelationValue(
  scene: SceneState,
  relation: SceneSupportRelation,
): VisualStateBodyLanguageSupportValue["relations"][number] {
  if (relation.anchor.kind === "participant") {
    return {
      role: relation.role,
      anchor: { kind: "participant", subjectId: relation.anchor.subjectId },
      loadZones: [...relation.loadZones],
    };
  }
  const surface = sceneSupportSurface(scene, relation.anchor.supportId);
  return {
    role: relation.role,
    anchor: {
      kind: "surface",
      supportId: relation.anchor.supportId,
      ...(surface === undefined ? {} : { surfaceKind: surface.kind }),
    },
    loadZones: [...relation.loadZones],
  };
}

function projectSupport(state: ProjectionState, participant: SceneParticipant, subjectId: string): void {
  const fact = participant.support;
  // A stated-EMPTY set is a timestamped clearing, and the scene owner's own
  // reads treat it exactly like absence: nobody said what holds this body up.
  // Both produce silence here — projecting an empty list would turn a
  // bookkeeping fact into a visual claim of unsupported standing.
  if (fact === undefined || fact.value.length === 0) return;
  const kind = kindOrReport(state, VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID);
  if (!kind) return;
  const value: VisualStateBodyLanguageSupportValue = {
    relations: fact.value.map((relation) => supportRelationValue(state.input.scene, relation)),
  };
  const tags = [
    ...new Set(
      value.relations.flatMap((relation) => [
        relation.role,
        ...(relation.anchor.kind === "surface" && relation.anchor.surfaceKind !== undefined
          ? [relation.anchor.surfaceKind]
          : []),
      ]),
    ),
  ].sort(compareStrings);
  const locus: VisualStateLocusRef = { kind: "subject", subjectId };
  pushValidated(state, {
    version: 1,
    key: visualStateFeatureKey(subjectId, locus, VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID),
    subjectId,
    kindId: VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
    layer: kind.layer,
    locus,
    sourceRef: { kind: "scene_relation", relationId: `support:${participant.subjectId}` },
    value,
    truthFingerprint: visualStateFingerprint(value),
    semanticTags: tags,
    stability: kind.stability,
    relationships: [],
    priors: kind.priors,
    evidence: sceneFactEvidence("support", fact.provenance),
    changedAtMinutes: sceneFactStamp(fact.provenance),
  });
}

// ---------------------------------------------------------------------------
// Facing
// ---------------------------------------------------------------------------

function projectFacing(state: ProjectionState): void {
  for (const relation of state.input.scene.facing) {
    const subjectId = state.input.subjectsByParticipant.get(relation.subjectId);
    // The fact belongs to the participant doing the facing; the toward end may
    // legitimately be somebody outside this snapshot ("her back is to the
    // door"), so only the facing side has to be mapped.
    if (subjectId === undefined) continue;
    const kind = kindOrReport(state, VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID);
    if (!kind) return;
    const relationId = `facing:${relation.subjectId}:${relation.towardId}`;
    const value: VisualStateBodyLanguageFacingValue = {
      facing: relation.facing.value,
      towardSubjectId: relation.towardId,
    };
    const locus: VisualStateLocusRef = { kind: "relation", relationId };
    pushValidated(state, {
      version: 1,
      key: visualStateFeatureKey(subjectId, locus, VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID),
      subjectId,
      kindId: VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID,
      layer: kind.layer,
      locus,
      sourceRef: { kind: "scene_relation", relationId },
      value,
      truthFingerprint: visualStateFingerprint(value),
      semanticTags: [relation.facing.value],
      stability: kind.stability,
      relationships: [],
      priors: kind.priors,
      evidence: sceneFactEvidence("facing", relation.facing.provenance),
      changedAtMinutes: sceneFactStamp(relation.facing.provenance),
    });
  }
}

// ---------------------------------------------------------------------------
// Hand occupation and committed motion (the contact lifecycle)
// ---------------------------------------------------------------------------

/**
 * The hand subtree, resolved once from the registry: `hands` and everything
 * under it. A contact sourced from any of these engages a hand; a contact from
 * the wrist or lips does not.
 */
const HAND_LOCATION_IDS: ReadonlySet<string> = new Set(bodyLocationRegistry.expand("hands"));

function handSideOf(contact: CommittedContactRead): VisualStateHandSide {
  const side = contact.source.side;
  // `center` is a legal contact side with no hand meaning — a body has no
  // center hand — so it degrades to `unspecified` rather than being invented
  // into one.
  return side === "left" || side === "right" ? side : "unspecified";
}

interface HandBucket {
  readonly participantId: string;
  readonly subjectId: string;
  readonly side: VisualStateHandSide;
  readonly contacts: CommittedContactRead[];
}

/**
 * Occupied hands, derived from the active contacts — the one derivation the
 * plan sanctions (audit finding 13: no `occupiedHands` owner exists, and the
 * source map names the contact lifecycle as where the fact comes from). A
 * support relation loading `arms` is NOT re-derived into a hand here: the
 * support set already projects with its load zones, and deriving a side-less
 * hand from a zone would state more than the owner does.
 */
function projectHandOccupation(state: ProjectionState): void {
  const buckets = new Map<string, HandBucket>();
  for (const contact of state.input.scene.contacts.contacts) {
    const subjectId = state.input.subjectsByParticipant.get(contact.source.subjectId);
    if (subjectId === undefined) continue;
    if (!HAND_LOCATION_IDS.has(contact.source.locationId)) continue;
    const side = handSideOf(contact);
    const bucketKey = `${contact.source.subjectId}\u0000${side}`;
    // The separator is a control character (as in the composition resolver's
    // edge ids): no subject id contains one, so two different (participant,
    // side) pairs can never share a bucket.
    const bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      buckets.set(bucketKey, { participantId: contact.source.subjectId, subjectId, side, contacts: [contact] });
    } else {
      bucket.contacts.push(contact);
    }
  }

  for (const [, bucket] of [...buckets.entries()].sort(([left], [right]) => compareStrings(left, right))) {
    const kind = kindOrReport(state, VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID);
    if (!kind) return;
    const contacts = [...bucket.contacts].sort((left, right) => compareStrings(left.contactId, right.contactId));
    const first = contacts[0];
    if (first === undefined) continue;
    const value: VisualStateBodyLanguageHandOccupationValue = { side: bucket.side };
    const locus: VisualStateLocusRef = {
      kind: "body",
      locus: {
        bodyLocationId: "hands",
        ...(bucket.side === "unspecified" ? {} : { side: bucket.side }),
      },
    };
    const actionTags = [...new Set(contacts.map((contact) => contact.actionKind))].sort(compareStrings);
    pushValidated(state, {
      version: 1,
      key: visualStateFeatureKey(bucket.subjectId, locus, VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID),
      subjectId: bucket.subjectId,
      kindId: VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID,
      layer: kind.layer,
      locus,
      // One sourceRef per feature, so the FIRST contact in contact-id order is
      // the named source; every occupying contact is in the evidence, which is
      // where the inspector reads the full set.
      sourceRef: { kind: "contact", contactId: first.contactId },
      value,
      truthFingerprint: visualStateFingerprint(value),
      semanticTags: [bucket.side, ...actionTags],
      stability: kind.stability,
      relationships: [],
      priors: kind.priors,
      evidence: mergeAffordanceEvidence(
        [affordanceEvidence("adapter", "visual_state.body_language", "hand_occupation")],
        contacts.map((contact) => affordanceEvidence("contact", contact.contactId, contact.actionKind)),
      ),
      // "When did this hand become occupied" has one honest answer only while
      // one contact occupies it. With several, any single stamp would date the
      // aggregate by an arbitrary member, so the stamp is omitted.
      ...(contacts.length === 1 ? { changedAtMinutes: first.startedAt } : {}),
    });
  }
}

function projectMotion(state: ProjectionState): void {
  for (const contact of state.input.scene.contacts.contacts) {
    const motion = contact.motion;
    if (motion === undefined) continue;
    const subjectId = state.input.subjectsByParticipant.get(contact.actorId);
    if (subjectId === undefined) continue;
    const kind = kindOrReport(state, VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID);
    if (!kind) return;
    // A present-but-empty path token list means the same as no list — the
    // domain stated no path — and the two must not fingerprint differently.
    const pathDetailIds = motion.pathDetailIds !== undefined && motion.pathDetailIds.length > 0
      ? [...motion.pathDetailIds]
      : undefined;
    const value: VisualStateBodyLanguageMotionValue = {
      band: motion.band,
      ...(pathDetailIds === undefined ? {} : { pathDetailIds }),
    };
    const locus: VisualStateLocusRef = { kind: "relation", relationId: contact.contactId };
    pushValidated(state, {
      version: 1,
      key: visualStateFeatureKey(subjectId, locus, VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID),
      subjectId,
      kindId: VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID,
      layer: kind.layer,
      locus,
      sourceRef: { kind: "contact", contactId: contact.contactId },
      value,
      truthFingerprint: visualStateFingerprint(value),
      semanticTags: [motion.band, contact.actionKind],
      stability: kind.stability,
      relationships: [],
      priors: kind.priors,
      evidence: mergeAffordanceEvidence(
        [
          affordanceEvidence("adapter", "visual_state.body_language", "motion"),
          affordanceEvidence("contact", contact.contactId, motion.band),
        ],
        motion.evidence,
      ),
      changedAtMinutes: contact.lastUpdatedAt,
    });
  }
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * Project the scene's proved body language into visual-state features, and
 * report the body-language facts that have no owner at all.
 *
 * Determinism is structural: participants, facing relations and contacts are
 * walked in the scene state's own canonical order, hand buckets are sorted by
 * key, and every derived list inside a value or tag set is sorted — the same
 * committed scene produces byte-equal features on every machine.
 *
 * Contributions from this projection ride the `scene_relation` adapter id in
 * `buildVisualStateSnapshot`.
 */
export function projectBodyLanguageFeatures(
  input: VisualStateBodyLanguageProjectionInput,
): VisualStateBodyLanguageProjection {
  const path = input.path ?? "visual_state.body_language";
  const state: ProjectionState = { input, path, features: [] };
  const suppressions: VisualStateSuppression[] = [];

  for (const participant of input.scene.participants) {
    const subjectId = input.subjectsByParticipant.get(participant.subjectId);
    if (subjectId === undefined) continue;
    projectPosture(state, participant, subjectId);
    projectSupport(state, participant, subjectId);
  }
  projectFacing(state);
  projectHandOccupation(state);
  projectMotion(state);

  // The three ownerless facts, once per projected subject. `info`, not `warn`:
  // this is the app's permanent designed state (audit finding 14), reported so
  // slice 6 can measure missing-owner frequency, not a degradation of this run.
  for (const participant of input.scene.participants) {
    const subjectId = input.subjectsByParticipant.get(participant.subjectId);
    if (subjectId === undefined) continue;
    for (const fact of bodyLanguageUnavailableFacts) {
      suppressions.push({
        key: visualStateFeatureKey(subjectId, { kind: "subject", subjectId }, `body_language.${fact}`),
        code: VISUAL_STATE_BODY_LANGUAGE_UNAVAILABLE,
        detail: fact,
      });
    }
    input.sink?.push(
      diag("info", VISUAL_STATE_BODY_LANGUAGE_UNAVAILABLE, "Gaze, fine joint pose and microexpression have no owner", {
        path,
        context: { subjectId, facts: [...bodyLanguageUnavailableFacts] },
      }),
    );
  }

  return { features: state.features, suppressions };
}

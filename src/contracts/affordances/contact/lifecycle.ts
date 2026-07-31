import { diag, type DiagnosticSink } from "../../diagnostics";
import { deepFreeze, mergeAffordanceEvidence, type AffordanceStoryTime } from "../core";
import { CONTACT_AUTHORIZATION_LAPSED, CONTACT_LIFECYCLE_INVALID } from "./diagnostics";
import {
  CONTACT_ACTION_SCOPE,
  contactActionRequiresAdultEligibility,
  contactActionRequiresPermission,
  type ContactInteractionPolicyRead,
  type ContactParticipantEligibilityRead,
} from "./decisions";
import { contactPairKey, contactParticipantIds, isInterpersonalContact } from "./surfaces";
import { deriveContactId, type ContactEventRef, type ContactId } from "./identity";
import {
  composeContactMaterial,
  sortContactMaterialLayers,
  type ContactMaterialLayerRead,
  type ContactMaterialTransmissionRead,
} from "./material";
import type {
  CommittableContactResolution,
  CommittedContactRead,
  CommittedContactSnapshot,
  ContactEndReason,
  ContactEndedCommit,
  ContactLifecycleCommit,
  EndedContactRecord,
} from "./types";

/**
 * The contact lifecycle fold — attempt → start / update / continue → end
 * (romantic-contact-affordances.spec.contact-core.md §"Contact lifecycle").
 *
 * The active projection is a bounded list keyed by the order-independent surface
 * pair. Everything here is pure: state in, state out, no clock, no id counter,
 * no hidden latch. A retake that restores the same state and replays the same
 * commits reproduces the identical projection, which is the whole reason the
 * lane may store this blob beside its other rollback anchors.
 *
 * ## The four transitions, and the one that writes nothing
 *
 * - **start** — a committable resolution on a pair that has no active contact.
 *   Mints a derived id from the pair and the start event.
 * - **update** — a committable resolution on a pair that already has one, whose
 *   physical content differs. Keeps the id AND the whole start identity, and
 *   replaces the mutable half with a full snapshot stamped by the new event.
 * - **continue** — the same, when nothing differs. Returns the SAME state
 *   reference and no new event, so an unchanged held contact across ten
 *   exchanges is one start and nine no-ops rather than ten starts.
 * - **end** — removes the contact from the projection and hands back an
 *   `EndedContactRecord`, whose `phase: "ended"` makes it unusable as a current
 *   contact.
 *
 * ## Three laws this file is built around
 *
 * 1. **Start identity is immutable.** `contactId`, `pairKey`, `startedAt`,
 *    `startedByEventRef`, `actorId`, `actionKind`, `source`, `target`, and the
 *    three decisions belong to the contact that BEGAN. The pair key is
 *    order-independent, so the same touch can legitimately be re-asserted from
 *    the other side — and taking the new assertion's orientation would silently
 *    rewrite who was touching whom for every observation downstream. An
 *    assertion with a different `actionKind` is not an update at all: it ends the
 *    old contact and starts a new one, so the escalation gets its own identity
 *    and its own permission evidence.
 * 2. **Nothing leaves the projection without an event.** Capacity pressure and a
 *    framing change both emit durable `contact_ended` commits alongside the new
 *    contact, because a projection-only drop is indistinguishable from a contact
 *    that ended and replays into a projection that still holds it.
 * 3. **A stale assertion cannot rewrite a newer projection.** An intent whose
 *    story time predates the contact's last update is a replayed or out-of-order
 *    write; it continues the contact and files a diagnostic rather than winding
 *    `lastUpdatedAt` backwards past `startedAt`. The check runs FIRST, for every
 *    assertion on an occupied pair — a stale one cannot end a contact through
 *    the framing-change path either, because "this is a different kind of touch"
 *    says nothing about which of the two writes is the later one.
 *
 * Story time never advances a contact by itself. There is no timeout: a contact
 * ends because something ended it, and "the narrator stopped mentioning it" is
 * not something.
 */

/** Version 1 of the persisted shape. Bumping it is a healing decision, not a rename. */
export const CONTACT_LIFECYCLE_STATE_VERSION = 1;

/** The bound on the active projection. A scene with more live contacts than this is a bug. */
export const CONTACT_LIFECYCLE_MAX_ACTIVE = 16;

export interface ContactLifecycleState {
  readonly version: typeof CONTACT_LIFECYCLE_STATE_VERSION;
  /** Active contacts, ordered by pair key so the blob is byte-stable. */
  readonly contacts: readonly CommittedContactRead[];
}

/** Nothing is touching — the seed value and the degraded default at every boundary. */
export function emptyContactLifecycleState(): ContactLifecycleState {
  return { version: CONTACT_LIFECYCLE_STATE_VERSION, contacts: [] };
}

function withContacts(contacts: readonly CommittedContactRead[]): ContactLifecycleState {
  return {
    version: CONTACT_LIFECYCLE_STATE_VERSION,
    contacts: [...contacts].sort((left, right) => left.pairKey.localeCompare(right.pairKey)),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The active contact with this id, if it is still active.
 *
 * This is the ONLY door between stored lifecycle state and a physical
 * observation. An ended contact is not in the list, so it cannot come back
 * through here, and the return type is the active-phase read that the observation
 * stage requires.
 */
export function activeContact(state: ContactLifecycleState, id: ContactId): CommittedContactRead | undefined {
  return state.contacts.find((contact) => contact.contactId === id);
}

/** The active contact occupying this surface pair, if any. */
export function activeContactForPair(
  state: ContactLifecycleState,
  pairKey: string,
): CommittedContactRead | undefined {
  return state.contacts.find((contact) => contact.pairKey === pairKey);
}

/** Every contact currently active, in pair-key order. */
export function activeContactsOf(state: ContactLifecycleState): readonly CommittedContactRead[] {
  return state.contacts;
}

// ---------------------------------------------------------------------------
// Identity and snapshots
// ---------------------------------------------------------------------------

/**
 * The half of a committed contact that never changes after it starts.
 *
 * Naming it as a type is what makes the immutability mechanical: an update is
 * `withSnapshot(existingContact, …)`, and there is no code path that rebuilds
 * these fields from a later intent.
 */
type ContactStartIdentity = Pick<
  CommittedContactRead,
  | "contactId"
  | "pairKey"
  | "startedByEventRef"
  | "startedAt"
  | "actorId"
  | "actionKind"
  | "source"
  | "target"
  | "actorControl"
  | "participantEligibility"
  | "policy"
>;

/** Which event, at which story minute, is asserting the contact right now. */
interface ContactStamp {
  readonly eventRef: ContactEventRef;
  readonly storyTime: AffordanceStoryTime;
}

/** The mutable half, as one resolution asserts it. */
function snapshotFromResolution(resolution: CommittableContactResolution): CommittedContactSnapshot {
  const { intent, access } = resolution;
  return {
    pressure: intent.requestedPressure ?? null,
    contactArea: intent.requestedArea ?? null,
    motion:
      intent.requestedMotion === undefined
        ? null
        : {
            band: intent.requestedMotion.band,
            ...(intent.requestedMotion.pathDetailIds === undefined
              ? {}
              : { pathDetailIds: [...intent.requestedMotion.pathDetailIds] }),
            evidence: [],
          },
    materialBetween: access.materialBetween,
    transmission: access.transmission,
    implicitAdjustments: access.implicitAdjustments,
    evidence: mergeAffordanceEvidence(resolution.evidence),
  };
}

/** The mutable half, as the projection currently holds it. */
function snapshotOfContact(contact: CommittedContactRead): CommittedContactSnapshot {
  return {
    pressure: contact.pressure ?? null,
    contactArea: contact.contactArea ?? null,
    motion: contact.motion ?? null,
    materialBetween: contact.materialBetween,
    transmission: contact.transmission,
    implicitAdjustments: contact.implicitAdjustments,
    evidence: contact.evidence,
  };
}

/**
 * Lay a snapshot over a start identity. The one constructor for an active
 * contact — start, update, and event replay all go through it, so the three can
 * never disagree about what an assertion produces.
 */
function withSnapshot(
  identity: ContactStartIdentity,
  snapshot: CommittedContactSnapshot,
  stamp: ContactStamp,
): CommittedContactRead {
  return {
    phase: "active",
    contactId: identity.contactId,
    pairKey: identity.pairKey,
    startedByEventRef: identity.startedByEventRef,
    lastUpdatedByEventRef: stamp.eventRef,
    startedAt: identity.startedAt,
    lastUpdatedAt: stamp.storyTime,
    actorId: identity.actorId,
    actionKind: identity.actionKind,
    source: identity.source,
    target: identity.target,
    ...(snapshot.pressure === null ? {} : { pressure: snapshot.pressure }),
    ...(snapshot.contactArea === null ? {} : { contactArea: snapshot.contactArea }),
    ...(snapshot.motion === null ? {} : { motion: snapshot.motion }),
    materialBetween: snapshot.materialBetween,
    transmission: snapshot.transmission,
    implicitAdjustments: snapshot.implicitAdjustments,
    actorControl: identity.actorControl,
    participantEligibility: identity.participantEligibility,
    policy: identity.policy,
    evidence: snapshot.evidence,
  };
}

/** The identity a brand-new contact is born with. */
function startIdentity(input: {
  resolution: CommittableContactResolution;
  pairKey: string;
  eventRef: ContactEventRef;
}): ContactStartIdentity {
  const { intent } = input.resolution;
  return {
    contactId: deriveContactId({ pairKey: input.pairKey, startedByEventRef: input.eventRef }),
    pairKey: input.pairKey,
    startedByEventRef: input.eventRef,
    startedAt: intent.storyTime,
    actorId: intent.actorId,
    actionKind: intent.actionKind,
    source: intent.source,
    target: intent.target,
    actorControl: input.resolution.actorControl,
    participantEligibility: input.resolution.participantEligibility,
    policy: input.resolution.policy,
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface ContactCommitRequest {
  readonly state: ContactLifecycleState;
  readonly resolution: CommittableContactResolution;
  readonly eventRef: ContactEventRef;
  readonly sink?: DiagnosticSink;
}

export interface ContactCommitOutcome {
  readonly state: ContactLifecycleState;
  readonly commit: ContactLifecycleCommit;
  readonly contact: CommittedContactRead;
  /**
   * Contacts this same lane event ENDED to make room for the one above —
   * capacity pressure, or a framing change on the same pair.
   *
   * Ordinarily empty. Never a projection-only drop: these are durable commits,
   * and `contactCommitEvents` puts them ahead of `commit` in the stream so a
   * replay frees the pair before the new contact claims it.
   */
  readonly ended: readonly ContactEndedCommit[];
}

/** Every durable commit an outcome produced, in the order a fold must apply them. */
export function contactCommitEvents(outcome: ContactCommitOutcome): readonly ContactLifecycleCommit[] {
  return [...outcome.ended, outcome.commit];
}

/**
 * One layer's physical CONTENT, in a fixed field order.
 *
 * `evidence` is deliberately absent: it is provenance, not physics. Two layers
 * carrying identical numbers are the same material however the adapter found
 * them, and folding a ref that varies per read into the fingerprint would emit
 * `contact_updated` every exchange for a contact nothing happened to — the
 * mirror image of the bug this function exists to fix.
 */
function materialFingerprint(layer: ContactMaterialLayerRead): readonly (string | number | boolean)[] {
  return [
    layer.layerId,
    layer.order,
    layer.tactileTransmission,
    layer.shapeTransmission,
    layer.thermalTransmission,
    layer.moistureTransmission,
    layer.scentTransmission,
    layer.visibleThrough,
  ];
}

/**
 * The physical content two assertions must agree on to be "the same contact,
 * unchanged".
 *
 * Layers are fingerprinted by their CONTENT, never by their ids alone. A
 * `layerId` is the owner's own instance id and it survives the material changing
 * underneath it: a covering soaking through keeps its id while its permeability,
 * moisture transmission, and shape transmission all move. An id-only fingerprint
 * took the CONTINUE path for exactly that case, so the projection kept the dry
 * snapshot and every observation downstream described a material that no longer
 * existed.
 *
 * Array position is NOT content. `sortContactMaterialLayers` is a total
 * canonical order (`order`, then `layerId`) and the `order` field itself is in
 * the fingerprint, so a layer that genuinely moved in the stack is a change
 * while an adapter that returned the same layers in a different array order is
 * not — otherwise a re-read of an unchanged cut would write an update event for
 * a presentation detail.
 *
 * `transmission` and `evidence` are excluded for the same reason: the first is
 * derived from the layers already in the key, and the second is provenance.
 *
 * Adjustments stay keyed by `id`: unlike a layer, an accepted adjustment is
 * minted by `classifyContactAdjustment` from one proposal and carries no
 * magnitude that could drift under a stable id.
 */
function contentKey(snapshot: CommittedContactSnapshot): string {
  return JSON.stringify([
    snapshot.pressure,
    snapshot.contactArea,
    snapshot.motion === null ? null : [snapshot.motion.band, snapshot.motion.pathDetailIds ?? []],
    sortContactMaterialLayers(snapshot.materialBetween).map((layer) => materialFingerprint(layer)),
    snapshot.implicitAdjustments.map((adjustment) => adjustment.id),
  ]);
}

/** Oldest first, ties broken on the pair key so eviction order is total. */
function byStartOrder(left: CommittedContactRead, right: CommittedContactRead): number {
  return left.startedAt === right.startedAt
    ? left.pairKey.localeCompare(right.pairKey)
    : left.startedAt - right.startedAt;
}

/**
 * Which contacts have to end before one more can start.
 *
 * The oldest-started lose. A scene with more than sixteen simultaneous live
 * contacts is an adapter that has stopped ending them, so the pressure is
 * reported as well as acted on — but it is acted on with real `contact_ended`
 * commits, never a quiet trim of the projection.
 */
function overCapacity(contacts: readonly CommittedContactRead[]): readonly CommittedContactRead[] {
  if (contacts.length < CONTACT_LIFECYCLE_MAX_ACTIVE) return [];
  return [...contacts].sort(byStartOrder).slice(0, contacts.length - CONTACT_LIFECYCLE_MAX_ACTIVE + 1);
}

function endedFrom(
  contact: CommittedContactRead,
  input: { storyTime: AffordanceStoryTime; eventRef: ContactEventRef; reason: ContactEndReason },
): EndedContactRecord {
  return {
    ...contact,
    phase: "ended",
    endedAt: input.storyTime,
    endedByEventRef: input.eventRef,
    endReason: input.reason,
  };
}

function endedCommit(
  contact: CommittedContactRead,
  input: { storyTime: AffordanceStoryTime; eventRef: ContactEventRef; reason: ContactEndReason },
): ContactEndedCommit {
  return {
    kind: "contact_ended",
    contactId: contact.contactId,
    eventRef: input.eventRef,
    reason: input.reason,
    storyTime: input.storyTime,
    contact: deepFreeze(endedFrom(contact, input)),
  };
}

function continued(
  state: ContactLifecycleState,
  contact: CommittedContactRead,
  storyTime: AffordanceStoryTime,
): ContactCommitOutcome {
  return {
    state,
    commit: { kind: "contact_continued", contactId: contact.contactId, storyTime, contact },
    contact,
    ended: [],
  };
}

/**
 * An assertion older than the contact it lands on, or `undefined` when it is
 * current enough to act on.
 *
 * Checked for EVERY assertion on an occupied pair, before the same-kind and
 * framing-change paths split. Guarding only the same-kind path left the rule
 * with a door: a stale assertion carrying a different `actionKind` fell through
 * to end+start, which ended a newer contact at a story time before its own last
 * update and replaced it with one whose `startedAt` predates the contact it
 * displaced. Winding time backwards through the framing door is the same defect
 * as winding it backwards through the update door.
 */
function staleAssertion(
  request: ContactCommitRequest,
  existing: CommittedContactRead,
  stamp: ContactStamp,
): ContactCommitOutcome | undefined {
  if (stamp.storyTime >= existing.lastUpdatedAt) return undefined;
  request.sink?.push(
    diag("warn", CONTACT_LIFECYCLE_INVALID, "a contact assertion older than the projection was not applied", {
      context: {
        contactId: existing.contactId,
        asserted: stamp.storyTime,
        lastUpdatedAt: existing.lastUpdatedAt,
        assertedKind: request.resolution.intent.actionKind,
      },
    }),
  );
  return continued(request.state, existing, stamp.storyTime);
}

/** An assertion on a pair that already carries a contact of the same action kind. */
function updateExisting(
  request: ContactCommitRequest,
  existing: CommittedContactRead,
  stamp: ContactStamp,
): ContactCommitOutcome {
  const snapshot = snapshotFromResolution(request.resolution);
  if (contentKey(snapshot) === contentKey(snapshotOfContact(existing))) {
    return continued(request.state, existing, stamp.storyTime);
  }

  const contact = deepFreeze(withSnapshot(existing, snapshot, stamp));
  return {
    state: withContacts(
      request.state.contacts.map((entry) => (entry.contactId === existing.contactId ? contact : entry)),
    ),
    commit: {
      kind: "contact_updated",
      contactId: contact.contactId,
      eventRef: stamp.eventRef,
      snapshot,
      storyTime: stamp.storyTime,
      contact,
    },
    contact,
    ended: [],
  };
}

/**
 * Commit a committable resolution into the projection.
 *
 * Only a `CommittableContactResolution` can be passed, so a rejected or
 * unresolved attempt is structurally incapable of reaching this function — the
 * spec's "an attempt cannot masquerade as committed contact" is a compile error
 * rather than a test.
 *
 * The result is deep-frozen: a resolver downstream that tried to cache into the
 * committed read would throw in test rather than corrupt the next turn's fold.
 */
export function commitContactResolution(request: ContactCommitRequest): ContactCommitOutcome {
  const { intent } = request.resolution;
  const pairKey = contactPairKey(intent.source, intent.target);
  const existing = activeContactForPair(request.state, pairKey);
  const stamp: ContactStamp = { eventRef: request.eventRef, storyTime: intent.storyTime };

  if (existing !== undefined) {
    // Before anything can end, start, or change: is this assertion even current?
    const stale = staleAssertion(request, existing, stamp);
    if (stale !== undefined) return stale;
    if (existing.actionKind === intent.actionKind) return updateExisting(request, existing, stamp);
  }

  const ended: ContactEndedCommit[] = [];
  let remaining = request.state.contacts;

  // A different action kind on the same surfaces is a different contact: the
  // framing is start identity, and the permission evidence that justified the
  // old one never covered the new one. End it, then start fresh.
  if (existing !== undefined) {
    request.sink?.push(
      diag("warn", CONTACT_LIFECYCLE_INVALID, "the action framing changed on a live contact; it was ended", {
        context: { contactId: existing.contactId, from: existing.actionKind, to: intent.actionKind },
      }),
    );
    ended.push(endedCommit(existing, { ...stamp, reason: "state_invalidated" }));
    remaining = remaining.filter((entry) => entry.contactId !== existing.contactId);
  }

  const evicted = overCapacity(remaining);
  if (evicted.length > 0) {
    request.sink?.push(
      diag("warn", CONTACT_LIFECYCLE_INVALID, "active contact projection is at capacity; the oldest were ended", {
        context: { ended: evicted.map((contact) => contact.contactId) },
      }),
    );
    for (const contact of evicted) ended.push(endedCommit(contact, { ...stamp, reason: "state_invalidated" }));
    remaining = remaining.filter((entry) => !evicted.includes(entry));
  }

  const contact = deepFreeze(
    withSnapshot(
      startIdentity({ resolution: request.resolution, pairKey, eventRef: request.eventRef }),
      snapshotFromResolution(request.resolution),
      stamp,
    ),
  );
  return {
    state: withContacts([...remaining, contact]),
    commit: { kind: "contact_started", contact },
    contact,
    ended,
  };
}

// ---------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------

export interface ContactEndRequest {
  readonly state: ContactLifecycleState;
  readonly contactId: ContactId;
  readonly reason: ContactEndReason;
  readonly storyTime: AffordanceStoryTime;
  readonly eventRef: ContactEventRef;
  readonly sink?: DiagnosticSink;
}

export interface ContactEndOutcome {
  readonly state: ContactLifecycleState;
  /** `null` when nothing was active under that id — the state is returned unchanged. */
  readonly commit: ContactEndedCommit | null;
}

/**
 * End one contact.
 *
 * Ending something that is not active is a caller bug, not a story fact: it
 * files an `error` diagnostic and changes nothing, because silently succeeding
 * would let a double-end look identical to a real one on a branch replay.
 */
export function endContact(request: ContactEndRequest): ContactEndOutcome {
  const contact = activeContact(request.state, request.contactId);
  if (contact === undefined) {
    request.sink?.push(
      diag("error", CONTACT_LIFECYCLE_INVALID, "end requested for a contact that is not active", {
        context: { contactId: request.contactId },
      }),
    );
    return { state: request.state, commit: null };
  }
  return {
    state: withContacts(request.state.contacts.filter((entry) => entry.contactId !== request.contactId)),
    commit: endedCommit(contact, {
      storyTime: request.storyTime,
      eventRef: request.eventRef,
      reason: request.reason,
    }),
  };
}

/**
 * End every active contact — scene exit, branch restore, or a state transition
 * that invalidates the whole projection.
 *
 * Deterministic by construction: the contacts are already pair-key ordered, so
 * the emitted commits are in the same order every time.
 */
export function endAllContacts(request: {
  state: ContactLifecycleState;
  reason: ContactEndReason;
  storyTime: AffordanceStoryTime;
  eventRef: ContactEventRef;
}): { state: ContactLifecycleState; commits: readonly ContactEndedCommit[] } {
  const commits = request.state.contacts.map((contact) =>
    endedCommit(contact, { storyTime: request.storyTime, eventRef: request.eventRef, reason: request.reason }),
  );
  return { state: emptyContactLifecycleState(), commits };
}

// ---------------------------------------------------------------------------
// Authorization, re-checked while a contact is live
// ---------------------------------------------------------------------------

/**
 * The lane's CURRENT answer about one active contact's authorization.
 *
 * The resolver gates every new assertion, but an active contact is not
 * re-resolved on a turn nobody touched it — so a permission that lapses while a
 * hand is resting somewhere would otherwise keep a contact alive on the strength
 * of a grant that no longer exists. This read is how the lane says what is true
 * now; `endUnauthorizedContacts` is what makes the projection agree with it.
 */
export interface ContactAuthorizationRead {
  readonly contactId: ContactId;
  readonly participantEligibility: ContactParticipantEligibilityRead;
  readonly policy: ContactInteractionPolicyRead;
}

export interface ContactAuthorizationSweepRequest {
  readonly state: ContactLifecycleState;
  /** One read per active contact that needs authorization. A missing one fails closed. */
  readonly authorizations: readonly ContactAuthorizationRead[];
  readonly storyTime: AffordanceStoryTime;
  readonly eventRef: ContactEventRef;
  readonly sink?: DiagnosticSink;
}

/**
 * Why this contact may no longer exist, or `undefined` when it still may.
 *
 * `policy_withdrawn` is reserved for a permission owner that ANSWERED and said
 * no — denied, withdrawn, or no longer covering the action's scope. Everything
 * else that fails closed (nobody answered, eligibility lapsed or stopped
 * covering a participant) is `state_invalidated`: the contact is over either
 * way, and the two reasons keep "she withdrew it" distinguishable from "we could
 * not ask" in the durable record.
 */
function authorizationLapse(
  contact: CommittedContactRead,
  read: ContactAuthorizationRead | undefined,
): ContactEndReason | undefined {
  if (!isInterpersonalContact(contact.source, contact.target)) return undefined;
  const needsPermission = contactActionRequiresPermission(contact.actionKind);
  const needsEligibility = contactActionRequiresAdultEligibility(contact.actionKind);
  if (!needsPermission && !needsEligibility) return undefined;
  if (read === undefined) return "state_invalidated";

  if (needsPermission) {
    if (read.policy.status === "denied" || read.policy.status === "withdrawn") return "policy_withdrawn";
    if (read.policy.status !== "allowed") return "state_invalidated";
    if (!read.policy.scopes.includes(CONTACT_ACTION_SCOPE[contact.actionKind])) return "policy_withdrawn";
  }

  if (needsEligibility) {
    const participants = contactParticipantIds(contact.source, contact.target);
    const covered = participants.every((id) => read.participantEligibility.participantIds.includes(id));
    if (read.participantEligibility.status !== "eligible" || !covered) return "state_invalidated";
  }
  return undefined;
}

/**
 * End every active contact whose authorization no longer holds.
 *
 * The owner's ruling, in one function: withdrawal of an applicable permission
 * must END or BLOCK the affected contact. `resolveContactAttempt` is the BLOCK
 * half — a withdrawn grant never produces a committable resolution — and this is
 * the END half, for contacts that are already live. Contacts whose kind needs
 * neither permission nor eligibility (incidental, casual, affectionate touch;
 * self-contact; contact with an object) are untouched, exactly as the resolver
 * never demanded a grant for them in the first place.
 */
export function endUnauthorizedContacts(request: ContactAuthorizationSweepRequest): {
  state: ContactLifecycleState;
  commits: readonly ContactEndedCommit[];
} {
  const commits: ContactEndedCommit[] = [];
  const kept: CommittedContactRead[] = [];
  for (const contact of request.state.contacts) {
    const read = request.authorizations.find((entry) => entry.contactId === contact.contactId);
    const reason = authorizationLapse(contact, read);
    if (reason === undefined) {
      kept.push(contact);
      continue;
    }
    request.sink?.push(
      diag("warn", CONTACT_AUTHORIZATION_LAPSED, "an active contact lost its authorization and was ended", {
        context: { contactId: contact.contactId, reason },
      }),
    );
    commits.push(endedCommit(contact, { storyTime: request.storyTime, eventRef: request.eventRef, reason }));
  }
  return { state: withContacts(kept), commits };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Fold one durable commit into a projection.
 *
 * Reads only what a store would actually keep: the ids, the event ref, the story
 * time, and the snapshot. The `contact` that rides along on the start and update
 * cases is deliberately IGNORED on update — if the fold trusted it, a lane that
 * persisted only the durable fields would replay differently from one that kept
 * the whole read, and the difference would only ever show up after a branch.
 *
 * Every refusal below is a stream that contradicts itself. The projection is
 * left alone and the contradiction is reported, because guessing which of two
 * conflicting records is right is exactly how a contact nobody committed becomes
 * current truth.
 */
export function applyContactCommit(
  state: ContactLifecycleState,
  commit: ContactLifecycleCommit,
  sink?: DiagnosticSink,
): ContactLifecycleState {
  switch (commit.kind) {
    case "contact_started": {
      const contact = commit.contact;
      if (activeContactForPair(state, contact.pairKey) !== undefined) {
        sink?.push(
          diag("error", CONTACT_LIFECYCLE_INVALID, "replayed a start for a surface pair that is already occupied", {
            context: { contactId: contact.contactId },
          }),
        );
        return state;
      }
      if (state.contacts.length >= CONTACT_LIFECYCLE_MAX_ACTIVE) {
        sink?.push(
          diag("error", CONTACT_LIFECYCLE_INVALID, "replayed a start past the projection bound", {
            context: { contactId: contact.contactId },
          }),
        );
        return state;
      }
      return withContacts([...state.contacts, deepFreeze(contact)]);
    }
    case "contact_updated": {
      const existing = activeContact(state, commit.contactId);
      if (existing === undefined) {
        sink?.push(
          diag("error", CONTACT_LIFECYCLE_INVALID, "replayed an update for a contact that is not active", {
            context: { contactId: commit.contactId },
          }),
        );
        return state;
      }
      const contact = deepFreeze(
        withSnapshot(existing, commit.snapshot, { eventRef: commit.eventRef, storyTime: commit.storyTime }),
      );
      return withContacts(state.contacts.map((entry) => (entry.contactId === commit.contactId ? contact : entry)));
    }
    case "contact_continued":
      return state;
    case "contact_ended": {
      if (activeContact(state, commit.contactId) === undefined) {
        sink?.push(
          diag("warn", CONTACT_LIFECYCLE_INVALID, "replayed an end for a contact that is not active", {
            context: { contactId: commit.contactId },
          }),
        );
        return state;
      }
      return withContacts(state.contacts.filter((entry) => entry.contactId !== commit.contactId));
    }
  }
}

/**
 * Fold a whole commit stream back into a projection.
 *
 * This is the branch/retake path: the durable events are the truth, and the
 * projection is only a cache of them. A stream replayed onto the state it was
 * produced from must reproduce that state exactly — which is what makes storing
 * the projection beside the events safe rather than a second source of truth.
 */
export function replayContactCommits(request: {
  commits: readonly ContactLifecycleCommit[];
  state?: ContactLifecycleState;
  sink?: DiagnosticSink;
}): ContactLifecycleState {
  let state = request.state ?? emptyContactLifecycleState();
  for (const commit of request.commits) state = applyContactCommit(state, commit, request.sink);
  return state;
}

/**
 * Recompose the transmission read from a contact's stored layers.
 *
 * Stored state carries both the layers and the composed answer, and a blob that
 * survived a schema change could carry a stale composition. `state.ts` recomposes
 * on every read for exactly that reason; callers holding a contact from anywhere
 * else can use this to check the two agree.
 */
export function recomposeContactTransmission(contact: CommittedContactRead): ContactMaterialTransmissionRead {
  return composeContactMaterial(contact.materialBetween);
}

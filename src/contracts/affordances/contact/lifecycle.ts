import { diag, type DiagnosticSink } from "../../diagnostics";
import { deepFreeze, mergeAffordanceEvidence, type AffordanceStoryTime } from "../core";
import { CONTACT_AUTHORIZATION_LAPSED, CONTACT_LIFECYCLE_INVALID } from "./diagnostics";
import {
  CONTACT_ACTION_SCOPE,
  contactActionRequiresPermission,
  type ContactInteractionPolicyRead,
} from "./decisions";
import { contactPairKey, isInterpersonalContact } from "./surfaces";
import { deriveContactId, type ContactEventRef, type ContactId } from "./identity";
import {
  composeContactMaterial,
  sortContactMaterialLayers,
  type ContactMaterialLayerRead,
  type ContactMaterialTransmissionRead,
} from "./material";
import type {
  CommittableContactResolution,
  CommittedContactMotionRead,
  CommittedContactRead,
  CommittedContactSnapshot,
  ContactContinuedCommit,
  ContactEndReason,
  ContactEndedCommit,
  ContactLifecycleCommit,
  ContactMotionIntent,
  ContactPressureBand,
  ContactUpdatedCommit,
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
 * `modulateContactGesture` is a FIFTH entry point and deliberately not a fifth
 * transition: it reaches the update and continue cases above by contact id,
 * carrying nothing but a pressure and a motion. It exists because an actor whose
 * gesture changed under a hand that never moved has no new attempt to resolve —
 * re-resolving one would re-read geometry, support, material, and permission at
 * a later cut and could silently rewrite what the touch lands through, or end
 * the contact outright. See its own comment for the full argument.
 *
 * ## Three laws this file is built around
 *
 * 1. **Start identity is immutable.** `contactId`, `pairKey`, `startedAt`,
 *    `startedByEventRef`, `actorId`, `actionKind`, `source`, `target`, and the
 *    three authorization records belong to the contact that BEGAN. The pair key is
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
 * 4. **No contact ends before its own last update.** Law 3 protects the pair
 *    being asserted; it protects nothing else, and every end path in this file
 *    could reach a contact the assertion never mentioned. An end stamped earlier
 *    than the contact's `lastUpdatedAt` writes a record whose `endedAt` precedes
 *    facts already committed about that contact, so replay sees a contact that
 *    ended before it was last touched. Every end therefore checks the contact it
 *    is about to end: `endContact` no-ops, `endAllContacts` and the
 *    authorization sweep leave the newer contact ALIVE, and capacity refuses the
 *    new start outright rather than evicting a victim it cannot end honestly.
 *
 * A refusal is a first-class outcome (`ContactCommitOutcome.status`), not a
 * silent no-op: the caller has to narrow before it can reach a `contact`, so
 * "we could not make room" is structurally incapable of being read as a contact
 * that started.
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
  | "targetAgencies"
  | "policy"
>;

/** Which event, at which story minute, is asserting the contact right now. */
interface ContactStamp {
  readonly eventRef: ContactEventRef;
  readonly storyTime: AffordanceStoryTime;
}

/**
 * One asserted motion as the projection stores it, or `null` for a motion nobody
 * stated. The path tokens are COPIED: the intent's array belongs to its caller,
 * and the committed read is frozen.
 *
 * `evidence` is empty rather than inherited because motion evidence is the
 * ATTEMPT's provenance and the snapshot's own `evidence` already carries the
 * resolution's — duplicating it here would grow the stored blob by a copy of
 * something it is standing next to.
 */
function motionSnapshot(intent: ContactMotionIntent | null): CommittedContactMotionRead | null {
  if (intent === null) return null;
  return {
    band: intent.band,
    ...(intent.pathDetailIds === undefined ? {} : { pathDetailIds: [...intent.pathDetailIds] }),
    evidence: [],
  };
}

/** The mutable half, as one resolution asserts it. */
function snapshotFromResolution(resolution: CommittableContactResolution): CommittedContactSnapshot {
  const { intent, access } = resolution;
  return {
    pressure: intent.requestedPressure ?? null,
    contactArea: intent.requestedArea ?? null,
    motion: motionSnapshot(intent.requestedMotion ?? null),
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
    targetAgencies: identity.targetAgencies,
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
    targetAgencies: input.resolution.targetAgencies,
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

/**
 * Why a commit could not happen at all. A vocabulary rather than a single
 * literal: the capacity case is the only producer today, but "the fold could not
 * proceed" is the shape a future refusal would also take, and a boolean would
 * have to be replaced rather than extended.
 */
export const contactCommitRefusalReasons = ["capacity_blocked_by_newer_contact"] as const;
export type ContactCommitRefusalReason = (typeof contactCommitRefusalReasons)[number];

/**
 * What the fold did with a committable resolution.
 *
 * A **union**, not a record with an optional contact, and the discriminant is
 * load-bearing: a refusal has no `commit` and no `contact` at all, so a caller
 * cannot read a started contact off one by forgetting to check. That is the same
 * device `ContactResolution` uses to stop an attempt masquerading as a
 * commitment, applied one stage later — the stage where "we could not make room"
 * would otherwise be indistinguishable from "it started".
 */
export type ContactCommitOutcome =
  | {
      readonly status: "committed";
      readonly state: ContactLifecycleState;
      readonly commit: ContactLifecycleCommit;
      readonly contact: CommittedContactRead;
      /**
       * Contacts this same lane event ENDED to make room for the one above —
       * capacity pressure, or a framing change on the same pair.
       *
       * Ordinarily empty. Never a projection-only drop: these are durable
       * commits, and `contactCommitEvents` puts them ahead of `commit` in the
       * stream so a replay frees the pair before the new contact claims it.
       */
      readonly ended: readonly ContactEndedCommit[];
    }
  | {
      readonly status: "refused";
      readonly reason: ContactCommitRefusalReason;
      /** Returned unchanged. A refusal writes nothing and ends nothing. */
      readonly state: ContactLifecycleState;
      /** The active contacts whose own newer facts stood in the way. */
      readonly blockedBy: readonly ContactId[];
    };

/** The branch that produced a contact. */
export type CommittedContactOutcome = Extract<ContactCommitOutcome, { status: "committed" }>;

export function isCommittedContactOutcome(
  outcome: ContactCommitOutcome,
): outcome is CommittedContactOutcome {
  return outcome.status === "committed";
}

/**
 * Every durable commit an outcome produced, in the order a fold must apply them.
 *
 * Empty for a refusal — the whole point of refusing is that nothing was written,
 * so a lane that persists `contactCommitEvents(outcome)` unconditionally stays
 * correct without learning the union.
 */
export function contactCommitEvents(outcome: ContactCommitOutcome): readonly ContactLifecycleCommit[] {
  return outcome.status === "committed" ? [...outcome.ended, outcome.commit] : [];
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

/**
 * The no-write commit: this contact is still exactly what it was.
 *
 * Built in one place because THREE callers produce it — an unchanged assertion,
 * a stale one, and an unchanged gesture modulation — and a `contact_continued`
 * that carried a different story time or a rebuilt contact from one of them
 * would replay identically (the fold ignores it) while reading differently in
 * the ledger, which is the worst kind of divergence to debug.
 */
function continuedCommit(
  contact: CommittedContactRead,
  storyTime: AffordanceStoryTime,
): ContactContinuedCommit {
  return { kind: "contact_continued", contactId: contact.contactId, storyTime, contact };
}

function continued(
  state: ContactLifecycleState,
  contact: CommittedContactRead,
  storyTime: AffordanceStoryTime,
): ContactCommitOutcome {
  return { status: "committed", state, commit: continuedCommit(contact, storyTime), contact, ended: [] };
}

/**
 * Would ending this contact now write a record older than the contact itself?
 *
 * `endedAt < lastUpdatedAt` is a durable claim that a contact stopped before the
 * last thing known about it happened. Equality is fine — ending a contact at the
 * exact minute of its last update is an ordinary same-turn release.
 *
 * Reports as it answers, because every caller does the same thing with a `true`:
 * leave the contact alone and say why. Shared so the three end paths cannot
 * drift into three different rules.
 */
function staleEnd(
  contact: CommittedContactRead,
  storyTime: AffordanceStoryTime,
  sink?: DiagnosticSink,
): boolean {
  if (storyTime >= contact.lastUpdatedAt) return false;
  sink?.push(
    diag("warn", CONTACT_LIFECYCLE_INVALID, "an end older than the contact it names was not applied", {
      context: { contactId: contact.contactId, asserted: storyTime, lastUpdatedAt: contact.lastUpdatedAt },
    }),
  );
  return true;
}

/**
 * Is this assertion older than the contact it lands on?
 *
 * Reports as it answers, like `staleEnd` beside it, because every caller does
 * the same thing with a `true`: leave the projection exactly as it is and
 * CONTINUE the contact. `about` carries whatever identifies the assertion to a
 * reader (its action kind, or the operation that made it) so one shared law can
 * still file a diagnostic that names its own caller.
 */
function staleAgainstProjection(
  existing: CommittedContactRead,
  storyTime: AffordanceStoryTime,
  about: Record<string, unknown>,
  sink?: DiagnosticSink,
): boolean {
  if (storyTime >= existing.lastUpdatedAt) return false;
  sink?.push(
    diag("warn", CONTACT_LIFECYCLE_INVALID, "a contact assertion older than the projection was not applied", {
      context: {
        contactId: existing.contactId,
        asserted: storyTime,
        lastUpdatedAt: existing.lastUpdatedAt,
        ...about,
      },
    }),
  );
  return true;
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
  const assertedKind = request.resolution.intent.actionKind;
  return staleAgainstProjection(existing, stamp.storyTime, { assertedKind }, request.sink)
    ? continued(request.state, existing, stamp.storyTime)
    : undefined;
}

/**
 * Lay a new snapshot over a live contact: the replaced projection, the durable
 * commit, and the frozen read, in one step.
 *
 * The ONE place an update is constructed. Both producers — a full resolution
 * asserting the same pair, and a gesture-only modulation naming the contact by
 * id — go through it, so "an update keeps the whole start identity" is enforced
 * by `withSnapshot` once instead of by two call sites that happen to agree.
 */
function updatedInPlace(
  state: ContactLifecycleState,
  existing: CommittedContactRead,
  snapshot: CommittedContactSnapshot,
  stamp: ContactStamp,
): {
  readonly state: ContactLifecycleState;
  readonly commit: ContactUpdatedCommit;
  readonly contact: CommittedContactRead;
} {
  const contact = deepFreeze(withSnapshot(existing, snapshot, stamp));
  return {
    state: withContacts(state.contacts.map((entry) => (entry.contactId === existing.contactId ? contact : entry))),
    commit: {
      kind: "contact_updated",
      contactId: contact.contactId,
      eventRef: stamp.eventRef,
      snapshot,
      storyTime: stamp.storyTime,
      contact,
    },
    contact,
  };
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
  return { status: "committed", ...updatedInPlace(request.state, existing, snapshot, stamp), ended: [] };
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
  let remaining =
    existing === undefined
      ? request.state.contacts
      : request.state.contacts.filter((entry) => entry.contactId !== existing.contactId);

  // Capacity is decided BEFORE anything is ended or reported, so a refusal never
  // has to unwind a framing end it already announced.
  //
  // The victims are unrelated pairs — law 3 guarded the pair being asserted and
  // says nothing about them — so an assertion that is perfectly current for its
  // own contact can still be older than the contact eviction would destroy.
  // Ending that one here would stamp `endedAt` before its `lastUpdatedAt`, and
  // the alternative (ending it at its own later time) invents a story minute
  // nobody asserted. Refusing the new contact is the only option that neither
  // rewrites time nor drops a contact without an event: the projection is
  // already full of newer facts, and a start is the thing a caller can retry.
  const evicted = overCapacity(remaining);
  const blockedBy = evicted.filter((contact) => contact.lastUpdatedAt > stamp.storyTime);
  if (blockedBy.length > 0) {
    request.sink?.push(
      diag(
        "warn",
        CONTACT_LIFECYCLE_INVALID,
        "the projection is full of contacts newer than this assertion; no contact was started",
        { context: { asserted: stamp.storyTime, blockedBy: blockedBy.map((contact) => contact.contactId) } },
      ),
    );
    return {
      status: "refused",
      reason: "capacity_blocked_by_newer_contact",
      state: request.state,
      blockedBy: blockedBy.map((contact) => contact.contactId),
    };
  }

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
  }

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
    status: "committed",
    state: withContacts([...remaining, contact]),
    commit: { kind: "contact_started", contact },
    contact,
    ended,
  };
}

// ---------------------------------------------------------------------------
// Gesture-only modulation
// ---------------------------------------------------------------------------

export interface ContactGestureModulationRequest {
  readonly state: ContactLifecycleState;
  /** The DURABLE id. A modulation never searches by pair, and never by orientation. */
  readonly contactId: ContactId;
  /**
   * The gesture's pressure and motion, stated IN FULL — `null` is "this gesture
   * states none", not "leave whatever was there".
   *
   * Nullable rather than optional for the same reason `CommittedContactSnapshot`
   * is: a partial patch cannot express removal, so a hand that went from tapping
   * to simply resting would keep a `tapping` band nobody is asserting any more.
   */
  readonly pressure: ContactPressureBand | null;
  readonly motion: ContactMotionIntent | null;
  readonly eventRef: ContactEventRef;
  readonly storyTime: AffordanceStoryTime;
  readonly sink?: DiagnosticSink;
}

/** Why a modulation wrote nothing while the contact went on existing. */
export const contactGestureContinuedReasons = ["gesture_unchanged", "stale_assertion"] as const;
export type ContactGestureContinuedReason = (typeof contactGestureContinuedReasons)[number];

/**
 * What a gesture-only modulation did. THREE cases, and the discriminant carries
 * the difference a caller has to act on:
 *
 * - `committed` — the gesture changed, and there is a durable `contact_updated`
 *   commit plus the new read;
 * - `continued` — the contact is untouched, on purpose, and `reason` says which
 *   law was quiet (nothing changed, or the assertion was older than the
 *   projection). The state is returned by REFERENCE, unchanged;
 * - `absent` — nothing active carries that id. Not an error value the caller can
 *   accidentally read a contact off: there is no `contact` field at all, which
 *   is the same device the commit union uses for a refusal.
 *
 * There is no `refused` and no `ended`. Capacity, eviction, and the
 * framing-change door belong to `commitContactResolution`; a modulation cannot
 * reach any of them, because the contact it names is already in the projection
 * and stays there.
 */
export type ContactGestureModulationOutcome =
  | {
      readonly status: "committed";
      readonly state: ContactLifecycleState;
      readonly commit: ContactUpdatedCommit;
      readonly contact: CommittedContactRead;
    }
  | {
      readonly status: "continued";
      /** Returned unchanged, by reference — a continue writes nothing. */
      readonly state: ContactLifecycleState;
      readonly commit: ContactContinuedCommit;
      readonly contact: CommittedContactRead;
      readonly reason: ContactGestureContinuedReason;
    }
  | { readonly status: "absent"; readonly state: ContactLifecycleState };

/**
 * Change a live contact's GESTURE and nothing else
 * (romantic-contact-affordances.spec.actor-control.md §"Resolution laws →
 * Contact update": "add a gesture-only lifecycle operation … it must preserve
 * contact ID, actor, action kind, source, target, area, material-between,
 * transmission, implicit adjustments, and start authorization byte-for-byte.
 * Re-resolving a full contact attempt is forbidden for updates").
 *
 * ## Why an update may not go back through the resolver
 *
 * `commitContactResolution` takes a resolution, and a resolution is the answer
 * to a fresh ATTEMPT: geometry, support, material, control, eligibility, and
 * permission, all read at whatever cut the caller happens to hold. Routing "she
 * squeezes the hand she is already holding" through it would re-read every one
 * of those at a LATER cut and let any of them rewrite the contact — a garment
 * layer the post-settle wardrobe reports would replace the material the touch
 * actually landed through, and an intent whose action kind or surfaces drifted
 * by a character would end this contact and start another one with a new id and
 * a new cue history. None of that is what "her grip tightened" means.
 *
 * So the operation carries a pressure and a motion, and physically cannot carry
 * anything else. `withSnapshot` lays them over the contact's OWN identity and
 * its own untouched material, which is what makes byte-for-byte preservation a
 * property of the construction rather than of a list somebody maintains.
 *
 * ## The three quiet answers
 *
 * An unchanged gesture is `contact_continued` with no row (`contentKey` decides,
 * so "unchanged" means exactly what it means everywhere else in this file). An
 * assertion older than the contact is ABSORBED under law 3 — the same warn, the
 * same continue, `lastUpdatedAt` untouched. An id nothing active carries is
 * `absent` with an `error` diagnostic, because a caller that got here is
 * modulating something it never checked was there; the projection is left alone
 * either way.
 */
export function modulateContactGesture(
  request: ContactGestureModulationRequest,
): ContactGestureModulationOutcome {
  const existing = activeContact(request.state, request.contactId);
  if (existing === undefined) {
    request.sink?.push(
      diag("error", CONTACT_LIFECYCLE_INVALID, "gesture modulation named a contact that is not active", {
        context: { contactId: request.contactId },
      }),
    );
    return { status: "absent", state: request.state };
  }

  const quiet = (reason: ContactGestureContinuedReason): ContactGestureModulationOutcome => ({
    status: "continued",
    state: request.state,
    commit: continuedCommit(existing, request.storyTime),
    contact: existing,
    reason,
  });

  // Law 3 first, exactly as `commitContactResolution` checks it first: whether
  // the gesture differs says nothing about which of the two writes is later.
  if (staleAgainstProjection(existing, request.storyTime, { modulation: "gesture" }, request.sink)) {
    return quiet("stale_assertion");
  }

  // Everything except pressure and motion is carried over from the projection
  // itself — not rebuilt, not re-read.
  const held = snapshotOfContact(existing);
  const snapshot: CommittedContactSnapshot = {
    ...held,
    pressure: request.pressure,
    motion: motionSnapshot(request.motion),
  };
  if (contentKey(snapshot) === contentKey(held)) return quiet("gesture_unchanged");

  const stamp: ContactStamp = { eventRef: request.eventRef, storyTime: request.storyTime };
  return { status: "committed", ...updatedInPlace(request.state, existing, snapshot, stamp) };
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
  /**
   * `null` when nothing was active under that id, or when the end was older than
   * the contact it named — the state is returned unchanged either way.
   */
  readonly commit: ContactEndedCommit | null;
}

/**
 * End one contact.
 *
 * Ending something that is not active is a caller bug, not a story fact: it
 * files an `error` diagnostic and changes nothing, because silently succeeding
 * would let a double-end look identical to a real one on a branch replay.
 *
 * Ending something at a story time before its own last update is the other
 * caller bug — an out-of-order or replayed release — and it is absorbed rather
 * than applied (law 4). The contact stays active and the diagnostic is a `warn`:
 * a later end at a current story time is still perfectly able to close it.
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
  if (staleEnd(contact, request.storyTime, request.sink)) {
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
 *
 * **A scene exit asserted from the past does not empty the projection.** Law 4
 * applies per contact, so a contact whose `lastUpdatedAt` is newer than this
 * exit survives it, with a `warn`. The alternative rulings were both worse: a
 * whole-request refusal would throw away the ends of every contact this exit
 * legitimately covers, and ending the newer contact anyway would write
 * `endedAt` before facts already committed about it. What is left is honest —
 * the exit is an older write, the projection knows more than it does, and a
 * caller that really is leaving the scene re-issues at the current story time
 * (or ends the survivors by id) rather than having time rewritten for it.
 */
export function endAllContacts(request: {
  state: ContactLifecycleState;
  reason: ContactEndReason;
  storyTime: AffordanceStoryTime;
  eventRef: ContactEventRef;
  sink?: DiagnosticSink;
}): { state: ContactLifecycleState; commits: readonly ContactEndedCommit[] } {
  const commits: ContactEndedCommit[] = [];
  const kept: CommittedContactRead[] = [];
  for (const contact of request.state.contacts) {
    if (staleEnd(contact, request.storyTime, request.sink)) {
      kept.push(contact);
      continue;
    }
    commits.push(
      endedCommit(contact, { storyTime: request.storyTime, eventRef: request.eventRef, reason: request.reason }),
    );
  }
  return { state: withContacts(kept), commits };
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
 * else that fails closed (nobody answered at all, or the answer that came back
 * was unresolved) is `state_invalidated`: the contact is over either way, and
 * the two reasons keep "she withdrew it" distinguishable from "we could not ask"
 * in the durable record.
 */
function authorizationLapse(
  contact: CommittedContactRead,
  read: ContactAuthorizationRead | undefined,
): ContactEndReason | undefined {
  if (!isInterpersonalContact(contact.source, contact.target)) return undefined;
  if (!contactActionRequiresPermission(contact.actionKind)) return undefined;
  if (read === undefined) return "state_invalidated";

  // A player-target contact never depended on a standing grant. The basis and
  // named target must both match the stored contact; a bare or misdirected
  // `not_required` answer still fails closed.
  const playerTarget =
    read.policy.status === "not_required" &&
    read.policy.notRequiredBasis === "player_target" &&
    contact.target.kind === "body" &&
    read.policy.notRequiredTargetId === contact.target.subjectId;
  if (!playerTarget) {
    if (read.policy.status === "denied" || read.policy.status === "withdrawn") return "policy_withdrawn";
    if (read.policy.status !== "allowed") return "state_invalidated";
    if (!read.policy.scopes.includes(CONTACT_ACTION_SCOPE[contact.actionKind])) return "policy_withdrawn";
  }
  return undefined;
}

/**
 * End every active contact whose authorization no longer holds.
 *
 * The owner's ruling, in one function: withdrawal of an applicable permission
 * must END or BLOCK the affected contact. `resolveContactAttempt` is the BLOCK
 * half — a withdrawn grant never produces a committable resolution — and this is
 * the END half, for contacts that are already live. Contacts whose kind needs no
 * permission (incidental, casual, affectionate touch; self-contact; contact with
 * an object) are untouched, exactly as the resolver never demanded a grant for
 * them in the first place.
 *
 * **A sweep older than a contact leaves it alive** (law 4, same ruling as
 * `endAllContacts`). The sweep is a read of what is true NOW, so a sweep stamped
 * before a contact's own last update is an out-of-order write, and ending a
 * contact at a story minute before facts already committed about it would be a
 * worse outcome than carrying it to the next sweep — which will run at a current
 * time and end it then, because a lapsed authorization does not un-lapse.
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
    if (reason === undefined || staleEnd(contact, request.storyTime, request.sink)) {
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


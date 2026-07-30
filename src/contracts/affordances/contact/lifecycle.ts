import { diag, type DiagnosticSink } from "../../diagnostics";
import { deepFreeze, mergeAffordanceEvidence, type AffordanceStoryTime } from "../core";
import { CONTACT_LIFECYCLE_INVALID } from "./diagnostics";
import { contactPairKey } from "./surfaces";
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
 *   physical content differs. Keeps the id, patches the mutable fields, and
 *   stamps the new event and story time.
 * - **continue** — the same, when nothing differs. Returns the SAME state
 *   reference and no new event, so an unchanged held contact across ten
 *   exchanges is one start and nine no-ops rather than ten starts.
 * - **end** — removes the contact from the projection and hands back an
 *   `EndedContactRecord`, whose `phase: "ended"` makes it unusable as a current
 *   contact.
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
 * `layerId` is the wardrobe's own instance id and it survives the garment
 * changing underneath it: a sock soaking through keeps its id while its
 * permeability, moisture transmission, and shape transmission all move. An
 * id-only fingerprint took the CONTINUE path for exactly that case, so the
 * projection kept the dry snapshot and every observation downstream described a
 * material that no longer existed.
 *
 * Array position is NOT content. `sortContactMaterialLayers` is a total
 * canonical order (`order`, then `layerId`) and the `order` field itself is in
 * the fingerprint, so a layer that genuinely moved in the stack is a change
 * while an adapter that returned the same layers in a different array order is
 * not — otherwise a re-read of an unchanged cut would write an update event for
 * a presentation detail.
 *
 * Adjustments stay keyed by `id`: unlike a layer, an accepted adjustment is
 * minted by `classifyContactAdjustment` from one proposal and carries no
 * magnitude that could drift under a stable id.
 */
function contentKey(contact: {
  readonly pressure?: string;
  readonly contactArea?: string;
  readonly motion?: { band: string; pathDetailIds?: readonly string[] };
  readonly materialBetween: readonly ContactMaterialLayerRead[];
  readonly implicitAdjustments: readonly { id: string }[];
}): string {
  return JSON.stringify([
    contact.pressure ?? null,
    contact.contactArea ?? null,
    contact.motion === undefined ? null : [contact.motion.band, contact.motion.pathDetailIds ?? []],
    sortContactMaterialLayers(contact.materialBetween).map((layer) => materialFingerprint(layer)),
    contact.implicitAdjustments.map((adjustment) => adjustment.id),
  ]);
}

function committedFrom(input: {
  resolution: CommittableContactResolution;
  contactId: ContactId;
  pairKey: string;
  startedByEventRef: ContactEventRef;
  startedAt: AffordanceStoryTime;
  eventRef: ContactEventRef;
}): CommittedContactRead {
  const { intent, access } = input.resolution;
  return {
    phase: "active",
    contactId: input.contactId,
    pairKey: input.pairKey,
    startedByEventRef: input.startedByEventRef,
    lastUpdatedByEventRef: input.eventRef,
    startedAt: input.startedAt,
    lastUpdatedAt: intent.storyTime,
    actorId: intent.actorId,
    actionKind: intent.actionKind,
    source: intent.source,
    target: intent.target,
    ...(intent.requestedPressure === undefined ? {} : { pressure: intent.requestedPressure }),
    ...(intent.requestedArea === undefined ? {} : { contactArea: intent.requestedArea }),
    ...(intent.requestedMotion === undefined
      ? {}
      : {
          motion: {
            band: intent.requestedMotion.band,
            ...(intent.requestedMotion.pathDetailIds === undefined
              ? {}
              : { pathDetailIds: [...intent.requestedMotion.pathDetailIds] }),
            evidence: [],
          },
        }),
    materialBetween: access.materialBetween,
    transmission: access.transmission,
    implicitAdjustments: access.implicitAdjustments,
    actorControl: input.resolution.actorControl,
    participantEligibility: input.resolution.participantEligibility,
    policy: input.resolution.policy,
    evidence: mergeAffordanceEvidence(input.resolution.evidence),
  };
}

/**
 * Make room for a new contact when the projection is at capacity.
 *
 * The oldest-started contact loses, and the eviction is REPORTED. A silent drop
 * would look exactly like a contact that ended, and a scene with more than
 * sixteen simultaneous live contacts is an adapter that has stopped ending
 * them — a bug worth a diagnostic rather than a quiet trim.
 */
function evictForCapacity(
  contacts: readonly CommittedContactRead[],
  sink?: DiagnosticSink,
): readonly CommittedContactRead[] {
  if (contacts.length < CONTACT_LIFECYCLE_MAX_ACTIVE) return contacts;
  const ordered = [...contacts].sort((left, right) =>
    left.startedAt === right.startedAt ? left.pairKey.localeCompare(right.pairKey) : left.startedAt - right.startedAt,
  );
  const evicted = ordered.slice(0, contacts.length - CONTACT_LIFECYCLE_MAX_ACTIVE + 1);
  sink?.push(
    diag("warn", CONTACT_LIFECYCLE_INVALID, "active contact projection is at capacity; evicting the oldest", {
      context: { evicted: evicted.map((contact) => contact.contactId) },
    }),
  );
  return ordered.slice(evicted.length);
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
  const { intent, access } = request.resolution;
  const pairKey = contactPairKey(intent.source, intent.target);
  const existing = activeContactForPair(request.state, pairKey);

  if (existing === undefined) {
    const contact = deepFreeze(
      committedFrom({
        resolution: request.resolution,
        contactId: deriveContactId({ pairKey, startedByEventRef: request.eventRef }),
        pairKey,
        startedByEventRef: request.eventRef,
        startedAt: intent.storyTime,
        eventRef: request.eventRef,
      }),
    );
    const contacts = [...evictForCapacity(request.state.contacts, request.sink), contact];
    return { state: withContacts(contacts), commit: { kind: "contact_started", contact }, contact };
  }

  const proposed = {
    pressure: intent.requestedPressure,
    contactArea: intent.requestedArea,
    motion: intent.requestedMotion,
    materialBetween: access.materialBetween,
    implicitAdjustments: access.implicitAdjustments,
  };
  if (contentKey(proposed) === contentKey(existing)) {
    return {
      state: request.state,
      commit: { kind: "contact_continued", contactId: existing.contactId, storyTime: intent.storyTime, contact: existing },
      contact: existing,
    };
  }

  const contact = deepFreeze(
    committedFrom({
      resolution: request.resolution,
      contactId: existing.contactId,
      pairKey,
      startedByEventRef: existing.startedByEventRef,
      startedAt: existing.startedAt,
      eventRef: request.eventRef,
    }),
  );
  const patch = {
    ...(contact.pressure === undefined ? {} : { pressure: contact.pressure }),
    ...(contact.contactArea === undefined ? {} : { contactArea: contact.contactArea }),
    ...(contact.motion === undefined ? {} : { motion: contact.motion }),
    materialBetween: contact.materialBetween,
    implicitAdjustments: contact.implicitAdjustments,
  };
  const contacts = request.state.contacts.map((entry) => (entry.pairKey === pairKey ? contact : entry));
  return {
    state: withContacts(contacts),
    commit: {
      kind: "contact_updated",
      contactId: contact.contactId,
      eventRef: request.eventRef,
      patch,
      storyTime: intent.storyTime,
      contact,
    },
    contact,
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
  const ended = deepFreeze(
    endedFrom(contact, { storyTime: request.storyTime, eventRef: request.eventRef, reason: request.reason }),
  );
  return {
    state: withContacts(request.state.contacts.filter((entry) => entry.contactId !== request.contactId)),
    commit: {
      kind: "contact_ended",
      contactId: request.contactId,
      eventRef: request.eventRef,
      reason: request.reason,
      storyTime: request.storyTime,
      contact: ended,
    },
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
  const commits = request.state.contacts.map((contact) => ({
    kind: "contact_ended" as const,
    contactId: contact.contactId,
    eventRef: request.eventRef,
    reason: request.reason,
    storyTime: request.storyTime,
    contact: deepFreeze(
      endedFrom(contact, { storyTime: request.storyTime, eventRef: request.eventRef, reason: request.reason }),
    ),
  }));
  return { state: emptyContactLifecycleState(), commits };
}

/**
 * Recompose the transmission read from a contact's stored layers.
 *
 * Stored state carries both the layers and the composed answer, and a blob that
 * survived a schema change could carry a stale composition. Callers that need to
 * be certain recompose; the two agree for any state this release wrote.
 */
export function recomposeContactTransmission(contact: CommittedContactRead): ContactMaterialTransmissionRead {
  return composeContactMaterial(contact.materialBetween);
}

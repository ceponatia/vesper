import {
  CHAT_CONTACT_SOURCE_LOCATION,
  affordanceEvidence,
  contactParticipantIds,
  endAllContacts,
  endContact,
  sceneFact,
  sceneParticipant,
  sceneProvenance,
  sceneSupportId,
  sceneSupportSurface,
  type AffordanceStoryTime,
  type AffordanceSubjectId,
  type CommittedContactRead,
  type ContactEndReason,
  type ContactEndedCommit,
  type ContactEventRef,
  type DiagnosticSink,
  type SceneEventRef,
  type SceneState,
  type SceneSupportRelation,
  withSceneContacts,
  withSceneParticipant,
  withSceneSupportSurface,
  withoutAllScenePairRelations,
  withoutScenePairRelations,
} from "@/contracts";
import { CHAT_CONTACT_PLAYER_SUBJECT } from "./identity";
import type { ChatContactRelease } from "./touch";
import type { ChatDeparture } from "./movement";

/** The scene's floor. One ground surface per conversation; seeded once. */
export const CHAT_SCENE_GROUND_SUPPORT = sceneSupportId("ground");

// ---------------------------------------------------------------------------
// Scene seeding
// ---------------------------------------------------------------------------

export interface ChatSceneSeedInput {
  readonly player: AffordanceSubjectId;
  /** PRESENT roster members only — an away character is not in the room. */
  readonly characters: readonly AffordanceSubjectId[];
  readonly ref: SceneEventRef;
  readonly storyTime: AffordanceStoryTime;
}

/** Standing on the floor, weight through the legs — the seeded default posture's support. */
function groundSupport(): readonly SceneSupportRelation[] {
  return [{ role: "borne_by", anchor: { kind: "surface", supportId: CHAT_SCENE_GROUND_SUPPORT }, loadZones: ["legs"] }];
}

/**
 * Ensure every body in the room is placed, without ever overwriting a fact.
 *
 * Three seeds, and each one's provenance says exactly how much authority it has:
 *
 * - **control** is `authored`, because it is not a default at all. A chat has one
 *   player and a roster of characters, and which is which is structural truth
 *   about the conversation — the same truth the transcript, the state rows, and
 *   the prompt already rest on.
 * - **posture** and **support** are `scene_default`: a stated default, the
 *   weaker label. Standing on the floor is what a conversation assumes when
 *   nobody has said otherwise, and the vocabulary keeps it distinguishable from
 *   a placement somebody actually authored.
 * - **proximity and facing are NEVER seeded.** How far apart two people are is a
 *   physical claim with consequences, and this module has no source for it. A
 *   scene where nobody has moved answers `proximity_unknown` and every attempt
 *   through it resolves `unresolved` — silence, not a guessed arm's length.
 *
 * Posture and support are seeded only for a body the scene does not yet contain.
 * A participant who is already here and has since lost a posture is not a new
 * arrival, and re-standing them would overwrite whatever ended it.
 */
export function seededChatScene(existing: SceneState, roster: ChatSceneSeedInput): SceneState {
  const authored = sceneProvenance({
    source: "authored",
    ref: roster.ref,
    storyTime: roster.storyTime,
    evidence: [affordanceEvidence("adapter", "chat.contact.roster")],
  });
  const stated = sceneProvenance({
    source: "scene_default",
    ref: roster.ref,
    storyTime: roster.storyTime,
    evidence: [affordanceEvidence("adapter", "chat.contact.scene_default")],
  });
  const controlOf = (subjectId: AffordanceSubjectId): "player_controlled" | "npc_controlled" =>
    subjectId === roster.player ? "player_controlled" : "npc_controlled";

  let scene = existing;
  const arrivals: AffordanceSubjectId[] = [];
  for (const subjectId of [roster.player, ...roster.characters]) {
    const placed = sceneParticipant(scene, subjectId);
    if (placed === undefined) {
      arrivals.push(subjectId);
      continue;
    }
    // A placed body missing only its controller gets one — that is structure, not
    // a movement, and without it every intent about them resolves `unresolved`.
    if (placed.control !== undefined) continue;
    scene = withSceneParticipant(scene, { ...placed, control: sceneFact(controlOf(subjectId), authored) });
  }
  if (arrivals.length === 0) return scene;

  if (sceneSupportSurface(scene, CHAT_SCENE_GROUND_SUPPORT) === undefined) {
    scene = withSceneSupportSurface(scene, {
      supportId: CHAT_SCENE_GROUND_SUPPORT,
      kind: "ground",
      height: sceneFact("ground", stated),
    });
  }
  for (const subjectId of arrivals) {
    scene = withSceneParticipant(scene, {
      subjectId,
      control: sceneFact(controlOf(subjectId), authored),
      posture: sceneFact("standing", stated),
      support: sceneFact(groundSupport(), stated),
    });
  }
  return scene;
}

/** Is this active contact one the player's own hand is making? */
function playerHandContact(contact: CommittedContactRead): boolean {
  return (
    contact.source.subjectId === CHAT_CONTACT_PLAYER_SUBJECT &&
    contact.source.locationId === CHAT_CONTACT_SOURCE_LOCATION
  );
}

/** Is the player's own body one END of this contact — either end, either surface? */
function playerInvolvedContact(contact: CommittedContactRead): boolean {
  return contactParticipantIds(contact.source, contact.target).includes(CHAT_CONTACT_PLAYER_SUBJECT);
}

export interface ChatContactEnds {
  readonly scene: SceneState;
  readonly commits: readonly ContactEndedCommit[];
}

/**
 * End every active contact a predicate covers — the shared body of both of the
 * player's own ends, and of the reply-side NPC ending (`chat-contact-reply.ts`).
 *
 * Per contact through the core's `endContact`, so each end is its own durable
 * commit and law 4 is enforced per contact (an end older than the contact it
 * names is absorbed with a `warn` and that contact survives). The contacts are
 * filtered to the ones the end actually covers BEFORE any end is requested, so
 * an end with nothing under it produces zero commits and zero diagnostics — "I
 * let go" on an empty scene, or a step back from an untouched room, is an
 * ordinary sentence rather than a caller bug.
 */
export function endCoveredContacts(input: {
  readonly scene: SceneState;
  readonly covers: (contact: CommittedContactRead) => boolean;
  readonly reason: ContactEndReason;
  readonly eventRef: ContactEventRef;
  readonly storyTime: AffordanceStoryTime;
  readonly sink?: DiagnosticSink;
}): ChatContactEnds {
  const covered = input.scene.contacts.contacts.filter(input.covers);
  let state = input.scene.contacts;
  const commits: ContactEndedCommit[] = [];
  for (const contact of covered) {
    const outcome = endContact({
      state,
      contactId: contact.contactId,
      reason: input.reason,
      storyTime: input.storyTime,
      eventRef: input.eventRef,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    });
    state = outcome.state;
    if (outcome.commit !== null) commits.push(outcome.commit);
  }
  return { scene: state === input.scene.contacts ? input.scene : withSceneContacts(input.scene, state), commits };
}

/**
 * Apply a release to the scene's contacts, reason `withdrawn`.
 *
 * Only the player's own `hands` are ever released: it is the only source this
 * lane produces, and a release is a claim about the player's body alone.
 */
export function applyChatContactRelease(input: {
  readonly scene: SceneState;
  readonly release: ChatContactRelease;
  readonly eventRef: ContactEventRef;
  readonly storyTime: AffordanceStoryTime;
  readonly sink?: DiagnosticSink;
}): ChatContactEnds {
  const { release } = input;
  return endCoveredContacts({
    scene: input.scene,
    reason: "withdrawn",
    eventRef: input.eventRef,
    storyTime: input.storyTime,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
    covers: (contact) =>
      playerHandContact(contact) &&
      (release.targetSubject === null ||
        (contact.target.kind === "body" && contact.target.subjectId === release.targetSubject)),
  });
}

/**
 * Apply a departure to the scene's contacts, reason `separated`.
 *
 * **Wider than a release, in the one way that matters.** A release is about the
 * player's own hand, so it covers the contacts that hand is making. A departure
 * is about the player's whole BODY leaving, so it covers every contact the
 * player is a participant in — EITHER end of it. A hand of hers resting on the
 * player's arm does not survive the player walking away from her any more than
 * the player's own hand on her shoulder does, and a projection that kept it
 * would be claiming a touch across a room nobody is standing in.
 *
 * `separated` rather than `withdrawn` for the same reason the story-clock skip
 * uses it: nobody took their hand back, the distance simply stopped allowing it.
 * An unnamed departure covers every player-involved contact there is.
 */
export function applyChatContactDeparture(input: {
  readonly scene: SceneState;
  readonly departure: ChatDeparture;
  readonly eventRef: ContactEventRef;
  readonly storyTime: AffordanceStoryTime;
  readonly sink?: DiagnosticSink;
}): ChatContactEnds {
  const { departure } = input;
  return endCoveredContacts({
    scene: input.scene,
    reason: "separated",
    eventRef: input.eventRef,
    storyTime: input.storyTime,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
    covers: (contact) =>
      playerInvolvedContact(contact) &&
      (departure.targetSubject === null ||
        contactParticipantIds(contact.source, contact.target).includes(departure.targetSubject)),
  });
}

/**
 * End every active contact in the scene — the hook the lane's own transitions use.
 *
 * Two callers, both outside the turn plan because both are things that happen TO
 * a conversation rather than things the player wrote: a story-clock skip ends
 * everything as `separated` (owner ruling, 2026-07-31 — an hour later, nobody's
 * hand is still where it was), and leaving the scene ends everything as
 * `scene_changed`. The core's law 4 still applies per contact, so a sweep
 * asserted from before a contact's last update leaves that contact alone with a
 * `warn` rather than writing a time-travelling end.
 */
export function endAllChatContacts(
  scene: SceneState,
  input: {
    readonly reason: ContactEndReason;
    readonly eventRef: ContactEventRef;
    readonly storyTime: AffordanceStoryTime;
    readonly sink?: DiagnosticSink;
  },
): ChatContactEnds {
  const { state, commits } = endAllContacts({
    state: scene.contacts,
    reason: input.reason,
    storyTime: input.storyTime,
    eventRef: input.eventRef,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  return { scene: commits.length === 0 ? scene : withSceneContacts(scene, state), commits };
}

/**
 * The scene discontinuities this exchange asserts — what stops the pair
 * relations from being about anything any more (owner ruling, 2026-08-04;
 * `withoutScenePairRelations`).
 *
 * Exactly three, and the ruling's own asymmetry decides the blast radius:
 *
 * - `wholeScene` — the place changed, or the story clock explicitly skipped.
 *   The whole chat moved or time jumped, so EVERY pair's distance is a claim
 *   about a room or a moment that is gone.
 * - `awaySubjects` — the members this cut says are offstage. Only the relations
 *   they are party to clear; the bodies still in the room did not move relative
 *   to each other because somebody else walked out.
 *
 * The ordinary per-turn clock tick is deliberately NOT a discontinuity. Minutes
 * passing inside one continuous scene is what a conversation IS, and treating
 * it as a break would erase the distance every turn and make the reach read
 * permanently unknown.
 */
export interface ChatSceneDiscontinuity {
  /** A place change or an explicit story-clock skip — clears every pair. */
  readonly wholeScene: boolean;
  /** Members this cut says are offstage — clears only their own relations. */
  readonly awaySubjects: readonly AffordanceSubjectId[];
}

/**
 * Apply this exchange's scene discontinuities to the projection.
 *
 * Pure, total, and idempotent: applying it twice changes nothing the first pass
 * did not, and a scene with nothing to clear comes back by reference. That
 * idempotence is what makes RE-ENTRY behave — a member who is still away next
 * exchange simply has nothing left to drop, and their distance stays unknown
 * until explicit movement states a new one.
 *
 * Contacts are NOT ended here. The two producers are deliberately separate:
 * `endAllChatContacts` already owns the skip/place-change ends under their own
 * event refs and ledger rows, and this is the state that has to move with them.
 */
export function chatSceneAfterDiscontinuity(
  scene: SceneState,
  input: ChatSceneDiscontinuity,
): SceneState {
  if (input.wholeScene) return withoutAllScenePairRelations(scene);
  let next = scene;
  for (const subjectId of input.awaySubjects) next = withoutScenePairRelations(next, subjectId);
  return next;
}
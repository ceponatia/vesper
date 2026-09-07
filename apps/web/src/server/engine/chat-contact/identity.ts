import {
  affordanceSubjectId,
  contactEventRef,
  type AffordanceSubjectId,
  type ChatContactGesture,
  type ChatRomanticContactGesture,
  type ContactEventRef,
} from "@/contracts";

/**
 * The player's subject id in this lane.
 *
 * The chat lane has exactly one player (`ChatPlayerState` is already chat-wide),
 * so one reserved handle is enough — the same argument, and the same literal,
 * that `GARMENT_PLAYER_ACTOR` uses for the wardrobe. Roster characters keep
 * their bare character id, which is what the guidance adapter already hands the
 * affordance layer, so a subject id means the same thing on both legs.
 */
export const CHAT_CONTACT_PLAYER_SUBJECT = affordanceSubjectId("player");

/**
 * The lane event ref for one exchange's contact writes.
 *
 * Derived from the exchange guard (`promptMessageId ?? assistantMessageId`), so
 * it is STABLE across a retry of the same exchange — the ledger's idempotency
 * key and the contact id both fall out of it — and DISTINCT per exchange, so two
 * different turns can never be mistaken for one write.
 */
export function chatContactEventRef(guardMessageId: string): ContactEventRef {
  return contactEventRef(`contact:${guardMessageId}`);
}

/**
 * One attempt's id: the exchange's event, WHO reached, and the surface they
 * reached for.
 *
 * The triple is what makes it unique WITHIN an exchange (a turn could in
 * principle detect a different act after a retake) while staying reproducible
 * ACROSS a retake of the same take, which is what `contactActionOutcomeStatus`
 * compares an acknowledgment against.
 *
 * The ACTOR is part of the key because one event ref no longer covers one
 * actor's acts. A reply-scene decision's event ref (`contact-reply:<message>`)
 * spans the whole roster, so two NPCs resting a hand on the same shoulder in
 * one reply would otherwise mint the identical action id — and an acknowledgment
 * for one would
 * verify the other's write. The contact ID itself is unaffected either way: it
 * is derived from the surface pair and the start event, never from this id.
 */
export function chatContactActionId(eventRef: ContactEventRef, act: ChatContactActShape): string {
  return `${eventRef}#${act.actorSubject}:${act.targetSubject}:${act.targetLocationId}`;
}

// ---------------------------------------------------------------------------
// Affectionate touch
// ---------------------------------------------------------------------------

/** The identity half of an act — everything `chatContactActionId` keys on. */
export interface ChatContactActShape {
  readonly actorSubject: AffordanceSubjectId;
  readonly targetSubject: AffordanceSubjectId;
  readonly targetLocationId: string;
}

/**
 * One affectionate act, on the ACTOR's own hand.
 *
 * Actor-generic by construction, and it always was: the player-line detector
 * fills `actorSubject` with the player, and the reply-scene leg's
 * `chatNpcContactAct` fills it with the NPC an admitted `start` candidate named.
 * Nothing downstream of this shape asks whose turn it is —
 * `resolveChatContactAttempt` reads the scene's own control fact for whichever
 * body is acting.
 */
export interface ChatContactAct extends ChatContactActShape {
  readonly actionId: string;
  readonly sourceLocationId: string;
  /**
   * The two kinds this lane has a PRODUCER for — never the core's full
   * `ContactActionKind`.
   *
   * A kind the core supports and the lane cannot author is exactly the gap that
   * makes the first romantic proof impossible: the permission owner became an
   * authoritative answer with no attempt to answer.
   * Naming only the producible kinds here keeps that gap a compile error rather
   * than a silent `unresolved` at runtime, so `incidental`, `casual` and
   * `intimate` cannot be smuggled in ahead of their producers and their owners.
   */
  readonly actionKind: "affectionate" | "romantic";
  readonly gesture: ChatContactActGesture;
}

/**
 * Every gesture either producer can author. The two families stay separate at
 * the vocabulary (see `chatRomanticContactGestures`) because the NPC classifier
 * closes over the affectionate one; they meet here, where the act is already
 * tagged with the kind that says which family produced it.
 */
export type ChatContactActGesture = ChatContactGesture | ChatRomanticContactGesture;
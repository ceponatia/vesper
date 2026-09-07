import {
  chatContactActionId,
  type ChatContactAct,
  type ChatContactActGesture,
  type ChatContactActShape,
} from "./identity";
import {
  CHAT_CONTACT_SOURCE_LOCATION,
  CHAT_GESTURE_CONTACT,
  CHAT_ROMANTIC_GESTURE_CONTACT,
  affordanceEvidence,
  contactActionRequiresPermission,
  resolveContactAttempt,
  sceneGeometryRead,
  sceneParticipant,
  sceneProvenanceEvidence,
  sceneSupportRead,
  type AdapterRead,
  type AffordanceEvidence,
  type AffordanceStoryTime,
  type AffordanceSubjectId,
  type ChatContactGesture,
  type ChatRomanticContactGesture,
  type ContactActionContext,
  type ContactActionIntent,
  type ContactActionKind,
  type ContactActorControlDecision,
  type ContactAreaBand,
  type ContactBodySurfaceRef,
  type ContactEventRef,
  type ContactInteractionPolicyRead,
  type ContactMaterialRead,
  type ContactMotionBand,
  type ContactPressureBand,
  type ContactResolution,
  type ContactSurfaceRef,
  type DiagnosticSink,
  type SceneState,
} from "@/contracts";

/** The contact bands a gesture from either family states. */
export function chatContactGestureBands(gesture: ChatContactActGesture): {
  readonly pressure: ContactPressureBand;
  readonly motion?: ContactMotionBand;
  readonly area?: ContactAreaBand;
} {
  // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so a gesture
  // named `__proto__` or `constructor` arriving from a future parsed payload
  // would select `Object.prototype` and yield an intent with no pressure at all.
  if (Object.hasOwn(CHAT_ROMANTIC_GESTURE_CONTACT, gesture)) {
    return CHAT_ROMANTIC_GESTURE_CONTACT[gesture as ChatRomanticContactGesture];
  }
  if (Object.hasOwn(CHAT_GESTURE_CONTACT, gesture)) {
    return CHAT_GESTURE_CONTACT[gesture as ChatContactGesture];
  }
  // Neither table owns it. Unreachable through the closed union, but `__proto__`
  // reaches `Object.prototype` through a bare index, which would build an intent
  // with no pressure at all — the lightest band wins by accident. Fail loud
  // instead: an unknown gesture is a contract violation, not a light touch.
  throw new Error(`unknown chat contact gesture: ${String(gesture)}`);
}

// ---------------------------------------------------------------------------
// Attempt assembly
// ---------------------------------------------------------------------------

/**
 * Which control fact an act's ORIGIN needs the scene to be carrying: a typed
 * line the player wrote may only move a `player_controlled` body, and an
 * NPC-origin reply-scene decision may only move an `npc_controlled` one.
 *
 * The same two literals `SceneParticipant.control` speaks in, deliberately — the
 * requirement is a claim about the fact, so restating it in a private vocabulary
 * would only create something to keep in sync.
 */
export type ChatContactControlRequirement = "player_controlled" | "npc_controlled";

/**
 * The actor-control decision, READ from the scene rather than asserted.
 *
 * The chat lane's player really is the controlling principal for the player
 * subject, so it would be easy to hard-code `allowed` — and that is exactly the
 * shortcut the actor-control law exists to close. Reading the scene's own
 * control fact means a body nobody declared a controller for produces
 * `unresolved` (silence, plus a diagnostic from the resolver), and a body whose
 * control fact says something other than what this origin requires produces a
 * refusal, whatever the calling lane believes.
 *
 * ACTOR-GENERIC, with the origin as an argument rather than a second copy: actor
 * control is read from the scene, and an NPC-origin start is allowed only for
 * `npc_controlled`. Two copies of this
 * function would be two places for the "missing fact ⇒ unresolved, wrong fact ⇒
 * denied" rule to drift, and the mirrored rule is the whole content of both.
 */
export function chatActorControl(input: {
  readonly scene: SceneState;
  readonly actorId: AffordanceSubjectId;
  readonly requires: ChatContactControlRequirement;
}): ContactActorControlDecision {
  const { actorId } = input;
  // The lane tag names WHICH leg read the fact, so a committed contact's
  // evidence still says whether a typed player line or an admitted reply-scene
  // candidate was the thing that claimed authority over this body.
  const laneEvidence: readonly AffordanceEvidence[] = [
    affordanceEvidence(
      "adapter",
      input.requires === "player_controlled" ? "chat.contact.player_line" : "chat.contact.npc_reply",
    ),
  ];
  const control = sceneParticipant(input.scene, actorId)?.control;
  if (control === undefined) return { status: "unresolved", actorId, evidence: laneEvidence };
  const evidence: readonly AffordanceEvidence[] = [...laneEvidence, ...sceneProvenanceEvidence([control.provenance])];
  return { status: control.value === input.requires ? "allowed" : "denied", actorId, evidence };
}

/**
 * One attempt's identity, as the lane's permission owner needs it: who is
 * attempting, whose permission the attempt needs, how intimate it is, and which
 * attempt it is (denials are per-attempt).
 */
export interface ChatContactPolicyAttempt {
  readonly permittedActorId: AffordanceSubjectId;
  readonly grantingTargetId: AffordanceSubjectId;
  readonly actionKind: ContactActionKind;
  readonly actionId: string;
}

/**
 * The lane's REAL permission read, closed over the exchange's folded projection
 * (`CHAT_ROMANTIC_PERMISSION`). Supplied by the pipeline ONLY when the flag is on;
 * consulted ONLY for action kinds that require a grant. Absent, or for
 * permission-neutral kinds, the resolver keeps the historical stub verbatim —
 * which is also the whole flag-off story.
 */
export type ChatContactPolicySource = (attempt: ChatContactPolicyAttempt) => ContactInteractionPolicyRead;

export interface ChatContactAttemptInput {
  readonly scene: SceneState;
  readonly act: ChatContactAct;
  /**
   * What lies between the two surfaces, ALREADY composed
   * (`chatContactMaterialBetween`). Composed by the caller because how many
   * sides are read is the caller's law, not the resolver's: the player leg reads
   * the target's wardrobe alone, and the reply-scene leg reads both.
   * `adapterUnavailable` rides through untouched — the resolver's own material
   * gate is where an absent answer becomes silence.
   */
  readonly material: AdapterRead<ContactMaterialRead>;
  /** The control fact this act's origin requires — `chatActorControl`'s question. */
  readonly control: ChatContactControlRequirement;
  readonly storyTime: AffordanceStoryTime;
  /** The permission owner's read, when the flag wired one. See `ChatContactPolicySource`. */
  readonly permissionPolicy?: ChatContactPolicySource;
  readonly sink?: DiagnosticSink;
}

/**
 * Resolve one detected act against the scene.
 *
 * The permission read is stated `not_required`, and that is honest rather than
 * convenient: affectionate contact needs no interaction-permission grant (owner
 * ruling, 2026-07-30 — `contactActionRequiresPermission`), so the resolver never
 * consults it. It rides the committed record anyway, where it says exactly what
 * happened: nobody was asked, because for this action kind nobody had to be.
 *
 * `targetAgencies` is empty because the act moves ONE body — the ACTOR's hand,
 * whoever the actor is. Nothing is proposed on the other person's side, so there
 * is no movement of theirs for their own authority to allow, and an
 * `adjustments` list that proposed one would need it. That argument is identical
 * for an NPC-origin start — target agencies stay empty there too, because only
 * the NPC's own hand moves — which is why one resolver serves both legs.
 */

/**
 * A permission-requiring kind is the exception when the pipeline wires a real
 * `permissionPolicy` source: the exact directional owner answer replaces the
 * neutral stub. Permission-neutral kinds and flag-off attempts keep the stub.
 */

/**
 * One admitted NPC `start` candidate as an act — the reply-scene leg's builder,
 * and the counterpart of `detectChatAffectionateTouch` on the player leg.
 *
 * There is no detection here and there never will be: the actor, the target, the
 * gesture, and the canonical target location all arrive already proven by the
 * four admission gates, and this function's whole job is to state the three
 * facts the candidate does NOT carry, each of them a law rather than a default:
 *
 * - **The source is the actor's `hands`** — the one acting surface this lane
 *   models, the same shared constant the player detector uses, so a start and a
 *   release can never disagree about which surface a chat contact is made with.
 * - **The action kind is `affectionate`.** Romantic, intimate, and restraint
 *   framings were vetoed whole at the assertion gate, so this is the only kind an
 *   admitted candidate can be — not a widening of what the model may propose.
 * - **The action id is deterministic** in the reply event ref, the actor, the
 *   target and the location, so a retake of the same reply reproduces the
 *   identical attempt (and, through the surface pair, the identical contact id).
 */
export function chatNpcContactAct(input: {
  readonly actor: AffordanceSubjectId;
  readonly target: AffordanceSubjectId;
  readonly targetLocationId: string;
  readonly gesture: ChatContactGesture;
  /** The REPLY event ref (`contact-reply:<assistantMessageId>`) — the id's ref half. */
  readonly eventRef: ContactEventRef;
}): ChatContactAct {
  const shape: ChatContactActShape = {
    actorSubject: input.actor,
    targetSubject: input.target,
    targetLocationId: input.targetLocationId,
  };
  return {
    ...shape,
    actionId: chatContactActionId(input.eventRef, shape),
    sourceLocationId: CHAT_CONTACT_SOURCE_LOCATION,
    actionKind: "affectionate",
    gesture: input.gesture,
  };
}

export function resolveChatContactAttempt(input: ChatContactAttemptInput): ContactResolution {
  const { act, scene } = input;
  const source: ContactBodySurfaceRef = {
    kind: "body",
    subjectId: act.actorSubject,
    locationId: act.sourceLocationId,
  };
  const target: ContactSurfaceRef = { kind: "body", subjectId: act.targetSubject, locationId: act.targetLocationId };
  const targetSurface: ContactBodySurfaceRef = {
    kind: "body",
    subjectId: act.targetSubject,
    locationId: act.targetLocationId,
  };
  const gesture = chatContactGestureBands(act.gesture);

  const intent: ContactActionIntent = {
    actionId: act.actionId,
    actorId: act.actorSubject,
    source,
    target,
    actionKind: act.actionKind,
    // `any_material`: an affectionate hand is happy to land on a sleeve. Demanding
    // bare skin would turn a dressed shoulder into an explicit-transition beat,
    // which is the anti-cheat firing on the wrong side.
    access: "any_material",
    requestedPressure: gesture.pressure,
    ...(gesture.area === undefined ? {} : { requestedArea: gesture.area }),
    ...(gesture.motion === undefined ? {} : { requestedMotion: { band: gesture.motion } }),
    storyTime: input.storyTime,
  };
  const policy: ContactInteractionPolicyRead =
    input.permissionPolicy !== undefined && contactActionRequiresPermission(act.actionKind)
      ? input.permissionPolicy({
          permittedActorId: act.actorSubject,
          grantingTargetId: act.targetSubject,
          actionKind: act.actionKind,
          actionId: act.actionId,
        })
      : {
          status: "not_required",
          scopes: [],
          evidence: [
            affordanceEvidence(
              "adapter",
              "chat.contact.policy",
              // Two different silences, told apart in the evidence. A neutral
              // kind genuinely needs no owner; a gated kind with no owner wired
              // is an UNANSWERED question, and the resolver reads this bare
              // `not_required` (no basis) as `permission_unresolved` for it —
              // the fail-closed direction, and the flag-off behavior of the
              // romantic producer.
              contactActionRequiresPermission(act.actionKind) ? "permission_owner_absent" : "permission_neutral_kind",
            ),
          ],
        };
  const context: ContactActionContext = {
    actorControl: chatActorControl({ scene, actorId: act.actorSubject, requires: input.control }),
    targetAgencies: [],
    policy,
    geometry: sceneGeometryRead({
      state: scene,
      source,
      target,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    }),
    sourceSupport: sceneSupportRead(scene, source, input.sink),
    targetSupport: sceneSupportRead(scene, targetSurface, input.sink),
    material: input.material,
    adjustments: [],
  };
  return resolveContactAttempt({ intent, context, ...(input.sink === undefined ? {} : { sink: input.sink }) });
}
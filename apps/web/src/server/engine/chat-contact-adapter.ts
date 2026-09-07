import type { ChatContactDetectionInput } from "./chat-contact/input-evidence";
import {
  adapterUnavailable,
  applySceneIntents,
  commitContactResolution,
  sceneEventRef,
  type AffordanceStoryTime,
  type ContactCommitOutcome,
  type ContactEndedCommit,
  type ContactEventRef,
  type ContactResolution,
  type DiagnosticSink,
  type SceneState,
} from "@/contracts";
import { resolveChatContactAttempt, type ChatContactPolicySource } from "./chat-contact/resolution";
import { CHAT_CONTACT_PLAYER_SUBJECT, type ChatContactAct } from "./chat-contact/identity";
import { applyChatContactDeparture, applyChatContactRelease, seededChatScene } from "./chat-contact/scene";
import { detectChatContactAct, detectChatContactRelease } from "./chat-contact/touch";
import {
  chatApproachSceneIntents,
  chatDepartureSceneIntents,
  detectChatApproach,
  detectChatDeparture,
} from "./chat-contact/movement";
import { chatContactMaterialBetween } from "./chat-contact/material";

/**
 * Pure chat contact coordinator. Plans seed → release → departure → approach →
 * touch without IO. Evidence, movement, scene lifecycle, material, resolution,
 * and presentation each live under `chat-contact/`.
 *
 * Detectors read only the player's own narration; actor-generic movement and
 * resolution read admitted NPC acts separately. The caller persists all planned
 * ends and the contact fold atomically with the scene. Presentation verifies the
 * resulting acknowledgment before describing a contact as committed.
 */
// ---------------------------------------------------------------------------
// The turn plan
// ---------------------------------------------------------------------------

export interface ChatContactTurnInput extends ChatContactDetectionInput {
  /** The scenario's scene, as loaded (or rolled back). Seeding happens here. */
  readonly scene: SceneState;
  readonly eventRef: ContactEventRef;
  readonly storyTime: AffordanceStoryTime;
  /** The permission owner's read, when the flag wired one. See `ChatContactPolicySource`. */
  readonly permissionPolicy?: ChatContactPolicySource;
  readonly sink?: DiagnosticSink;
}

export interface ChatContactTurn {
  /**
   * The scene with seeding, any release, and any movement folded in — but NOT
   * the new contact. The projection only advances once the caller has durably
   * recorded the fold, so a caller that persists nothing writes no contact
   * either.
   *
   * The RELEASE is folded, and the asymmetry is deliberate: the touch's fold is
   * held back because a contact the ledger never heard of would be a claim with
   * no record, while a release the ledger never heard of is a contact that stays
   * live — and it must not stay live inside the very scene the following touch
   * resolves against. The obligation moves to the caller instead: `ended` is
   * persisted with the same write as `commit`, and a caller that writes neither
   * must keep neither scene.
   */
  readonly scene: SceneState;
  readonly act: ChatContactAct | null;
  readonly resolution: ContactResolution | null;
  /**
   * The lifecycle fold, when the attempt was committable. **Nothing is durable
   * yet**: `commit.state` may only replace the projection after the caller's
   * ledger write returns, and `chatContactActionOutcome` refuses to say
   * `committed` without the acknowledgment that write produces.
   */
  readonly commit: ContactCommitOutcome | null;
  /**
   * The ends the player's own act produced, in plan order: the release's
   * (`withdrawn`) first, then the departure's (`separated`). Only the player's:
   * a lane hook that swept the scene (a clock skip, a scene change) ran before
   * this plan and owns its own commits.
   */
  readonly ended: readonly ContactEndedCommit[];
}

/**
 * The whole deterministic half of the contact leg: seed, RELEASE, DEPART,
 * approach, detect, resolve, fold.
 *
 * The order is load-bearing rather than tidy, and every step of it is a sentence
 * somebody could plausibly write in one message.
 *
 * - **Release leads.** "I let go of her hand and rest my hand on her shoulder"
 *   is one sentence describing two things in sequence, and a plan that resolved
 *   the touch against a projection still holding the released contact would
 *   either evict it for capacity or carry two live contacts from one hand.
 * - **Then the departure**, so "I pull my hand back and step away" ends what the
 *   hand was making as `withdrawn` and whatever remains as `separated`, rather
 *   than relabeling the release. (A contact the release already ended is gone
 *   from the projection, so nothing can be ended twice.)
 * - **Then the approach**, so "I step back. I walk over to Wren." lands where it
 *   says it lands: the departure widens the distance, and the approach that
 *   follows it in the message re-establishes `close` over the top. Reversing
 *   these two would leave the player standing a step away from somebody they
 *   just walked up to.
 * - **The touch last**, resolved against everything above it.
 *
 * Pure and total. Same scene + same message ⇒ same plan, which is what makes a
 * retake reproduce the identical contact id (it is derived from the pair and the
 * exchange's own event ref) rather than minting a second one.
 */
export function planChatContactTurn(input: ChatContactTurnInput): ChatContactTurn {
  const ref = sceneEventRef(input.eventRef);
  let scene = seededChatScene(input.scene, {
    player: CHAT_CONTACT_PLAYER_SUBJECT,
    characters: input.characters.map((member) => member.subjectId),
    ref,
    storyTime: input.storyTime,
  });

  const detection: ChatContactDetectionInput = {
    message: input.message,
    narratorInput: input.narratorInput,
    characters: input.characters,
  };

  const release = detectChatContactRelease(detection);
  const released =
    release === null
      ? null
      : applyChatContactRelease({
          scene,
          release,
          eventRef: input.eventRef,
          storyTime: input.storyTime,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        });
  const ended: ContactEndedCommit[] = [...(released?.commits ?? [])];
  if (released !== null) scene = released.scene;

  const departure = detectChatDeparture(detection);
  if (departure !== null) {
    // The intents are read from the PRE-end scene: an active contact is one of the
    // two things that license a distance claim at all (`departedBand`), and ending
    // it before asking would throw that licence away.
    const intents = chatDepartureSceneIntents(departure, {
      scene,
      characters: input.characters.map((member) => member.subjectId),
      player: CHAT_CONTACT_PLAYER_SUBJECT,
      ref,
      storyTime: input.storyTime,
    });
    const departed = applyChatContactDeparture({
      scene,
      departure,
      eventRef: input.eventRef,
      storyTime: input.storyTime,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    });
    ended.push(...departed.commits);
    scene = applySceneIntents(departed.scene, intents, input.sink).state;
  }

  const approach = detectChatApproach(detection);
  if (approach !== null) {
    scene = applySceneIntents(
      scene,
      chatApproachSceneIntents(approach, { player: CHAT_CONTACT_PLAYER_SUBJECT, ref, storyTime: input.storyTime }),
      input.sink,
    ).state;
  }

  const act = detectChatContactAct({
    ...detection,
    eventRef: input.eventRef,
    // The owner's PRESENCE is the gate. `chat-turn-contact.ts` wires a policy
    // source only under `chatRomanticPermissionEnabled()`, so this is that flag
    // reaching a pure module without the module reading an env var.
    romanticEnabled: input.permissionPolicy !== undefined,
  });
  if (act === null) return { scene, act: null, resolution: null, commit: null, ended };

  // A target with no roster entry cannot happen (the act's subject came FROM the
  // roster), and if it ever did, `unavailable` is the honest read of a body this
  // turn knows nothing about.
  //
  // ONE-SIDED on purpose: the player's own hand contributes no layer here. This
  // leg has never modelled the player's wardrobe into coverage, and reading their
  // side would turn every touch by an unmodellable player into silence — a
  // behavior change to shipped authority that the actor-control work has no
  // business making. The reply-scene leg reads both sides because it must,
  // through the same composer.
  const target = input.characters.find((member) => member.subjectId === act.targetSubject);
  const resolution = resolveChatContactAttempt({
    scene,
    act,
    material: chatContactMaterialBetween([
      { side: "target", material: target?.material ?? adapterUnavailable, locationId: act.targetLocationId },
    ]),
    control: "player_controlled",
    storyTime: input.storyTime,
    ...(input.permissionPolicy === undefined ? {} : { permissionPolicy: input.permissionPolicy }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  if (resolution.status !== "committable") return { scene, act, resolution, commit: null, ended };

  const commit = commitContactResolution({
    state: scene.contacts,
    resolution,
    eventRef: input.eventRef,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  return { scene, act, resolution, commit, ended };
}
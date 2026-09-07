import {
  affordanceSubjectId,
  CONTACT_EFFECT_OWNER_UNAVAILABLE,
  contactCommitEvents,
  contactMarkProposals,
  derivePermissionPolicyRead,
  diag,
  garmentActorForCharacter,
  withSceneContacts,
  type BodyMarkProposal,
  type ContactEndReason,
  type ContactLifecycleCommit,
  type ContactPersistenceAcknowledgment,
  type CharacterProfile,
  type DiagnosticSink,
  type EffectiveCoverageRead,
  type PhysicalActionOutcome,
} from "@/contracts";
import { log } from "../log";
import type { buildChatAffordanceRead } from "./chat-affordances";
import {
  chatContactAcknowledgment,
  chatContactActionOutcome,
  chatContactUnresolvedPremise,
  type ChatContactUnresolvedPremise,
} from "./chat-contact/presentation";
import { chatContactEventRef, CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact/identity";
import { chatContactMaterialAtCut } from "./chat-contact/material";
import { chatSceneAfterDiscontinuity, endAllChatContacts } from "./chat-contact/scene";
import { planChatContactTurn } from "./chat-contact-adapter";
import type { ChatContactPolicySource } from "./chat-contact/resolution";
import type { ChatContactRosterMember } from "./chat-contact/input-evidence";
import { appendChatContactEventsWithScene, CHAT_CONTACT_LEDGER_MISMATCH } from "./chat-contact-events";
import { foldChatPermissionProjection, listChatPermissionEvents } from "./chat-permission-events";
import type { detectSceneMovement } from "./chat-intent";
import type { ChatScenario, ChatState } from "./chat-state/types";
import type { ResolvedChatWardrobe } from "./chat-wardrobe";
import {
  chatContactActionsEnabled,
  chatContactEffectsEnabled,
  chatRomanticPermissionEnabled,
} from "./prompts/constants";
import type { ChatTurnMember, ChatContactTurnRecord, SubmitChatMessageInput } from "./chat-turn-types";

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function prepareChatTurnContact(args: {
  chatId: string;
  characterId: string;
  characterName: string;
  sink: DiagnosticSink;
  profile: CharacterProfile;
  owner: string;
  driftedState: ChatState;
  scenario: ChatScenario;
  others: ChatTurnMember[];
  input: Pick<SubmitChatMessageInput, "onContactTurn">;
  playerContent: string;
  narratorInput: boolean;
  exchangeGuardMessageId: string;
  movedTo: ReturnType<typeof detectSceneMovement>;
  wardrobe: ResolvedChatWardrobe;
  memberWardrobe: (member: ChatTurnMember) => Promise<ResolvedChatWardrobe>;
  physicalConstraintsEnabled: boolean;
  affordanceRead: ReturnType<typeof buildChatAffordanceRead> | null;
}) {
  const {
    chatId,
    characterId,
    characterName,
    sink,
    profile,
    owner,
    driftedState,
    others,
    input,
    playerContent,
    narratorInput,
    exchangeGuardMessageId,
    movedTo,
    wardrobe,
    memberWardrobe,
    physicalConstraintsEnabled,
    affordanceRead,
  } = args;
  let {
    scenario,
  } = args;

  // --- Affectionate contact (`CHAT_CONTACT_ACTIONS`, default OFF) ----------
  // The deterministic contact leg: end what this exchange ended, seed the
  // scene, fold the
  // movements the player wrote — a departure widening the distance and ending what
  // it separated, then an approach closing it — detect a plainly affectionate
  // hand-touch on a present roster member, resolve it against the scene owner's
  // reach and support reads, and — only if it is committable — fold it into the
  // active-contact projection and write the durable event before anything reaches
  // the prompt.
  //
  // Gated on THIS flag alone. Detection, the commit, the ledger row, and the scene
  // projection are authoritative state that must roll back with the exchange whether
  // or not any prompt reads them; only the OUTCOME's trip to the narrator waits on
  // `CHAT_PHYSICAL_CONSTRAINTS`, which owns the block it would ride in.
  //
  // **Persist before prompt, atomically, with the ledger as truth.**
  // `contactActionOutcomeStatus` will not say `committed` without an acknowledgment
  // of a durable write, so the append is awaited HERE and the acknowledgment is built
  // from its VERIFIED answer — a failed or mismatched write leaves the outcome
  // `unresolved`, which the seam renders as silence. The rows and the
  // `character_chats.scene` they fold into land in one transaction
  // (`appendChatContactEventsWithScene`), so the projection can no longer survive
  // without its record or the record without its projection. What is left is settle
  // re-writing the same column with the same value at the end of the exchange — a
  // no-op by construction — plus the ordinary rollback story: both halves hang off
  // the one exchange guard, and the retake delete above prunes the events of any take
  // whose projection was discarded.
  //
  // Fenced whole (docs/resilience.md): any failure degrades to no contact, no write,
  // and no outcome — which is the flag-off path — and never costs the exchange.
  let contactActionOutcomes: readonly PhysicalActionOutcome[] = [];
  let currentContactAttempt: { readonly actionId: string; readonly contactId?: string } | undefined;
  let contactUnresolvedPremise: ChatContactUnresolvedPremise | null = null;
  /** The contact-turn record minus its guidance lines — only assembled when observed. */
  let contactTurnFacts: Omit<ChatContactTurnRecord, "guidanceLines"> | null = null;
  // The current-cut coverage reads the contact leg derived, keyed by garment
  // actor. Threaded into the finalizer's `affordanceCoverage` so settlement
  // persists the EXACT objects the contact resolver consumed — never an
  // independent recompute.
  let contactCoverageCaptures: Readonly<Record<string, EffectiveCoverageRead>> = {};
  // The effect proposals this exchange's DURABLE contact derived
  // (`CHAT_CONTACT_EFFECTS`, default OFF). Held
  // here and committed at SETTLE through the body-surface owner transaction
  // inside `finalizeChatState`, never applied pre-prompt: the committed mark
  // becomes observable on the NEXT cut's reads, exactly the law that the
  // result of a proposal cannot be observed in the cut that proposed it.
  let contactEffectProposals: readonly BodyMarkProposal[] = [];
  if (chatContactActionsEnabled()) {
    try {
      const eventRef = chatContactEventRef(exchangeGuardMessageId);
      const storyMinute = Math.max(0, Math.trunc(scenario.clockMinutes));
      // --- The current cut's material answers (the settle-race fix) ----------
      // Coverage is derived from THIS exchange's resolved wardrobes, never read
      // from the previous settle's persisted capture: that capture lands in the
      // post-stream legs, so a touch sent quickly used to find "no capture yet"
      // for a body this very turn had already resolved — and, the mirror
      // hazard, an old capture could describe garments the current wardrobe no
      // longer wears. The affordance read's own capture is reused VERBATIM when
      // one was taken this turn (either guidance flag on), so the contact
      // resolver and the guidance consumers share one object; otherwise the
      // same pure garment stages derive it directly (`chatGarmentCoverageForCut`
      // — no cue selection, no prompt bytes). A derivation failure degrades to
      // `unavailable` for that body — silence with a diagnostic, never a stale
      // capture and never bare skin.
      //
      // The derivation itself is `chatContactMaterialAtCut`, shared with the
      // reply-scene decision leg's POST-settle cut: two different cuts, one
      // derivation, so neither leg can acquire a different answer to "is this
      // body dressed in something nobody modelled".
      //
      // PRESENT members only: an away character is not a body in the room, and the
      // seeded scene must never place one. Each carries their OWN material answer —
      // the current-cut coverage, the worn ids and the free-text look together, so
      // "the wardrobe says nothing is worn" and "nobody staged this wardrobe" stay
      // different answers. Ensemble members resolve their wardrobes HERE (cached,
      // reused by the prompt build below) — the primary-only fix would leave the
      // identical race standing for every named ensemble target.
      const presentMembers = [
        ...(driftedState.presence === "present"
          ? [{ characterId, name: characterName, aliases: profile.aliases, state: driftedState, wardrobe }]
          : []),
        ...(await Promise.all(
          others
            .filter((member) => member.state.presence === "present")
            .map(async (member) => ({
              characterId: member.characterId,
              name: member.name,
              aliases: member.profile.aliases,
              state: member.state,
              wardrobe: await memberWardrobe(member),
            })),
        )),
      ];
      const coverageCaptures: Record<string, EffectiveCoverageRead> = {};
      const contactRoster: ChatContactRosterMember[] = presentMembers.map((member) => {
        const actorId = garmentActorForCharacter(member.characterId);
        const captured =
          member.characterId === characterId && affordanceRead !== null ? affordanceRead.coverage : null;
        const { coverage, material } = chatContactMaterialAtCut({
          store: scenario.garments,
          actorId,
          ...(member.wardrobe.worn === undefined ? {} : { worn: member.wardrobe.worn }),
          visibility: member.wardrobe.partVisibility,
          environment: scenario.environment,
          clockMinutes: scenario.clockMinutes,
          captured,
          freeTextOutfit: member.state.outfit,
          wornItemIds: member.state.wornItemIds,
          sink,
        });
        if (coverage !== null) coverageCaptures[actorId] = coverage;
        return {
          subjectId: affordanceSubjectId(member.characterId),
          name: member.name,
          aliases: member.aliases,
          material,
        };
      });
      contactCoverageCaptures = coverageCaptures;

      // --- The two ends this exchange asserts, BEFORE anything is detected ---
      // A contact is a claim that two surfaces are in contact NOW, and both of these
      // are the world saying they are not:
      //
      // 1. A story-clock SKIP (owner ruling, 2026-07-31): any skip ends every active
      //    contact, reason `separated`. Hours do not pass with a hand left resting
      //    somewhere, and the alternative — carrying a touch across a time jump —
      //    would have the projection assert a contact nobody re-established. The
      //    signal is the scenario's one-shot `pendingSkipNote`, read here BEFORE the
      //    settle-time save consumes it (the skip route stamps it, this exchange is
      //    the one that sees it, and `saveChatScenario` clears it at settle).
      // 2. A place CHANGE this exchange (`movedTo`, the same detection that switched
      //    the scene memory above), reason `scene_changed`. Walking into another room
      //    is leaving the body you were touching behind. This is also the door a
      //    line like "I walk over to her desk" comes through — the contact detectors
      //    read it as furniture and state nothing, while the scene memory reads a
      //    move, and a held touch does not survive the mover either way.
      //
      // Order matters only in that a skip is the stronger, more specific truth: if
      // both fire, the skip empties the projection and the place change finds nothing
      // left to end. Ends are STATE, not attempted actions — they produce no narrator
      // outcome this pass — but they do advance the scene that rides the scenario.
      const endReasons: readonly ContactEndReason[] = [
        ...(scenario.pendingSkipNote.trim().length > 0 ? (["separated"] as const) : []),
        ...(movedTo ? (["scene_changed"] as const) : []),
      ];
      let endedScene = scenario.scene;
      const endedCommits: ContactLifecycleCommit[] = [];
      for (const reason of endReasons) {
        const ended = endAllChatContacts(endedScene, { reason, eventRef, storyTime: storyMinute, sink });
        endedScene = ended.scene;
        endedCommits.push(...ended.commits);
      }
      // --- The same discontinuities clear the pair relations -----------------
      // Owner ruling 2026-08-04: proximity and facing are valid only during
      // CONTINUOUS CO-PRESENCE in one place. Ending the contacts above while
      // keeping the distance is internally contradictory — it says the hand
      // came off AND that the two bodies are still within reach, with nothing
      // having moved. So the skip and the place change clear every pair, and a
      // member this cut says is offstage takes their own relations with them.
      //
      // Cleared is UNKNOWN, never a substituted band, and returning restores
      // nothing: a new distance needs explicit movement or placement evidence,
      // the same bar a first placement clears. The ordinary per-turn clock tick
      // is NOT a discontinuity — minutes passing inside one scene is what a
      // conversation is, and clearing on it would make reach permanently
      // unknown.
      //
      // The away half reads the PRE-prompt cut (last exchange's confirmed
      // presence), which is the cut every touch this exchange resolves
      // against. The reply-scene decision leg does its own post-settle pass for
      // the same rule, so an NPC-authored touch never sees a departure this
      // block could not have known about yet.
      endedScene = chatSceneAfterDiscontinuity(endedScene, {
        wholeScene: endReasons.length > 0,
        awaySubjects: [
          ...(driftedState.presence === "present" ? [] : [affordanceSubjectId(characterId)]),
          ...others
            .filter((member) => member.state.presence !== "present")
            .map((member) => affordanceSubjectId(member.characterId)),
        ],
      });

      // --- The permission owner's read (`CHAT_ROMANTIC_PERMISSION`, OFF) -----
      // Flag ON only: the chat's permission ledger is loaded ONCE per exchange
      // and folded into the active projection, and the resolver derives
      // the REAL policy read for any attempt whose kind requires a
      // grant. For a player attempt every
      // committed ledger event is chronologically effective — they all precede
      // the new attempt — so no cutoff is passed; the pure comparator exists
      // for same-reply ordering and is exercised in its own unit tests. Flag
      // OFF (or a permission-neutral kind) keeps the historical stub verbatim
      // inside the adapter, so today's bytes are untouched.
      let permissionPolicy: ChatContactPolicySource | undefined;
      if (chatRomanticPermissionEnabled()) {
        const permissionProjection = foldChatPermissionProjection(
          await listChatPermissionEvents(chatId, sink),
          sink,
        );
        permissionPolicy = (attempt) =>
          derivePermissionPolicyRead({
            projection: permissionProjection,
            permittedActorId: attempt.permittedActorId,
            grantingTargetId: attempt.grantingTargetId,
            actionKind: attempt.actionKind,
            playerSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
            attemptActionId: attempt.actionId,
          });
      }

      // The plan runs on the POST-hook scene: a touch this turn is resolved against a
      // world the skip or the room change has already emptied.
      const planned = planChatContactTurn({
        scene: endedScene,
        // The raw player line. An opening/continue beat has none, so nothing is
        // detected — a synthetic cue is not the player's body.
        message: playerContent,
        narratorInput,
        characters: contactRoster,
        eventRef,
        storyTime: storyMinute,
        ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
        sink,
      });

      const { act, resolution } = planned;
      const commit = planned.commit;
      const committed = commit !== null && commit.status === "committed" ? commit : null;
      if (act !== null) {
        currentContactAttempt = {
          actionId: act.actionId,
          ...(committed === null ? {} : { contactId: committed.contact.contactId }),
        };
      }
      // The S3 presentation constraint: a concrete act whose reach the scene
      // could not establish stays `unresolved` — no row, no fold, no
      // acknowledgment — but the guidance block (when `CHAT_PHYSICAL_CONSTRAINTS`
      // is on) gets one typed premise fencing the prose from inventing the landing.
      contactUnresolvedPremise = chatContactUnresolvedPremise({ act, resolution, characters: contactRoster });
      // ONE combined, ordered commit list per exchange — hook ends, then the ends
      // the plan folded from the player's own act (the release's `withdrawn`, then
      // the departure's `separated`), then the touch (with whatever it had to end to
      // make room). The ledger's `sequence` indexes this WHOLE list, so a retry that
      // re-derives it lands on the identical (eventRef, sequence) keys; splitting the
      // exchange into two appends would restart the sequence and collide.
      const commits: readonly ContactLifecycleCommit[] = [
        ...endedCommits,
        ...planned.ended,
        ...(commit === null ? [] : contactCommitEvents(commit)),
      ];
      // The projection this exchange produced, folded before the write so both halves
      // can be handed to one transaction.
      const postScene = committed === null ? planned.scene : withSceneContacts(planned.scene, committed.state);
      let scene = postScene;
      let acknowledgment: ContactPersistenceAcknowledgment | undefined;
      // Whether the ledger ACCEPTED this exchange's rows. Distinct from
      // `acknowledgment`, which additionally requires this turn to have
      // committed a contact of its own: an exchange that only ENDS contacts
      // (a withdrawal) writes real rows and earns no acknowledgment, and
      // conflating the two would report those ends as never having happened.
      let commitsRecorded = commits.length === 0;
      if (commits.length > 0) {
        const appended = await appendChatContactEventsWithScene({
          chatId,
          guardMessageId: exchangeGuardMessageId,
          eventRef,
          storyMinute,
          commits,
          scene: postScene,
        });
        if (appended.status === "recorded") {
          commitsRecorded = true;
          // Only now, and only for a write this turn's own rows are provably part of.
          if (act !== null && committed !== null) {
            acknowledgment = chatContactAcknowledgment({ commit: committed, eventRef, actionId: act.actionId });
          }
        } else {
          // The ledger holds a DIFFERENT record under this exchange's keys, so the
          // transaction rolled back: no rows added, the scene column untouched. The
          // contact projection therefore may not advance past the record it caches —
          // it stays exactly where it loaded, while the seeding and any movement,
          // which the ledger never carried, still ride the scenario. No
          // acknowledgment, so the outcome below resolves `unresolved` (silence).
          scene = withSceneContacts(postScene, scenario.scene.contacts);
          sink.push(
            diag(
              "error",
              CHAT_CONTACT_LEDGER_MISMATCH,
              "contact ledger holds a different record under this exchange's keys; nothing written",
              {
                path: "chat_contact_events",
                context: { eventRef, sequences: appended.mismatched.map((key) => key.sequence) },
              },
            ),
          );
        }
      }
      // --- Contact effects (`CHAT_CONTACT_EFFECTS`, default OFF) ------------
      // The pure derivation: committed contact → effect
      // proposal. Gated on the ACKNOWLEDGMENT, not the plan — a proposal may
      // only be derived from a contact the ledger provably recorded, so the
      // rolled-back-append path (no acknowledgment) derives nothing, exactly
      // as it narrates nothing. Contact persists no mark and owns no timer:
      // the proposals ride to `finalizeChatState`, where the body-surface
      // owner validates and commits them into the PRIMARY character's state
      // row — the one surface owner this release implements. A proposal
      // addressed to any other body (the player, an ensemble member) has no
      // implemented destination owner and commits nothing, on the record.
      if (chatContactEffectsEnabled() && acknowledgment !== undefined && committed !== null) {
        const proposals = contactMarkProposals(committed.contact);
        const primarySubject = affordanceSubjectId(characterId);
        contactEffectProposals = proposals.filter((proposal) => proposal.targetSubjectId === primarySubject);
        if (proposals.length > contactEffectProposals.length) {
          sink.push(
            diag(
              "info",
              CONTACT_EFFECT_OWNER_UNAVAILABLE,
              "a contact-effect proposal targets a body with no implemented surface owner; nothing committed",
              {
                path: "chat.contact_effects",
                context: { proposed: proposals.length, owned: contactEffectProposals.length },
              },
            ),
          );
        }
      }
      // The seeded scene and any movement the player wrote ride the scenario even
      // when no contact resolved: where the bodies are is true regardless.
      scenario = { ...scenario, scene };
      if (act !== null && resolution !== null) {
        contactActionOutcomes = [
          chatContactActionOutcome({
            act,
            resolution,
            eventRef,
            ...(commit === null ? {} : { commit }),
            ...(acknowledgment === undefined ? {} : { acknowledgment }),
            sink,
          }),
        ];
      }
      // The observer's half of the record — everything but the guidance lines,
      // which are rendered further down. Assembled here because this is the only
      // scope holding the act and the fold.
      //
      // DURABILITY IS THE ACKNOWLEDGMENT'S TO REPORT, never the plan's. A
      // planned commit is what the resolver decided; `acknowledgment` is what
      // the ledger accepted, and the two part company on a mismatch — that path
      // rolls the scene back, writes no rows, and withholds the acknowledgment
      // precisely so the outcome resolves to silence. Reporting the plan here
      // would tell a consumer a contact exists that it could not find, and a
      // trial grading narration against it would be grading prose against a
      // contact nobody recorded. `outcomeCommitted` is the same signal the
      // narrator's own action outcome runs on, so the record and the prompt
      // cannot disagree about whether the touch happened.
      if (input.onContactTurn !== undefined) {
        const outcomeCommitted = contactActionOutcomes[0]?.status === "committed";
        const durable = outcomeCommitted && acknowledgment !== undefined ? committed : null;
        contactTurnFacts = {
          ...(act === null
            ? {}
            : {
                act: {
                  kind: act.actionKind,
                  gesture: act.gesture,
                  targetLocationId: act.targetLocationId,
                  actionId: act.actionId,
                },
              }),
          ...(resolution === null ? {} : { status: resolution.status }),
          ...(resolution !== null && "reason" in resolution ? { reason: resolution.reason } : {}),
          resultCodes: contactActionOutcomes[0]?.resultCodes ?? [],
          committed: durable !== null,
          ...(durable === null ? {} : { contactId: durable.contact.contactId }),
          ...(durable === null ? {} : { directSkinContact: durable.contact.transmission.directSkinContact }),
          // Ends are reported on the same terms: a rolled-back append ended
          // nothing, however many ends the plan carried into it.
          ended: commitsRecorded
            ? commits
                .filter((entry) => entry.kind === "contact_ended")
                .map((entry) => ({ contactId: String(entry.contactId), reason: String(entry.reason) }))
            : [],
          // The premise the narrator was HANDED, which is not the same as the
          // one the seam derived. `CHAT_PHYSICAL_CONSTRAINTS` owns whether
          // these bytes reach the prompt, so with that flag off the premise is
          // computed and then dropped — and reporting it here would tell a
          // trial the prose was fenced when nothing fenced it, which is the
          // exact failure the rerun exists to detect.
          ...(physicalConstraintsEnabled && contactUnresolvedPremise !== null
            ? { premiseKind: contactUnresolvedPremise.kind }
            : {}),
        };
      }
    } catch (error) {
      log.error("engine.chat", "chat contact leg failed", { error: describeError(error) });
    }
  }
  return { scenario, contactActionOutcomes, currentContactAttempt, contactUnresolvedPremise, contactTurnFacts, contactCoverageCaptures, contactEffectProposals };
}

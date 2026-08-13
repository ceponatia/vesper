import { createHash } from "node:crypto";
import {
  activeContact,
  adapterUnavailable,
  affordanceSubjectIdSchema,
  applySceneIntents,
  commitContactResolution,
  contactCommitEvents,
  contactIdSchema,
  contactParticipantIds,
  diag,
  modulateContactGesture,
  normalizeTypographicQuotes,
  sceneEventRef,
  sceneProximityFact,
  withSceneContacts,
  CHAT_GESTURE_CONTACT,
  type AffordanceSubjectId,
  type CommittedContactRead,
  type ContactEventRef,
  type ContactId,
  type ContactLifecycleCommit,
  type ContactResolution,
  type DiagnosticSink,
  type NpcContactStartCandidate,
  type NpcContactUpdateCandidate,
  type NpcMovementCandidate,
  type NpcRef,
  type NpcSceneCandidate,
  type NpcSceneChronologyPlan,
  type NpcSceneDigestHandles,
  type NpcSceneReplySpan,
  type NpcSceneTier2Entry,
  type ParticipantRef,
  type SceneIntentOutcome,
  type SceneProximityBand,
  type SceneState,
} from "@/contracts";
import {
  approachedBand,
  chatContactMaterialBetween,
  chatNpcContactAct,
  chatSceneAfterDiscontinuity,
  departedBand,
  endCoveredContacts,
  npcMovementSceneIntents,
  resolveChatContactAttempt,
  seededChatScene,
  CHAT_CONTACT_PLAYER_SUBJECT,
  CHAT_CONTACT_SOURCE_LOCATION,
  type ChatContactMaterialSource,
} from "./chat-contact-adapter";
import { applyChatNpcContactEnding, type ChatNpcContactEnding } from "./chat-contact-reply";
import {
  NPC_SCENE_DECISION_COMMITTED_BLOB_MAX_BYTES,
  NPC_SCENE_DECISION_DROP_EVIDENCE_MAX,
  NPC_SCENE_DECISION_MAX_ROWS_PER_ACTION,
  type NpcSceneDecisionAction,
  type NpcSceneDecisionDrop,
  type NpcSceneDecisionDropReason,
  type NpcSceneDecisionResolution,
} from "./chat-npc-scene-envelope";
import { chatNpcSceneAuthorityKinds } from "./prompts/constants";

/**
 * THE AUTHORITY EXECUTOR — what an admitted, chronologically planned reply-scene
 * decision actually DOES to the scene
 * (romantic-contact-affordances.spec.actor-control.md, delivery-order step 4:
 * "Increment 1 — movement: monotonic approach/depart helpers, composite
 * departure ordering, opening/presence integration"; step 5: "Increment 2 —
 * starts: arbitrary actor adapter, two-sided material, and same-reply
 * wardrobe-change veto"; step 6: "Increment 3 — updates: stable contact handles
 * and gesture-only lifecycle operation").
 *
 * Shadow evaluates dry; this module is the half that replaces exactly that dry
 * step when the mode is `authority`. Everything else about the leg — the digest,
 * the one classifier call, the four admission gates, presence precedence over
 * classifier output, the chronology planner, the durable envelope, the guarded
 * CAS transaction — is shared with shadow and lives where it already lived.
 *
 * ## Pure by construction
 *
 * No database, no clock, no model call: the post-settle cut comes IN (the scene
 * as the decision leg reloaded it, the roster's post-settle presence, the story
 * minute, the per-subject wardrobe answers a start's material read composes, and
 * the set of bodies this same reply's settle re-dressed), and a next scene + an
 * ordered commit list + the envelope's payload entries come OUT.
 * `finishChatNpcSceneDecision` stays the only thing that touches the database,
 * and it hands this module's whole result to the ONE guarded transaction. That
 * is what makes the presence-driven endings, the frozen floor's endings, the
 * tier-2 movement, and the tier-2 contact rows land atomically or not at all.
 *
 * ## The three phases, and why they are ordered this way
 *
 * 1. **Presence integration, before anything reads a proposal.** A participant
 *    the post-settle cut says is `away` cannot act or be acted on, and every
 *    active contact they are in ends deterministically as `separated` FIRST —
 *    otherwise a tier-2 movement could resolve against a scene still holding a
 *    hand belonging to somebody who left the room. Their proximity and facing
 *    facts go with those contacts: a distance is a claim about two bodies in one
 *    room, and a remembered `close` would otherwise satisfy the reach read for a
 *    touch narrated after they came back. A participant the cut says is
 *    `present` is seeded (`seededChatScene`) before resolution, which is what
 *    lets a roster member who ARRIVED during this very reply act in it: an
 *    unplaced body has no control fact, and every intent about it would resolve
 *    `control_unresolved`.
 * 2. **The ordered walk**, against an EVOLVING scene. The reply's own written
 *    order is the execution order (the planner already sorted it), so "she steps
 *    closer, then takes your hand" approaches first and the START resolves
 *    against the nearer scene — the reach read the resolver runs sees the
 *    distance the earlier sentence closed, which is the whole reason the walk
 *    exists. A `composite_departure` is the one entry that is not a single step:
 *    the allowable wider band is read from the scene BEFORE that action's contact
 *    ends (an active contact is one of the two things that license a distance
 *    claim at all), then the endings fold, then the prevalidated proximity intent
 *    applies to the post-ending scene — the ending runs exactly once.
 * 3. **Contact starts** (increment 2), through the SAME adapter the player's
 *    typed touch resolves through: the actor's `hands` reaching a target surface,
 *    actor control read from the scene (`npc_controlled` required for an
 *    NPC-origin act), material composed from BOTH wardrobes, and the lifecycle
 *    fold committing into the evolving scene.
 * 4. **Contact updates** (increment 3), through the gesture-only lifecycle
 *    operation and NOTHING else. A local `contact_N` handle is resolved to a
 *    durable id and then re-checked against the EVOLVING scene, because the
 *    digest was built before settlement and before this walk: the contact it
 *    named may have been ended by an away member's separation, by the frozen
 *    floor, or simply be gone. See `applyContactUpdate`.
 *
 * ## The unordered floor
 *
 * When the floor detected an ending but its action span could not be located,
 * that ending cannot be totally ordered against ANY tier-2 candidate — and an
 * unorderable pair of state changes is precisely what the chronology rule
 * refuses to guess at. Every tier-2 candidate drops as `chronology_ambiguous`
 * and the floor applies alone, exactly as the shadow path records it today. The
 * floor is never the thing that drops: its authority predates this leg.
 *
 * ## The wardrobe-chronology veto
 *
 * A start whose actor or target had their wardrobe authoritatively rewritten
 * during this same reply is DROPPED as `wardrobe_chronology_ambiguous` (spec
 * §"Resolution laws → Contact start"). The material read available here is the
 * FINAL wardrobe, and a final wardrobe does not prove which layers existed at the
 * contact's own action offset: "she pulls her gloves off and takes your hand"
 * and "she takes your hand and pulls her gloves off" settle to the same
 * post-settle cut and mean different things about what the touch landed through.
 * A committed contact carries its material into every later observation, so
 * guessing here would be a durable claim about cloth nobody can date. A drop
 * rather than an `unresolved` action entry, because this is not the resolver
 * falling silent — the candidate never reached it.
 *
 * ## Truthful payload entries
 *
 * Every executed action records what RESOLUTION actually happened, not what was
 * proposed: `committed` carries the real committed scene intent and its commit
 * as replayable provenance (movement's only durable home — a movement leaves no
 * ledger row, only a scene fact), a helper no-op or an `already_asserted`
 * ordering answer is `continued` with a bounded detail naming which law was
 * quiet, a refused actor-control check is `refused` with the rejection reason,
 * and an unreadable scene is `unresolved` with the reason. A reader of the
 * envelope can therefore tell "the model proposed it and it landed" from "the
 * model proposed it and the scene said no" without re-running anything.
 *
 * A committed START inverts the blob rule for the same reason: a contact leaves
 * durable ledger rows, so the action carries their references plus a compact
 * `{ contactId, kind }` handle rather than the whole committed contact — the
 * provenance already exists, and duplicating it would spend the payload's blob
 * cap re-stating the ledger.
 */

// ---------------------------------------------------------------------------
// Shared payload vocabulary (both modes)
// ---------------------------------------------------------------------------

/** Bounded detail/summary length inside the payload — the envelope's own cap. */
export const NPC_SCENE_DECISION_DETAIL_MAX = 200;

/**
 * The action's quote fingerprint: sha256 over the NORMALIZED, trimmed evidence
 * quote — the same normalization the grounding gate applied, so the hash
 * identifies the quote the gate actually matched rather than the model's
 * typography.
 */
export function npcSceneQuoteHash(evidence: string): string {
  return createHash("sha256").update(normalizeTypographicQuotes(evidence).trim()).digest("hex");
}

/** One bounded inspector line per candidate ("approach npc_0 → player (touching)"). */
export function npcSceneCandidateSummary(candidate: NpcSceneCandidate): string {
  switch (candidate.kind) {
    case "approach":
      return `approach ${candidate.actorRef} → ${candidate.counterpartRef} (${candidate.band}${
        candidate.facing === "toward" ? ", facing toward" : ""
      })`;
    case "depart":
      return `depart ${candidate.actorRef} ← ${candidate.counterpartRef} (${candidate.band})`;
    case "start":
      return `start ${candidate.actorRef} → ${candidate.targetRef} ${candidate.gesture} ${candidate.targetLocationId}`;
    case "update":
      return `update ${candidate.actorRef} ${candidate.contactRef} ${candidate.gesture}`;
  }
}

/**
 * The drop record's bounded verbatim excerpt: the RAW model bytes, not the
 * normalized form the grounding gate matched on. The gate normalizes in order to
 * MATCH; this record's job is to show a reviewer exactly what the model claimed,
 * typography included, so a drop can be judged against the sentence it was made
 * about. Sliced defensively even though the contract already caps parsed
 * evidence at the same bound — the payload is written without a runtime parse.
 */
export function npcSceneDropEvidence(candidate: NpcSceneCandidate): string {
  return candidate.evidence.slice(0, NPC_SCENE_DECISION_DROP_EVIDENCE_MAX);
}

/** Movement or contact, as the payload's action/drop vocabulary names a candidate. */
export function npcSceneCandidateSlot(candidate: NpcSceneCandidate): "movement" | "contact" {
  return candidate.kind === "approach" || candidate.kind === "depart" ? "movement" : "contact";
}

/** The floor entry's bounded detail — the same three notes in both modes. */
export function npcSceneFloorDetail(input: {
  readonly committed: boolean;
  readonly spanUnlocated: boolean;
  readonly composite: boolean;
}): string {
  return [
    input.committed ? "" : "no_covered_contact",
    input.spanUnlocated ? "span_unlocated" : "",
    input.composite ? "composite_departure" : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, NPC_SCENE_DECISION_DETAIL_MAX);
}

/**
 * Record one dropped candidate: the bounded payload row AND its spec diagnostic
 * (`npc_scene_decision.<reason>`), so a drop appears in the durable envelope and
 * in the exchange's diagnostic stream from ONE call. Shared by both modes,
 * because a shadow tally and an authority tally must be counted the same way or
 * the rollout comparison is noise.
 */
export function recordNpcSceneDrop(
  into: NpcSceneDecisionDrop[],
  drop: NpcSceneDecisionDrop,
  severity: "info" | "warn",
  sink?: DiagnosticSink,
): void {
  into.push(drop);
  sink?.push(
    diag(severity, `npc_scene_decision.${drop.reason}`, `${drop.candidate} candidate dropped: ${drop.reason}`, {
      path: "npc_scene_decision",
      context: {
        candidate: drop.candidate,
        ...(drop.field ? { field: drop.field } : {}),
        ...(drop.detail ? { detail: drop.detail } : {}),
        ...(drop.evidence ? { evidence: drop.evidence } : {}),
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/**
 * The frozen floor's half, as the executor needs it: the DETECTED ending (not
 * yet applied — in authority mode the fold happens at the ending's chronological
 * position, which is the whole point of the walk), plus the ordering material
 * the planner already used.
 */
export interface NpcSceneExecutionFloor {
  readonly ending: ChatNpcContactEnding;
  /** The ending NPC as a digest ref, when the subject id mapped. Display only here. */
  readonly subjectRef: NpcRef | null;
  /** `null` ⇒ the span could not be located: the ending cannot be ordered against tier 2. */
  readonly span: NpcSceneReplySpan | null;
}

/** One roster member at the POST-settle cut — the authoritative presence answer. */
export interface NpcSceneExecutionMember {
  readonly subjectId: AffordanceSubjectId;
  readonly present: boolean;
}

/**
 * Every body's wardrobe answer at the POST-settle garment cut, by subject —
 * the PLAYER included, because a start's target is usually them.
 *
 * A subject the map does not carry reads `unavailable`, never bare: the absent
 * key means this cut could not answer for that body at all, and the whole point
 * of `chatContactMaterialSource`'s three-way law is that "nobody modelled it" and
 * "nothing is on it" are different facts. The executor takes the map as DATA (it
 * does no IO); `finishChatNpcSceneDecision` derives it from the settled scenario.
 */
export type NpcSceneMaterialCut = ReadonlyMap<AffordanceSubjectId, ChatContactMaterialSource>;

export interface NpcSceneExecutionInput {
  /** The COMPLETED assistant reply — only its length is read (the unordered span). */
  readonly reply: string;
  /** The post-settle scene, exactly as the decision leg reloaded it. */
  readonly scene: SceneState;
  readonly plan: NpcSceneChronologyPlan;
  readonly floor: NpcSceneExecutionFloor | null;
  /** EVERY roster member with the post-settle presence answer — away ones end contacts. */
  readonly roster: readonly NpcSceneExecutionMember[];
  readonly handles: NpcSceneDigestHandles;
  /** The reply event ref: contact identity for the ends, scene event ref for the intents. */
  readonly eventRef: ContactEventRef;
  /** The envelope's story minute, truncated once for the whole decision. */
  readonly storyMinute: number;
  /** The post-settle wardrobe answers a start's two-sided material read composes. */
  readonly material: NpcSceneMaterialCut;
  /**
   * Whose wardrobe an authoritative settle write CHANGED during this same reply
   * — the veto set. A start naming any of them drops as
   * `wardrobe_chronology_ambiguous` rather than resolving against a final
   * wardrobe that cannot be dated to the touch.
   */
  readonly wardrobeChanged: ReadonlySet<AffordanceSubjectId>;
  readonly sink?: DiagnosticSink;
}

export interface NpcSceneExecution {
  /** The scene after presence integration and the ordered walk — the CAS's `next`. */
  readonly scene: SceneState;
  /** Every contact commit, in ledger order: presence ends first, then the walk's. */
  readonly commits: readonly ContactLifecycleCommit[];
  /** The normalized ordered action list the durable envelope records. */
  readonly actions: readonly NpcSceneDecisionAction[];
  /** Post-admission drops this execution made (the unordered-floor rule). */
  readonly drops: readonly NpcSceneDecisionDrop[];
}

// ---------------------------------------------------------------------------
// Band decisions
// ---------------------------------------------------------------------------

/**
 * A band the monotonic helpers licensed, or `null` plus the bounded reason they
 * refused. The reason is carried because it is the payload's whole story for a
 * no-op: "the model proposed a movement and the scene already said something
 * equal or better" is a different fact from "the resolver could not read the
 * scene", and both would otherwise arrive as silence.
 */
interface NpcSceneBandDecision {
  readonly band: SceneProximityBand | null;
  readonly detail: string;
}

function decideApproachBand(
  scene: SceneState,
  actor: AffordanceSubjectId,
  counterpart: AffordanceSubjectId,
  band: SceneProximityBand,
): NpcSceneBandDecision {
  const next = approachedBand(scene, actor, counterpart, band);
  // `band_not_nearer` covers both refusals the approach law can make, and they
  // are the same fact: whatever the pair's effective distance is (a standing
  // fact, or `touching` proven by a live contact), it is not farther than this.
  return next === null ? { band: null, detail: "band_not_nearer" } : { band: next, detail: "" };
}

function decideDepartBand(
  scene: SceneState,
  actor: AffordanceSubjectId,
  counterpart: AffordanceSubjectId,
  band: "near" | "distant",
): NpcSceneBandDecision {
  const next = departedBand(scene, actor, counterpart, band);
  if (next !== null) return { band: next, detail: "" };
  // Two different refusals, and the difference matters to a reader: a pair the
  // scene never placed stays UNKNOWN (nothing licensed a distance at all),
  // while a placed pair simply was not widened by this sentence.
  return {
    band: null,
    detail: sceneProximityFact(scene, actor, counterpart) === undefined ? "band_unstated" : "band_not_wider",
  };
}

/** How one scene-intent outcome reads in the payload's resolution vocabulary. */
function movementOutcomeResolution(outcome: SceneIntentOutcome): {
  readonly resolution: NpcSceneDecisionResolution;
  readonly detail: string;
} {
  switch (outcome.status) {
    case "committed":
      return { resolution: "committed", detail: "" };
    case "rejected":
      // A refusal is an ANSWER, not a degradation: the scene says this body is
      // not NPC-controlled, so no NPC-origin intent may move it.
      return { resolution: "refused", detail: outcome.reason };
    case "superseded":
      return { resolution: "continued", detail: outcome.reason };
    case "unresolved":
      return {
        resolution: "unresolved",
        detail: [outcome.reason, outcome.detail ?? ""].filter(Boolean).join(" ").slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
      };
  }
}

/**
 * How one NON-committable contact resolution reads in the payload's vocabulary.
 *
 * Truthful rather than uniform, which is the whole reason the vocabulary has
 * four members: a REJECTION is somebody answering no (out of reach, this body is
 * not NPC-controlled) and a reader should be able to quote it; an UNRESOLVED is
 * the lane failing to see (no distance stated, no wardrobe modelled) and the
 * spec's own answer for it is silence. `explicit_transition_required` is neither
 * a yes nor a no — the touch would land after something visibly moved — and the
 * reply-scene leg has no producer for that movement, so it records as
 * `unresolved` with the requirement codes naming what was missing rather than
 * silently becoming a refusal nobody gave.
 */
function contactOutcomeResolution(resolution: Exclude<ContactResolution, { status: "committable" }>): {
  readonly resolution: NpcSceneDecisionResolution;
  readonly detail: string;
} {
  switch (resolution.status) {
    case "rejected":
      return { resolution: "refused", detail: resolution.reason };
    case "unresolved":
      return { resolution: "unresolved", detail: resolution.reason };
    case "explicit_transition_required":
      return {
        resolution: "unresolved",
        detail: ["explicit_transition_required", ...resolution.requirements.map((entry) => entry.code)]
          .join(" ")
          .slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
      };
  }
}

/**
 * The committed provenance blob, or `undefined` when it will not fit.
 *
 * The payload is inserted WITHOUT a runtime parse, so an oversized blob would
 * only be discovered on read — where it degrades the entire payload to empty.
 * Dropping the blob keeps the action's own truth (`committed`, with its span,
 * summary and detail) and loses only the replay detail.
 */
function boundedCommittedBlob(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > NPC_SCENE_DECISION_COMMITTED_BLOB_MAX_BYTES ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * The live contact an update's handle actually denotes, or the identity field
 * that disagreed.
 *
 * A discriminated union rather than a nullable contact, because the failure has
 * to be NAMED: "the ref points at nothing active" and "it points at somebody
 * else's contact" are the same silence to the player and completely different
 * facts to a reader of the durable envelope, and the drop row's `field` is
 * where that difference survives.
 */
type NpcSceneHeldContact =
  | { readonly status: "held"; readonly contact: CommittedContactRead }
  | { readonly status: "conflict"; readonly field: string };

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/**
 * Execute one admitted, planned decision against the post-settle cut.
 *
 * Pure and total: same inputs ⇒ same scene, same commits, same payload entries,
 * on a retry and on a replay. Nothing here throws — an unresolvable ref, an
 * out-of-scope kind, and a contact the post-settle scene no longer agrees with
 * are all ordinary recorded outcomes (docs/resilience.md §2).
 */
export function executeNpcSceneDecision(input: NpcSceneExecutionInput): NpcSceneExecution {
  const sink = input.sink;
  const eventRef = input.eventRef;
  const sceneRef = sceneEventRef(eventRef);
  const storyTime = input.storyMinute;
  const scope = chatNpcSceneAuthorityKinds();
  /** The span an action that is not tied to one sentence records: the whole reply. */
  const wholeReply: NpcSceneReplySpan = { start: 0, end: Math.max(1, input.reply.length) };

  let scene = input.scene;
  const commits: ContactLifecycleCommit[] = [];
  const actions: NpcSceneDecisionAction[] = [];
  const drops: NpcSceneDecisionDrop[] = [];

  /**
   * Append commits to the ONE ledger list and return the row references they
   * earned. Sequence is the index in the WHOLE list (skipping the no-row
   * `contact_continued` kind) — exactly what `chatContactEventRowsFor` assigns
   * when the transaction writes them, so the payload's references and the
   * ledger's keys are derived from the same rule rather than kept in sync.
   */
  const append = (next: readonly ContactLifecycleCommit[]): { eventRef: string; sequence: number }[] => {
    const rows: { eventRef: string; sequence: number }[] = [];
    for (const commit of next) {
      const sequence = commits.length;
      commits.push(commit);
      if (commit.kind !== "contact_continued") rows.push({ eventRef, sequence });
    }
    return rows;
  };

  /**
   * One action's row references, respecting the payload's per-action cap the
   * way the blob cap is respected: the payload is inserted without a runtime
   * parse, so an over-cap list would degrade the WHOLE payload on every later
   * read. The LEDGER rows themselves are all written regardless — `append`
   * already claimed their sequences — only this bounded reference list is
   * sliced, and `note` says so in the action's detail (no silent caps).
   */
  const boundedActionRows = (
    rows: readonly { eventRef: string; sequence: number }[],
  ): { readonly rows: readonly { eventRef: string; sequence: number }[]; readonly note: string } =>
    rows.length > NPC_SCENE_DECISION_MAX_ROWS_PER_ACTION
      ? { rows: rows.slice(0, NPC_SCENE_DECISION_MAX_ROWS_PER_ACTION), note: "rows_truncated" }
      : { rows, note: "" };

  /** A digest ref → the subject id it stands for, or `null` (recorded, never thrown). */
  const subjectOf = (ref: ParticipantRef): AffordanceSubjectId | null => {
    const parsed = affordanceSubjectIdSchema.safeParse(input.handles.subjectIdByRef.get(ref));
    return parsed.success ? parsed.data : null;
  };

  // --- Phase 1: presence integration ---------------------------------------
  // Away first, then seeding. A body the cut says has LEFT takes its contacts
  // AND its distances with it before any proposal is resolved; a body the cut
  // says is HERE is placed before any proposal needs to name it.
  //
  // The pair relations go with the contacts under the same owner ruling the
  // player leg applies (2026-08-04): proximity and facing are valid only during
  // continuous co-presence, so a body that left takes its distances with it.
  // Keeping the last stated band would let a stale `close` satisfy the reach
  // read for a start narrated after she came back — and would make
  // `approachedBand` no-op the very approach that should have re-established
  // the distance, because the monotonic law would see the scene already
  // claiming something nearer. Posture, support, and control are left alone:
  // whether THEY should survive a departure is a scene-model question the
  // ruling deliberately did not settle (`withoutScenePairRelations`).
  //
  // The whole-scene discontinuities (place change, story-clock skip) are the
  // player leg's pre-prompt business and are already folded into the column
  // this leg reloads, so only the away half runs here.
  for (const member of input.roster) {
    if (member.present) continue;
    const ended = endCoveredContacts({
      scene,
      reason: "separated",
      eventRef,
      storyTime,
      ...(sink === undefined ? {} : { sink }),
      covers: (contact) => contactParticipantIds(contact.source, contact.target).includes(member.subjectId),
    });
    scene = ended.commits.length === 0 ? scene : ended.scene;
    const placed = scene;
    scene = chatSceneAfterDiscontinuity(scene, { wholeScene: false, awaySubjects: [member.subjectId] });
    // The helper is identity when there was nothing to drop, so this compares by
    // reference: an away member who held no contacts and had no stated distance
    // changed nothing, and records nothing.
    const relationsDropped = scene !== placed;
    if (ended.commits.length === 0 && !relationsDropped) continue;
    const rows = boundedActionRows(append(ended.commits));
    actions.push({
      kind: "presence_ending",
      span: wholeReply,
      quoteHash: "",
      summary: `presence: ${member.subjectId} away`.slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
      resolution: "committed",
      detail: [
        ended.commits.length === 0 ? "" : "presence_away_separated",
        relationsDropped ? "presence_away_relations_cleared" : "",
        rows.note,
      ]
        .filter(Boolean)
        .join(" "),
      contactRows: [...rows.rows],
    });
  }
  scene = seededChatScene(scene, {
    player: CHAT_CONTACT_PLAYER_SUBJECT,
    characters: input.roster.flatMap((member) => (member.present ? [member.subjectId] : [])),
    ref: sceneRef,
    storyTime,
  });

  // --- Payload entry builders ----------------------------------------------

  /**
   * The ONE tier-2 payload entry builder. Every outcome — dry, refused,
   * continued, committed — writes the same identity fields (span, quote hash,
   * summary) and differs only in its verdict, so they are built in one place
   * rather than assembled per branch.
   */
  const pushTier2 = (
    entry: NpcSceneTier2Entry,
    composite: boolean,
    verdict: {
      readonly resolution: NpcSceneDecisionResolution;
      readonly detail: string;
      readonly committed?: unknown;
      /** The ledger rows THIS action earned — movement never has any; a start can. */
      readonly contactRows?: readonly { eventRef: string; sequence: number }[];
    },
  ): void => {
    const rows = boundedActionRows(verdict.contactRows ?? []);
    actions.push({
      kind: npcSceneCandidateSlot(entry.candidate),
      span: entry.span,
      quoteHash: npcSceneQuoteHash(entry.candidate.evidence),
      summary: npcSceneCandidateSummary(entry.candidate).slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
      resolution: verdict.resolution,
      detail: [verdict.detail, composite ? "composite_departure" : "", rows.note]
        .filter(Boolean)
        .join(" ")
        .slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
      ...(verdict.committed === undefined ? {} : { committed: verdict.committed }),
      contactRows: [...rows.rows],
    });
  };

  /**
   * An admitted tier-2 candidate that executed nothing. The resolver never ran,
   * so `unresolved` is its silence; the detail names WHOSE silence it was, which
   * is the difference between "this increment is not built" and "the scene
   * refused it".
   */
  const pushDry = (entry: NpcSceneTier2Entry, composite: boolean, reason: string): void => {
    pushTier2(entry, composite, { resolution: "unresolved", detail: reason });
  };

  /**
   * A POST-ADMISSION drop: the candidate was admitted, ordered, and planned for
   * real, and only then did executing it prove unlawful. It earns NO action
   * entry — an action entry records what a resolver answered, and no resolver
   * ran — so the durable trace is this bounded drop row plus its diagnostic.
   *
   * Three producers share it: the unordered floor (nothing can be ordered
   * against an ending whose sentence is missing), the same-reply wardrobe veto,
   * and an update whose contact the post-settle scene no longer agrees with.
   * `field` names the mismatch when there is one to name.
   */
  const dropCandidate = (
    candidate: NpcSceneCandidate,
    reason: NpcSceneDecisionDropReason,
    field: string,
  ): void => {
    recordNpcSceneDrop(
      drops,
      {
        candidate: npcSceneCandidateSlot(candidate),
        reason,
        field,
        detail: npcSceneCandidateSummary(candidate).slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
        evidence: npcSceneDropEvidence(candidate),
      },
      "info",
      sink,
    );
  };

  /** The frozen floor's fold, at its chronological position. */
  const applyFloor = (floor: NpcSceneExecutionFloor, span: NpcSceneReplySpan, composite: boolean): void => {
    const ended = applyChatNpcContactEnding({
      scene,
      ending: floor.ending,
      eventRef,
      storyTime,
      ...(sink === undefined ? {} : { sink }),
    });
    const committed = ended.commits.length > 0;
    if (committed) scene = ended.scene;
    const rows = boundedActionRows(append(ended.commits));
    actions.push({
      kind: "floor_ending",
      span,
      quoteHash: "",
      summary: `ending: ${floor.ending.reason}${floor.subjectRef === null ? "" : ` by ${floor.subjectRef}`}`,
      // Zero covered contacts is an ordinary answer (the prose eased away from a
      // touch the projection never held), not a failure — but it is not a commit.
      resolution: committed ? "committed" : "unresolved",
      detail: [npcSceneFloorDetail({ committed, spanUnlocated: floor.span === null, composite }), rows.note]
        .filter(Boolean)
        .join(" ")
        .slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
      contactRows: [...rows.rows],
    });
  };

  /**
   * One tier-2 movement. `prevalidated` carries a band decided against an EARLIER
   * scene — the composite departure's, read before its own contact ends — and
   * `null` means "decide it against the scene as it stands now".
   */
  const applyMovement = (
    entry: NpcSceneTier2Entry,
    candidate: NpcMovementCandidate,
    composite: boolean,
    prevalidated: NpcSceneBandDecision | null,
  ): void => {
    if (!scope.has("movement")) {
      pushDry(entry, composite, "authority_scope_excluded");
      return;
    }
    const actor = subjectOf(candidate.actorRef);
    const counterpart = subjectOf(candidate.counterpartRef);
    if (actor === null || counterpart === null) {
      pushDry(entry, composite, "ref_unresolved");
      return;
    }
    const decision =
      prevalidated ??
      (candidate.kind === "approach"
        ? decideApproachBand(scene, actor, counterpart, candidate.band)
        : decideDepartBand(scene, actor, counterpart, candidate.band));
    const band = decision.band;
    if (band === null) {
      // The helpers refused BEFORE an intent existed, which is the only place
      // the monotonic placement law can be enforced: `commitSceneIntent` refuses
      // an exact restatement and a stale write, and has no opinion at all about
      // a band that would make a pair nearer than it should be.
      pushTier2(entry, composite, { resolution: "continued", detail: decision.detail });
      return;
    }
    const intents = npcMovementSceneIntents({
      kind: candidate.kind,
      actor,
      counterpart,
      band,
      // Facing rides ONLY on an approach the candidate proposed it for — the
      // congruence gate proved it independently. Backing into place changes
      // proximity without changing where a body looks.
      facing: candidate.kind === "approach" ? candidate.facing : null,
      ref: sceneRef,
      storyTime,
    });
    const applied = applySceneIntents(scene, intents, sink);
    scene = applied.state;
    const committedPairs = intents.flatMap((intent, index) => {
      const outcome = applied.outcomes[index];
      return outcome !== undefined && outcome.status === "committed" ? [{ intent, commit: outcome.commit }] : [];
    });
    // The proximity intent is always first and is the movement's defining fact,
    // so its outcome is the action's resolution; a facing intent beside it is
    // supplementary provenance, never the verdict.
    const primaryOutcome = applied.outcomes[0];
    const verdict =
      primaryOutcome === undefined
        ? { resolution: "unresolved" as NpcSceneDecisionResolution, detail: "no_intent" }
        : movementOutcomeResolution(primaryOutcome);
    // The blob names the movement's defining commit first (`intent`/`commit`),
    // with the facing commit beside it when one rode along — a movement leaves
    // no ledger row, so this is its ONLY replayable provenance.
    const primary = committedPairs[0];
    const secondary = committedPairs[1];
    const blob =
      primary === undefined
        ? undefined
        : boundedCommittedBlob({ ...primary, ...(secondary === undefined ? {} : { facing: secondary }) });
    pushTier2(entry, composite, {
      resolution: verdict.resolution,
      // The provenance blob is the only part of a commit that can be dropped for
      // size; saying so keeps "committed with no blob" from reading as a writer
      // that forgot one.
      detail: [verdict.detail, blob === undefined && primary !== undefined ? "blob_omitted" : ""]
        .filter(Boolean)
        .join(" "),
      ...(blob === undefined ? {} : { committed: blob }),
    });
  };

  /**
   * One tier-2 contact START, resolved against the scene AS IT STANDS — which is
   * the scene an earlier action in this same reply may already have moved.
   *
   * The whole resolution runs through the adapter the player's typed touch runs
   * through (`chatNpcContactAct` → `chatContactMaterialBetween` →
   * `resolveChatContactAttempt` → `commitContactResolution`). Nothing about
   * geometry, reach, support, capacity, or the lifecycle's same-pair laws is
   * re-implemented here: an NPC-origin start differs from a player-origin one in
   * exactly two places, and both are arguments — the control fact required
   * (`npc_controlled`) and the number of wardrobe sides read (two).
   */
  const applyContactStart = (
    entry: NpcSceneTier2Entry,
    candidate: NpcContactStartCandidate,
    composite: boolean,
  ): void => {
    if (!scope.has("start")) {
      pushDry(entry, composite, "authority_scope_excluded");
      return;
    }
    const actor = subjectOf(candidate.actorRef);
    const target = subjectOf(candidate.targetRef);
    // The admission gate already refused `targetRef === actorRef` as `ref_invalid`
    // (spec §"Resolution laws → Contact start": "the target must differ from the
    // actor"), and the resolver refuses identical surfaces on top of that; this
    // branch only has to survive a ref no handle map could resolve.
    if (actor === null || target === null) {
      pushDry(entry, composite, "ref_unresolved");
      return;
    }
    if (input.wardrobeChanged.has(actor) || input.wardrobeChanged.has(target)) {
      // This reply's own settle proved that the wardrobe the material read would
      // use is not the wardrobe the touch happened in.
      dropCandidate(candidate, "wardrobe_chronology_ambiguous", "");
      return;
    }

    const act = chatNpcContactAct({
      actor,
      target,
      targetLocationId: candidate.targetLocationId,
      gesture: candidate.gesture,
      eventRef,
    });
    const materialOf = (subject: AffordanceSubjectId): ChatContactMaterialSource =>
      input.material.get(subject) ?? adapterUnavailable;
    const resolution = resolveChatContactAttempt({
      scene,
      act,
      // BOTH sides, source first: a glove is nearer the reaching hand than her
      // sleeve is. Either side unreadable ⇒ the whole read is unavailable ⇒ the
      // resolver's material gate answers `unresolved`, which is silence.
      material: chatContactMaterialBetween([
        { side: "source", material: materialOf(actor), locationId: act.sourceLocationId },
        { side: "target", material: materialOf(target), locationId: act.targetLocationId },
      ]),
      control: "npc_controlled",
      storyTime,
      ...(sink === undefined ? {} : { sink }),
    });
    if (resolution.status !== "committable") {
      const verdict = contactOutcomeResolution(resolution);
      pushTier2(entry, composite, verdict);
      return;
    }

    const outcome = commitContactResolution({
      state: scene.contacts,
      resolution,
      eventRef,
      ...(sink === undefined ? {} : { sink }),
    });
    if (outcome.status === "refused") {
      // Capacity: the projection is full of contacts newer than this assertion,
      // so nothing could be ended honestly to make room. A real answer, not a gap.
      pushTier2(entry, composite, { resolution: "refused", detail: outcome.reason });
      return;
    }
    // `contact_continued` returns the SAME state reference and writes no row —
    // the pair already held this exact touch, and re-stating it is a no-op the
    // lifecycle owns. Everything else advances the evolving scene, so a later
    // action in this walk (and the CAS's `next`) sees the new contact.
    if (outcome.state !== scene.contacts) scene = withSceneContacts(scene, outcome.state);
    const continued = outcome.commit.kind === "contact_continued";
    pushTier2(entry, composite, {
      resolution: continued ? "continued" : "committed",
      detail: outcome.commit.kind,
      // A COMPACT reference, never the contact read: the contact's own durable
      // rows are the provenance (`contactRows` below), and stuffing the whole
      // committed record in here would push the payload past its blob cap for
      // information the ledger already holds verbatim.
      ...(continued ? {} : { committed: { contactId: outcome.contact.contactId, kind: outcome.commit.kind } }),
      // Every commit the fold produced, in ledger order — the framing-change and
      // capacity ends `contactCommitEvents` puts AHEAD of the start included, so a
      // replay frees the pair before the new contact claims it.
      contactRows: append(contactCommitEvents(outcome)),
    });
  };

  /**
   * The post-settle identity re-check: the live contact a durable id denotes, or
   * the identity field that disagreed
   * (spec §"Resolution laws → Contact update": "`contactRef` must still resolve
   * to exactly one active contact whose immutable identity says: `actorId` is
   * the candidate NPC; source is that NPC's `hands`; `actionKind` is
   * `affectionate`").
   *
   * The digest's handle is NOT authority — it was assembled before settlement
   * and before this walk, and by the time an update executes, the contact behind
   * it may have been ended by an away member's separation, by the frozen floor,
   * or by anything else this same transaction already folded. So the id is
   * looked up in the EVOLVING projection, and everything the ref promised is
   * re-read from the contact itself.
   *
   * The three identity checks are not ceremony over `refDrop`'s digest-side
   * versions. `refDrop` proved the DIGEST's row said these things; this proves
   * the LIVE contact does. A contact that ended and a new one that started on
   * the same pair during this reply would carry a different id, so the id lookup
   * alone already refuses it — but a stored projection whose contact was written
   * by another lane, or a handle map built against a different scene, would not
   * be caught by anything else at all.
   */
  const heldContactFor = (durable: ContactId, actor: AffordanceSubjectId): NpcSceneHeldContact => {
    const contact = activeContact(scene.contacts, durable);
    if (contact === undefined) return { status: "conflict", field: "contactRef" };
    // Never another actor's contact, and never a contact she is not the reaching
    // side of: an update modulates the hand that started it or nothing at all.
    if (contact.actorId !== actor) return { status: "conflict", field: "actorId" };
    if (contact.source.subjectId !== actor || contact.source.locationId !== CHAT_CONTACT_SOURCE_LOCATION) {
      return { status: "conflict", field: "source" };
    }
    // Never promoted, never escalated: the framing an update may touch is the one
    // this lane's whole tier-2 contact surface is scoped to.
    if (contact.actionKind !== "affectionate") return { status: "conflict", field: "actionKind" };
    return { status: "held", contact };
  };

  /**
   * One tier-2 contact UPDATE: a gesture change on a contact that is already
   * live, committed through `modulateContactGesture` and through nothing else.
   *
   * The lifecycle operation is the only lawful door (spec: "Re-resolving a full
   * contact attempt is forbidden for updates"). It carries a pressure and a
   * motion and physically cannot carry anything else, so the contact's id,
   * actor, action kind, orientation, area, material, transmission, implicit
   * adjustments, and start authorization survive byte-for-byte — which is what
   * makes an update safe to run against a POST-settle wardrobe that a start
   * would have to be vetoed over.
   */
  const applyContactUpdate = (
    entry: NpcSceneTier2Entry,
    candidate: NpcContactUpdateCandidate,
    composite: boolean,
  ): void => {
    if (!scope.has("update")) {
      pushDry(entry, composite, "authority_scope_excluded");
      return;
    }
    const actor = subjectOf(candidate.actorRef);
    // A ref no handle map can translate is the SAME failure as an unresolvable
    // subject ref on the two legs beside this one: the digest and the executor
    // disagree about what this reply's references mean, which is a plumbing gap
    // rather than anything the scene said.
    const durable = contactIdSchema.safeParse(input.handles.contactIdByRef.get(candidate.contactRef));
    if (actor === null || !durable.success) {
      pushDry(entry, composite, "ref_unresolved");
      return;
    }
    const held = heldContactFor(durable.data, actor);
    if (held.status === "conflict") {
      // "Zero or more than one compatible result is silence." A DROP rather than
      // an action entry, for the same reason the wardrobe veto is one: the
      // candidate never reached the lifecycle, so there is no resolution to
      // record — and the alternative (falling back to a start) is exactly the
      // promotion the spec forbids.
      dropCandidate(candidate, "contact_conflict", held.field);
      return;
    }

    const gesture = CHAT_GESTURE_CONTACT[candidate.gesture];
    const outcome = modulateContactGesture({
      state: scene.contacts,
      contactId: held.contact.contactId,
      pressure: gesture.pressure,
      // The gesture vocabulary states motion or leaves it unstated; `null` is the
      // second case, and it CLEARS a band the previous gesture set rather than
      // letting a tap linger under a hand that is only resting now.
      motion: gesture.motion === undefined ? null : { band: gesture.motion },
      eventRef,
      storyTime,
      ...(sink === undefined ? {} : { sink }),
    });
    if (outcome.status === "absent") {
      // Unreachable in practice — `heldContactFor` just found the contact in this
      // same projection — but the union has the case, and inventing a resolution
      // for it would be a claim nothing supports.
      dropCandidate(candidate, "contact_conflict", "contactRef");
      return;
    }
    if (outcome.status === "continued") {
      // No row and no state change: the gesture is the one already held, or the
      // assertion was older than the projection. The commit still rides the ONE
      // ledger list so its sequence index matches `chatContactEventRowsFor`.
      pushTier2(entry, composite, {
        resolution: "continued",
        detail: `${outcome.commit.kind} ${outcome.reason}`,
        contactRows: append([outcome.commit]),
      });
      return;
    }
    scene = withSceneContacts(scene, outcome.state);
    pushTier2(entry, composite, {
      resolution: "committed",
      detail: outcome.commit.kind,
      // The COMPACT handle, exactly as a committed start records one: the
      // contact's own `contact_updated` row is the provenance.
      committed: { contactId: outcome.contact.contactId, kind: outcome.commit.kind },
      contactRows: append([outcome.commit]),
    });
  };

  /** One planned tier-2 entry, dispatched to the leg that owns its kind. */
  const applyTier2 = (
    entry: NpcSceneTier2Entry,
    composite: boolean,
    prevalidated: NpcSceneBandDecision | null,
  ): void => {
    const candidate = entry.candidate;
    switch (candidate.kind) {
      case "approach":
      case "depart":
        applyMovement(entry, candidate, composite, prevalidated);
        return;
      case "start":
        applyContactStart(entry, candidate, composite);
        return;
      case "update":
        applyContactUpdate(entry, candidate, composite);
        return;
    }
  };

  /**
   * The composite departure's band, read from the scene BEFORE its own contact
   * ends — an active contact between the pair is one of the two things that
   * license a distance claim at all, and folding the ending first would throw
   * that licence away. `null` ⇒ nothing was prevalidated (out of scope, or an
   * unresolvable ref), and the ordinary path decides.
   */
  const prevalidatedDepartBand = (candidate: NpcSceneCandidate): NpcSceneBandDecision | null => {
    if (candidate.kind !== "depart" || !scope.has("movement")) return null;
    const actor = subjectOf(candidate.actorRef);
    const counterpart = subjectOf(candidate.counterpartRef);
    if (actor === null || counterpart === null) return null;
    return decideDepartBand(scene, actor, counterpart, candidate.band);
  };

  const floor = input.floor;

  // --- The unordered floor: tier 2 cannot be ordered against it -------------
  if (floor !== null && floor.span === null) {
    for (const action of input.plan.actions) {
      if (action.source !== "tier2") continue;
      dropCandidate(action.entry.candidate, "chronology_ambiguous", "");
    }
    applyFloor(floor, wholeReply, false);
    return { scene, commits, actions, drops };
  }

  // --- Phase 2: the ordered walk -------------------------------------------
  for (const action of input.plan.actions) {
    switch (action.source) {
      case "floor":
        if (floor !== null) applyFloor(floor, action.floor.span, false);
        break;
      case "composite_departure": {
        // The composite's whole point: compute → fold → apply, so the ending
        // runs exactly once and the band still sees the contact that licensed it.
        const prevalidated = prevalidatedDepartBand(action.depart.candidate);
        if (floor !== null) applyFloor(floor, action.floor.span, true);
        applyTier2(action.depart, true, prevalidated);
        break;
      }
      case "tier2":
        applyTier2(action.entry, false, null);
        break;
    }
  }

  return { scene, commits, actions, drops };
}

import {
  adapterSupported,
  adapterUnavailable,
  affordanceEvidence,
  affordanceSubjectId,
  applySceneIntents,
  buildActionOutcome,
  chatAffectionateTargetLocationOf,
  chatContactTargetNounAlternation,
  contactSentenceEligible,
  CHAT_CONTACT_RESTRAINT_RE,
  CHAT_CONTACT_SOURCE_LOCATION,
  CHAT_GESTURE_CONTACT,
  commitContactResolution,
  contactActionOutcomeStatus,
  contactActionRequiresPermission,
  contactCommitExpectation,
  contactEventRef,
  contactParticipantIds,
  diag,
  effectiveCoverageAt,
  emptyEffectiveCoverageRead,
  endAllContacts,
  endContact,
  isAdapterSupported,
  resolveContactAttempt,
  sceneEventRef,
  sceneFact,
  sceneParticipant,
  sceneProximityFact,
  sceneProvenance,
  sceneProvenanceEvidence,
  sceneGeometryRead,
  sceneSupportId,
  sceneSupportRead,
  sceneSupportSurface,
  toUnitInterval,
  withoutAllScenePairRelations,
  withoutScenePairRelations,
  withSceneContacts,
  withSceneParticipant,
  withSceneSupportSurface,
  wornGarmentInstances,
  type AdapterRead,
  type AffordanceEvidence,
  type AffordanceStoryTime,
  type AffordanceSubjectId,
  type ChatContactGesture,
  type ChatEnvironment,
  type ChatGarmentStore,
  type CommittedContactOutcome,
  type CommittedContactRead,
  type ContactActionContext,
  type ContactActionIntent,
  type ContactActionKind,
  type ContactActorControlDecision,
  type ContactBodySurfaceRef,
  type ContactCommitOutcome,
  type ContactEndedCommit,
  type ContactEndReason,
  type ContactEventRef,
  type ContactInteractionPolicyRead,
  type ContactMaterialLayerRead,
  type ContactMaterialRead,
  type ContactPersistenceAcknowledgment,
  type ContactRejectionReason,
  type ContactRequirementCode,
  type ContactResolution,
  type ContactSurfaceRef,
  type ContactUnresolvedReason,
  type DiagnosticSink,
  type EffectiveCoverageBand,
  type EffectiveCoverageRead,
  type PhysicalActionOutcome,
  type SceneEventRef,
  type SceneMovementIntent,
  type SceneProximityBand,
  type SceneState,
  type SceneSupportRelation,
  type UnitInterval,
  type WornItemInput,
  type WornVisibility,
} from "@/contracts";
import { chatEvidenceSentences } from "@/lib/chat-input-evidence";
import { chatGarmentCoverageForCut } from "./chat-garment-affordances";

/**
 * The CHAT LANE's contact adapter — the affectionate integration proof
 * (romantic-contact-affordances.plan.md §"Continuation order" 1).
 *
 * Everything here is PURE and deterministic: a scene in, a player line in, a
 * seeded scene / a movement intent / a release's ends / a resolved attempt / an
 * action outcome out.
 * No IO, no clock, no model call. The lane's durable writes (the contact ledger,
 * the scenario's scene slot) belong to the pipeline, and the one ordering rule
 * this module cannot enforce for itself is stated where it is broken:
 * `chatContactActionOutcome` will not report `committed` without a persistence
 * acknowledgment, so a caller that skips the write gets silence.
 *
 * ## Five laws, and the failure each one exists to stop
 *
 * 1. **Only the PLAYER's own act produces anything.** The detectors read the
 *    player's own narration spans and match a first-person subject; a movement
 *    is committed as a `player`-origin `SceneMovementIntent` over the
 *    player-controlled participant, and the contact's actor control is READ from
 *    the scene's own control fact rather than asserted. The narrator never gains
 *    physical authority — narrator-mode input is excluded outright, and no
 *    detector can move or touch on an NPC's behalf.
 * 2. **A default is never a physical claim.** Seeding places a body, declares who
 *    controls it, and stands it on the floor. It never states a distance or an
 *    orientation: those are real claims about where two people are, and only a
 *    movement the player actually wrote may assert them. A scene nobody has moved
 *    in therefore answers `proximity_unknown`, the attempt resolves `unresolved`,
 *    and the narrator is told nothing — which is the correct output for a world
 *    that does not know where its bodies are.
 * 3. **Affectionate is never a relabeled romantic case** (owner constraint). The
 *    verb and target lexicons are ALLOW-lists of plainly affectionate contact,
 *    and a sentence carrying romantic, intimate, or forceful language is vetoed
 *    whole — a kiss beside a shoulder-touch is not an affectionate touch with
 *    decoration, it is a sentence this proof has no business committing.
 * 4. **No restraint, no pinning.** `trapped` mobility has no producer in the
 *    scene owner (spec §"Open design questions"), so the veto list closes the
 *    door on the scenarios that would need one rather than letting them resolve
 *    against a mobility model that cannot represent them.
 * 5. **Silence beats a guess.** Every gate below fails toward "no act detected".
 *    A hypothetical, a question, a negation, an ambiguous target, an unknown body
 *    part, a possessed destination ("her desk"), a wardrobe nobody enumerated:
 *    all of them produce nothing, because a contact this layer invented — or a
 *    bare shoulder it assumed — is worse than a contact it missed.
 *
 * The things that fail the OTHER way are the ENDS: a release
 * (`detectChatContactRelease` — the player's own hand coming back) and a
 * departure (`detectChatDeparture` — the player's whole body going somewhere
 * else). Both only ever END contacts, so refusing to read one leaves a durable
 * row claiming a hand that is no longer there; their gates are therefore the
 * shared ones minus the restraint veto (`endingSentences`), and their silence
 * rule applies to WHICH contacts end rather than to whether the sentence counts.
 *
 * A departure carries one claim beyond its ends — the distance it opened — and
 * THAT half obeys law 2 without exception: a band is written only for a pair the
 * scene already placed (or that an active contact proves was close), and never a
 * band nearer than the one already standing. Stepping back from somebody nobody
 * ever placed leaves the distance unknown, exactly as it was.
 *
 * ## The one thing here that is not about the player's body
 *
 * The proximity BAND LAWS (`departedBand`, `approachedBand`), the NPC movement
 * builder (`npcMovementSceneIntents`), the actor-control read
 * (`chatActorControl`), the material composer (`chatContactMaterialBetween`),
 * the NPC act builder (`chatNpcContactAct`) and the attempt resolver
 * (`resolveChatContactAttempt`) are all ACTOR-GENERIC, and the reply-scene
 * decision leg (`chat-npc-scene-execute.ts`) calls them for an NPC actor
 * (actor-control spec §"Resolution laws"). That is deliberate and it does not
 * weaken law 1: a band law is a property of a PAIR of bodies rather than of
 * whose turn it is, a control fact is read from the scene either way, and what
 * lies between two surfaces is a question about clothes rather than about turns.
 * Keeping one implementation is what stops the two lanes from drifting into
 * different distance, control, or material rules.
 *
 * What stays strictly player-only is every DETECTOR in this module — nothing
 * here reads an NPC's prose, and nothing here decides that an NPC moved or
 * touched. That decision belongs to the classifier's admitted candidates, which
 * arrive already gated.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

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

/** The scene's floor. One ground surface per conversation; seeded once. */
export const CHAT_SCENE_GROUND_SUPPORT = sceneSupportId("ground");

/**
 * Re-exported from the shared chat-contact vocabulary
 * (`contracts/turns/chat-contact-vocabulary.ts`), where the acting-surface
 * constant and the shared sentence gate moved so the NPC reply-scene evidence
 * gates (pure contracts) can read the SAME data. The frozen reply-side ending
 * floor (`chat-contact-reply.ts`) keeps importing `contactSentenceEligible`
 * from here, so its veto set is unchanged by the move.
 */
export { contactSentenceEligible, CHAT_CONTACT_SOURCE_LOCATION };

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
 * spans the whole roster (actor-control spec §"Resolution laws → Contact
 * start"), so two NPCs resting a hand on the same shoulder in one reply would
 * otherwise mint the identical action id — and an acknowledgment for one would
 * verify the other's write. The contact ID itself is unaffected either way: it
 * is derived from the surface pair and the start event, never from this id.
 */
export function chatContactActionId(eventRef: ContactEventRef, act: ChatContactActShape): string {
  return `${eventRef}#${act.actorSubject}:${act.targetSubject}:${act.targetLocationId}`;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/** One PRESENT roster character, as the detectors and the material adapter need them. */
export interface ChatContactRosterMember {
  readonly subjectId: AffordanceSubjectId;
  readonly name: string;
  readonly aliases: readonly string[];
  /**
   * Whether this conversation can say what lies between a hand and this body,
   * from `chatContactMaterialSource`. REQUIRED, and deliberately not defaulted:
   * a roster assembled without it would answer "bare skin" for every character
   * the wardrobe never enumerated, which is the one answer this lane may not
   * invent (see `chatContactMaterialSource`).
   */
  readonly material: ChatContactMaterialSource;
}

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

// ---------------------------------------------------------------------------
// Text gates
// ---------------------------------------------------------------------------

/**
 * The sentence split and the shared eligibility gates now live in the shared
 * chat-contact vocabulary (`contracts/turns/chat-contact-vocabulary.ts`) —
 * moved verbatim so the NPC reply-scene evidence gates read the SAME vetoes.
 * This module keeps only the composition that is player-line-specific.
 */

/**
 * The shared gates PLUS the restraint veto — the gate for anything that starts
 * or sustains a contact.
 *
 * The restraint list exists because `trapped` mobility has no producer (law 4),
 * so a contact framed as force is refused rather than resolved against a model
 * that cannot hold it. That argument is about contacts this lane would CREATE,
 * which is why the release scan below does not use this gate: see
 * `releaseSentences`.
 */
function contactCommitSentenceEligible(sentence: string): boolean {
  return contactSentenceEligible(sentence) && !CHAT_CONTACT_RESTRAINT_RE.test(sentence);
}

export interface ChatContactDetectionInput {
  /** The player's raw line this turn. */
  readonly message: string;
  /** Storyteller narration: excluded entirely — it is not the player's body. */
  readonly narratorInput: boolean;
  /** PRESENT roster members only. */
  readonly characters: readonly ChatContactRosterMember[];
}

/**
 * The sentences a detector may read.
 *
 * Ordinary player NARRATION only — narrower than the premise detector's span
 * rule, and for a different reason. A correction judges a CLAIM, and a claim can
 * be spoken; an act has to be performed. "I'll come over and sit with you" is a
 * plan the character may respond to, not a body that moved, so speech, thought,
 * OOC, comms, written, and styled spans all produce nothing here.
 *
 * Storyteller narration is excluded at the door by `narratorInput`: it is
 * authored story events, not the player's own body, and treating it as one would
 * be exactly the narrator-gains-physical-authority failure the scene owner
 * exists to prevent.
 */
function contactSentences(
  input: ChatContactDetectionInput,
  eligible: (sentence: string) => boolean = contactCommitSentenceEligible,
): readonly string[] {
  if (input.narratorInput) return [];
  const message = input.message.trim();
  if (message.length === 0) return [];
  const sentences: string[] = [];
  for (const { text } of chatEvidenceSentences(message, ["narration"])) {
    if (eligible(text)) sentences.push(text);
  }
  return sentences;
}

/**
 * The sentences an END may be read from: every shared gate, minus restraint.
 *
 * The restraint veto (law 4) refuses sentences whose framing this lane cannot
 * MODEL, and it is right to refuse to START a contact on one. An end starts
 * nothing — it removes a row — and the word it would veto on is usually the end
 * itself: "I pull my hand back" and "I pull away" are the plainest ways in
 * English to say these two things, and dropping them would leave durable
 * contacts the player explicitly ended. A stale contact that outlives the hand
 * is worse than an end this proof read from a forceful-sounding sentence, so the
 * veto is lifted for the ends and nowhere else. Nothing forceful can sneak a
 * contact in through this door: the lexicons below only match the player's own
 * hand leaving or their own body moving off, and their only power is to end.
 */
function endingSentences(input: ChatContactDetectionInput): readonly string[] {
  return contactSentences(input, contactSentenceEligible);
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/** Owner tokens that name somebody only the roster can disambiguate. */
const PRONOUN_OWNERS: ReadonlySet<string> = new Set(["you", "your", "her", "him", "his", "them", "their", "theirs"]);

/**
 * Who a written owner token names, or `null`.
 *
 * A NAME (or an authored alias) always resolves. A pronoun — `you`, `your`,
 * `her`, `him`, `their` — resolves ONLY when exactly one character is present,
 * because in a group it names somebody the sentence has not identified, and
 * picking one would be this layer choosing who got touched.
 */
function resolveContactTarget(
  owner: string,
  characters: readonly ChatContactRosterMember[],
): ChatContactRosterMember | null {
  const token = owner.trim().replace(/['’]s$/iu, "").toLowerCase();
  if (token.length === 0) return null;
  const named = characters.find(
    (member) =>
      member.name.trim().toLowerCase() === token ||
      member.aliases.some((alias) => alias.trim().toLowerCase() === token),
  );
  if (named !== undefined) return named;
  if (!PRONOUN_OWNERS.has(token)) return null;
  const sole = characters.length === 1 ? characters[0] : undefined;
  return sole ?? null;
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/** The player closing distance on a named-or-unambiguous roster member. */
export interface ChatApproach {
  readonly targetSubject: AffordanceSubjectId;
  readonly band: SceneProximityBand;
}

const APPROACH_VERBS =
  "walk|walks|walked|walking|step|steps|stepped|stepping|move|moves|moved|moving|cross|crosses|crossed|crossing" +
  "|come|comes|came|coming|go|goes|went|going|head|heads|headed|heading|slide|slides|slid|sliding" +
  "|sit|sits|sat|sitting|settle|settles|settled|settling|kneel|kneels|knelt|kneeling|scoot|scoots|scooted|scooting" +
  "|edge|edges|edged|edging|lean|leans|leaned|leaning|draw|draws|drew|drawing|shift|shifts|shifted|shifting";

/**
 * How the movement lands: an adjacency phrase that means "nothing has to move
 * for surfaces to meet" is `touching`; everything else is `close` — within arm's
 * length, which is what an approach to a person ordinarily achieves. Anything
 * vaguer than these prepositions is not read as movement at all.
 */
const APPROACH_ADJACENCY =
  "right next to|right beside|right up to|right up against|flush against|next to|beside|alongside" +
  "|closer to|close to|up to|over to|towards|toward|to";
const APPROACH_TOUCHING: ReadonlySet<string> = new Set([
  "right next to",
  "right beside",
  "right up to",
  "right up against",
  "flush against",
]);

/**
 * A first-person movement verb, at most two filler words, a destination
 * preposition, a person, and — zero-width — whether an ordinary word follows.
 *
 * The first-person subject is the guard rail: "she walks over to me" is an NPC's
 * movement and this detector must never produce one. The trailing lookahead is
 * the possessive guard's only input; it consumes nothing, so the scan for a
 * later clause still starts immediately after the destination token.
 */
const APPROACH_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:${APPROACH_VERBS})\\b[^.?!;:]{0,60}?\\b(${APPROACH_ADJACENCY})\\s+([\\p{L}][\\p{L}\\p{N}'’-]*)\\b(?=(\\s+[\\p{L}])?)`,
  "giu",
);

/**
 * The pronouns that can introduce a noun rather than BE one.
 *
 * `you`, `him`, `them` are absent because they are never determiners: "I walk
 * over to you and sit" names a person and must keep matching. These five can go
 * either way, and the word after them is what decides.
 */
const APPROACH_POSSESSIVE_PRONOUNS: ReadonlySet<string> = new Set(["your", "her", "his", "their", "its"]);

/**
 * Is this destination token a POSSESSOR rather than the person?
 *
 * "I walk over to her desk" and "I walk over to Wren's desk" are approaches to
 * FURNITURE, and the movement detector's one-token capture cannot see that on
 * its own: the possessive resolves to the person who owns the thing, and the
 * turn commits `close` proximity to a body nobody walked up to. A possessive
 * followed by another ordinary word is therefore refused. The departure
 * detector's "…from <X>" clause has the identical hazard in reverse ("I step
 * back from her desk" would end contacts with a woman the player never left),
 * and it asks the same question here.
 *
 * Two deliberate edges:
 *
 * - **Clause-final wins.** "I walk over to her." and "I walk over to Wren,
 *   smiling" are people — a comma, a full stop, or the end of the line means
 *   nothing was possessed, and both still match. Only whitespace-then-a-letter
 *   counts as "another word".
 * - **`Wren's side` is refused, and that is the conservative call.** A body part
 *   or a position ("her side", "his left") is a person as often as it is a
 *   thing, and this proof answers an ambiguous target with silence everywhere
 *   else. The cost is one missed approach; the alternative cost is a durable
 *   distance claim about a body the player walked past.
 */
function destinationIsPossessive(token: string, followedByWord: boolean): boolean {
  if (!followedByWord) return false;
  const lowered = token.trim().toLowerCase();
  return APPROACH_POSSESSIVE_PRONOUNS.has(lowered) || /['’]s$/u.test(lowered);
}

/**
 * The approach this ONE sentence states, or `null`.
 *
 * Split out because the departure detector asks it too: a sentence that names
 * somewhere to ARRIVE is an arrival, whatever else it also says about backing
 * off (`detectChatDeparture`).
 */
function approachInSentence(
  sentence: string,
  characters: readonly ChatContactRosterMember[],
): ChatApproach | null {
  // Every first-person clause in the sentence, not just the first: "I walk over to
  // the window, then I step closer to Wren" opens on a destination that names no
  // person, and stopping there would throw away the movement that happened.
  // `matchAll` clones the regex, so the module-level `lastIndex` is never shared.
  for (const match of sentence.matchAll(APPROACH_RE)) {
    const token = match[2] ?? "";
    // A possessed destination keeps SCANNING rather than ending the sentence:
    // "I walk over to her desk, then I step closer to Wren" still moves.
    if (destinationIsPossessive(token, (match[3] ?? "").length > 0)) continue;
    const target = resolveContactTarget(token, characters);
    if (target === null) continue;
    const adjacency = (match[1] ?? "").toLowerCase();
    return { targetSubject: target.subjectId, band: APPROACH_TOUCHING.has(adjacency) ? "touching" : "close" };
  }
  return null;
}

/**
 * The player's approach this turn, or `null`.
 *
 * First eligible sentence wins: two movements in one message is a beat this
 * proof does not model, and folding both would let a later sentence's distance
 * overwrite an earlier one on nothing better than array order.
 */
export function detectChatApproach(input: ChatContactDetectionInput): ChatApproach | null {
  for (const sentence of contactSentences(input)) {
    const approach = approachInSentence(sentence, input.characters);
    if (approach !== null) return approach;
  }
  return null;
}

/**
 * The approach as typed scene intents — proximity, then the player's own facing.
 *
 * BOTH are the mover's own facts, and both are needed. Proximity is the obvious
 * one. Facing is here because the reach rule consults orientation at every band
 * below `touching`, and a scene that cannot say which way the player is turned
 * answers `facing_unknown` — so an approach that set only a distance would
 * commit nothing. Crossing a room toward somebody IS turning toward them, and it
 * is a claim about the player's body, which is the one body a player intent may
 * move. The other person's orientation is never touched: which way SHE is facing
 * is hers, and this adapter has no authority over it.
 */
export function chatApproachSceneIntents(
  approach: ChatApproach,
  context: { readonly player: AffordanceSubjectId; readonly ref: SceneEventRef; readonly storyTime: AffordanceStoryTime },
): readonly SceneMovementIntent[] {
  const base = {
    subjectId: context.player,
    origin: "player" as const,
    ref: context.ref,
    storyTime: context.storyTime,
    evidence: [affordanceEvidence("adapter", "chat.contact.approach")],
  };
  return [
    {
      ...base,
      intentId: `${context.ref}:proximity:${approach.targetSubject}`,
      change: { kind: "set_proximity", otherId: approach.targetSubject, band: approach.band },
    },
    {
      ...base,
      intentId: `${context.ref}:facing:${approach.targetSubject}`,
      change: { kind: "set_facing", towardId: approach.targetSubject, facing: "toward" },
    },
  ];
}

// ---------------------------------------------------------------------------
// Departure — the player putting distance back
// ---------------------------------------------------------------------------

/**
 * The two bands a departure can state.
 *
 * `touching` and `close` are arrivals, and no sentence this detector reads can
 * produce one: moving away from somebody never ends nearer than `near`, which is
 * the vocabulary's "one small reposition away".
 */
export type ChatDepartureBand = Extract<SceneProximityBand, "near" | "distant">;

/** The player moving off — from a named person, or from everyone at once. */
export interface ChatDeparture {
  /** Whose company the sentence said the player left. `null` ⇒ everyone in the room. */
  readonly targetSubject: AffordanceSubjectId | null;
  readonly band: ChatDepartureBand;
}

/**
 * Band → how far it is, so a departure can only ever make a stated distance
 * WORSE.
 *
 * Spelled out rather than derived from `sceneProximityBands`' array order, for
 * the reason the height ladder's index table is: a reordering of the vocabulary
 * must not silently re-rank the world.
 */
const DEPARTURE_BAND_DISTANCE: Readonly<Record<SceneProximityBand, number>> = {
  touching: 0,
  close: 1,
  near: 2,
  distant: 3,
};

/**
 * "…back" — the one-step class.
 *
 * `take a step` is spelled out beside the bare verbs because "I take a step
 * back" is the commonest way to write this and its verb is `take`, which means
 * nothing at all on its own.
 */
const DEPARTURE_BACK_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:(?:take|takes|took|taking)\\s+(?:a|one)\\s+step` +
    `|step|steps|stepped|stepping|lean|leans|leaned|leaning)\\s+back\\b`,
  "iu",
);

/**
 * "…away" — the same body, going somewhere else.
 *
 * The direction word sits IMMEDIATELY after the verb, and that adjacency is what
 * implements the release/departure precedence (see `detectChatDeparture`): "I
 * pull away" is a body and matches; "I pull my hand away" puts two words in
 * between, matches nothing here, and is left to the release lexicon where it
 * belongs.
 */
const DEPARTURE_AWAY_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(step|steps|stepped|stepping|back|backs|backed|backing` +
    `|pull|pulls|pulled|pulling|move|moves|moved|moving|draw|draws|drew|drawing` +
    `|walk|walks|walked|walking)\\s+away\\b`,
  "iu",
);

/** Crossing the floor — the widest departure this lexicon reads. */
const DEPARTURE_ACROSS_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:step|steps|stepped|stepping|move|moves|moved|moving` +
    `|walk|walks|walked|walking)\\s+across\\s+the\\s+room\\b`,
  "iu",
);

/** A departure written as its own result rather than as a movement. */
const DEPARTURE_DISTANCE_RE =
  /\bi\s+(?:[\p{L}']+\s+){0,2}?(?:put|puts|putting)\s+(?:some\s+|a\s+little\s+|a\s+bit\s+of\s+)?distance\s+between\s+us\b/iu;

/** "…from her", "…from Wren" — who the sentence said the player moved off from. */
const DEPARTURE_FROM_RE = /\bfrom\s+(?:the\s+)?([\p{L}][\p{L}\p{N}'’-]*)\b(?=(\s+[\p{L}])?)/iu;

/**
 * How far this sentence put them, or `null` for a sentence that is not a
 * departure at all.
 *
 * The split is about what the writing says it took: a step, a lean, or a hand's
 * width of distance is `near` — one small reposition away, and the reach rule
 * will ask for that reposition back. WALKING is the other class, and so is
 * crossing the room: both say the space between them is now a space that has to
 * be crossed, which is `distant`. "I move away" stays with the step class,
 * because a bare "move" is the smallest claim the sentence could be making and
 * this proof takes the smaller reading everywhere else too.
 */
function departureBand(sentence: string): ChatDepartureBand | null {
  if (DEPARTURE_ACROSS_RE.test(sentence)) return "distant";
  const away = DEPARTURE_AWAY_RE.exec(sentence);
  if (away !== null) return (away[1] ?? "").toLowerCase().startsWith("walk") ? "distant" : "near";
  if (DEPARTURE_BACK_RE.test(sentence) || DEPARTURE_DISTANCE_RE.test(sentence)) return "near";
  return null;
}

/**
 * The player's departure this turn, or `null`.
 *
 * The approach detector's inverse, and conservative in the same three places.
 *
 * - **An arrival outranks a departure, within one sentence.** "I walk across the
 *   room to her" and "I lean back toward Wren" both carry a destination that
 *   names a person, and a sentence that says where the player ENDED UP is read
 *   as that and nothing else — otherwise the turn would end her contacts on the
 *   way to standing next to her. Across SENTENCES the two compose in written
 *   order, which is what makes "I step back. I walk over to Wren." mean what it
 *   says (see `planChatContactTurn`).
 * - **A named target that does not resolve produces NOTHING**, exactly as a
 *   release's does: the sentence said what it moved away from, and substituting
 *   "everyone" would be this layer choosing whose hand came free. That covers "I
 *   step back from the desk", an ambiguous "her" in a group, and — through the
 *   shared possessive guard — "I step back from her desk".
 * - **A hand is not a body** — the release/departure ruling, and the one place
 *   these two lexicons could have overlapped. The direction word must follow the
 *   verb IMMEDIATELY, so "I pull my hand back" / "I draw my hand away" are
 *   RELEASES (that hand's contacts end `withdrawn`, and no distance is claimed)
 *   and never departures. A bare "I pull away" is the opposite: a whole body
 *   moved, so it is a DEPARTURE — every player-involved contact ends
 *   `separated`, and the distance is stated. It is deliberately NOT also added
 *   to the release lexicon: the departure already ends the same contacts and
 *   more, so a second producer would compete over nothing but the recorded
 *   reason, and `separated` is the truer one for a body that moved — nobody took
 *   a hand back, the distance stopped allowing the touch. A message that says
 *   both in its own sentences ("I pull my hand back. I step away.") gets both,
 *   release first, each with its own reason.
 *
 * An unnamed departure ("I step back.") is a departure from everyone: the player
 * moved, and every body in the room is further away than it was.
 */
export function detectChatDeparture(input: ChatContactDetectionInput): ChatDeparture | null {
  for (const sentence of endingSentences(input)) {
    const band = departureBand(sentence);
    if (band === null) continue;
    if (approachInSentence(sentence, input.characters) !== null) continue;
    const from = DEPARTURE_FROM_RE.exec(sentence);
    if (from === null) return { targetSubject: null, band };
    if (destinationIsPossessive(from[1] ?? "", (from[2] ?? "").length > 0)) continue;
    const target = resolveContactTarget(from[1] ?? "", input.characters);
    if (target === null) continue;
    return { targetSubject: target.subjectId, band };
  }
  return null;
}

/** Does an active contact already prove these two are within touching distance? */
function contactProvesCloseness(scene: SceneState, left: AffordanceSubjectId, right: AffordanceSubjectId): boolean {
  return scene.contacts.contacts.some((contact) => {
    const participants = contactParticipantIds(contact.source, contact.target);
    return participants.includes(left) && participants.includes(right);
  });
}

/**
 * The band a departure may state about one pair, or `null` for "say nothing".
 *
 * ACTOR-GENERIC: `mover` is whichever body the sentence moved — the player on
 * the player leg, the NPC actor on the reply-scene leg (actor-control spec
 * §"Resolution laws → Movement": "`departedBand` mirrors the player helper").
 * The law is a property of the PAIR, not of whose turn it is, and proximity
 * facts are pair-symmetric, so one helper serves both and neither lane can
 * quietly acquire a different distance rule.
 *
 * **Never invent a distance** (law 2). Two sources can license the claim and
 * nothing else can:
 *
 * 1. the pair already HAS a proximity fact — then stepping back is an honest
 *    edit of a distance somebody stated, and the new band is written only when
 *    it is genuinely farther. A `distant` pair does not become `near` because
 *    the mover took a step backwards; a departure can only widen.
 * 2. an active contact between them — a hand resting on a shoulder is proof
 *    they were within reach, whether or not any movement said so, so the
 *    distance it opens is a real claim rather than a guess.
 *
 * A pair with neither stays UNKNOWN. Stepping back from somebody the scene never
 * placed tells us a body moved; it does not tell us how far apart they are
 * now, and the scene's answer to "can this hand reach that shoulder" must stay
 * `proximity_unknown` rather than become a number this module made up.
 *
 * FACING is deliberately untouched. Stepping back is not turning away — an
 * approach turns toward, because crossing a room toward somebody IS facing
 * them, but a body that backs off is usually still looking. Only an explicit
 * turn should write that fact, and neither the player lexicon nor the NPC
 * congruence gate reads a departure as one.
 */
export function departedBand(
  scene: SceneState,
  mover: AffordanceSubjectId,
  otherId: AffordanceSubjectId,
  band: ChatDepartureBand,
): SceneProximityBand | null {
  const stated = sceneProximityFact(scene, mover, otherId)?.value;
  if (stated === undefined) return contactProvesCloseness(scene, mover, otherId) ? band : null;
  return DEPARTURE_BAND_DISTANCE[band] > DEPARTURE_BAND_DISTANCE[stated] ? band : null;
}

/**
 * The mirror: the band an APPROACH may state about one pair, or `null`.
 *
 * The departure helper's inverse, and the same law read the other way round
 * (actor-control spec §"Resolution laws → Movement"):
 *
 * 1. **A first fact may be created.** Unlike a departure, an approach that
 *    lands on an unplaced pair is not a guess — the admitted evidence is the
 *    explicit licence ("she crosses the room and stops right beside you" states
 *    where she ended up), and the congruence gate has already proven the band.
 *    A pair nobody placed is exactly the pair an arrival is about.
 * 2. **A standing fact is replaced only by a STRICTLY NEARER band.** An
 *    approach is a claim about closing distance; letting it widen one would be
 *    a departure wearing the wrong verb.
 * 3. **An active contact between the pair counts as effective `touching`** —
 *    the nearest band there is — so an approach can never overwrite a live
 *    touch with `close`. A hand on a shoulder is stronger evidence of distance
 *    than any sentence about walking over, and demoting it would tell the reach
 *    read that a contact it is holding has moved out of range.
 *
 * Equal-or-nearer standing distance is a NO-OP (`null`), which the caller reads
 * as "construct no intent at all" rather than handing `commitSceneIntent` a
 * restatement: the ordering law would answer `already_asserted` for an equal
 * band, but it has no opinion at all about a NEARER one, so the monotonic law
 * has to be decided here, before an intent exists.
 */
export function approachedBand(
  scene: SceneState,
  mover: AffordanceSubjectId,
  otherId: AffordanceSubjectId,
  band: SceneProximityBand,
): SceneProximityBand | null {
  const stated = sceneProximityFact(scene, mover, otherId)?.value;
  const effective = contactProvesCloseness(scene, mover, otherId) ? "touching" : stated;
  if (effective === undefined) return band;
  return DEPARTURE_BAND_DISTANCE[band] < DEPARTURE_BAND_DISTANCE[effective] ? band : null;
}

/**
 * One NPC actor's movement as typed scene intents — the reply-scene leg's
 * builder, and the counterpart of `chatApproachSceneIntents` on the player leg.
 *
 * Three differences from the player builder, each a law rather than a detail:
 *
 * - **`origin` is `npc`** and `subjectId` is the NPC ACTOR. The actor-control
 *   law (`commitSceneIntent`) admits an NPC-origin intent only over an
 *   `npc_controlled` body, so a proposal naming the player as the mover is
 *   refused by the scene owner rather than by a check here.
 * - **The band is already decided.** `approachedBand` / `departedBand` ran
 *   against the scene first and answered `null` for a no-op; `commitSceneIntent`
 *   does NOT enforce those monotonic placement laws (it only refuses an exact
 *   restatement and a stale write), so an intent must never be constructed for
 *   a band the helpers refused.
 * - **Facing rides only on an approach that PROPOSED it.** The player builder
 *   always turns the player toward the target because crossing a room toward
 *   somebody is turning toward them; on this side the congruence gate has to
 *   have proven `facing: toward` independently, because backing into place
 *   changes proximity without changing where a body is looking. A departure
 *   never writes facing at all.
 */
export function npcMovementSceneIntents(input: {
  readonly kind: "approach" | "depart";
  readonly actor: AffordanceSubjectId;
  readonly counterpart: AffordanceSubjectId;
  /** The band the helpers licensed — never the candidate's raw proposal. */
  readonly band: SceneProximityBand;
  /** `toward` only when the candidate proposed it AND congruence proved it; ignored for `depart`. */
  readonly facing: "toward" | null;
  readonly ref: SceneEventRef;
  readonly storyTime: AffordanceStoryTime;
}): readonly SceneMovementIntent[] {
  const base = {
    subjectId: input.actor,
    origin: "npc" as const,
    ref: input.ref,
    storyTime: input.storyTime,
    evidence: [affordanceEvidence("adapter", `chat.contact.npc_${input.kind}`)],
  };
  const intents: SceneMovementIntent[] = [
    {
      ...base,
      // The actor is part of the id because one reply event ref covers the whole
      // roster's movements: two NPCs approaching the player in one reply must not
      // collide on an intent id.
      intentId: `${input.ref}:npc:${input.actor}:proximity:${input.counterpart}`,
      change: { kind: "set_proximity", otherId: input.counterpart, band: input.band },
    },
  ];
  if (input.kind === "approach" && input.facing === "toward") {
    intents.push({
      ...base,
      intentId: `${input.ref}:npc:${input.actor}:facing:${input.counterpart}`,
      change: { kind: "set_facing", towardId: input.counterpart, facing: "toward" },
    });
  }
  return intents;
}

/**
 * The departure as typed scene intents — one proximity claim per pair it may
 * make one about, and never anything else.
 *
 * Read against the scene as it stood BEFORE the ends are folded, because an
 * active contact is one of the two things that license the claim at all
 * (`departedBand`) and ending it first would throw that licence away.
 */
export function chatDepartureSceneIntents(
  departure: ChatDeparture,
  context: {
    readonly scene: SceneState;
    /** PRESENT roster members — who "everyone" means for an unnamed departure. */
    readonly characters: readonly AffordanceSubjectId[];
    readonly player: AffordanceSubjectId;
    readonly ref: SceneEventRef;
    readonly storyTime: AffordanceStoryTime;
  },
): readonly SceneMovementIntent[] {
  const targets = departure.targetSubject === null ? context.characters : [departure.targetSubject];
  const intents: SceneMovementIntent[] = [];
  for (const otherId of targets) {
    const band = departedBand(context.scene, context.player, otherId, departure.band);
    if (band === null) continue;
    intents.push({
      intentId: `${context.ref}:departure:${otherId}`,
      subjectId: context.player,
      origin: "player",
      change: { kind: "set_proximity", otherId, band },
      ref: context.ref,
      storyTime: context.storyTime,
      evidence: [affordanceEvidence("adapter", "chat.contact.departure")],
    });
  }
  return intents;
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
 * `chatNpcContactAct` fills it with the NPC an admitted `start` candidate named
 * (actor-control spec §"Resolution laws → Contact start"). Nothing downstream of
 * this shape asks whose turn it is — `resolveChatContactAttempt` reads the
 * scene's own control fact for whichever body is acting.
 */
export interface ChatContactAct extends ChatContactActShape {
  readonly actionId: string;
  readonly sourceLocationId: string;
  readonly actionKind: "affectionate";
  readonly gesture: ChatContactGesture;
}

/**
 * The target lexicon (written noun → body-registry location id) and its
 * longest-first regex alternation moved to the shared vocabulary
 * (`chatAffectionateTargetLocationOf` / `chatContactTargetNounAlternation`),
 * so the classifier schema and the evidence verifiers can never accept a
 * surface this detector cannot produce.
 */
const CONTACT_OWNER = "your|her|his|their|[\\p{L}][\\p{L}\\p{N}'’-]*['’]s";

/** "I rest my hand on your shoulder" — the hand is the object, the body part the destination. */
const CONTACT_PLACE_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(rest|rests|rested|resting|place|places|placed|placing|put|puts|putting` +
    `|lay|lays|laid|laying|set|sets|setting|settle|settles|settled|settling)\\s+` +
    `(?:my|a|one|the)\\s+(?:hand|hands|palm)\\s+(?:on|onto|against|over|to)\\s+` +
    `(${CONTACT_OWNER})\\s+(${chatContactTargetNounAlternation})\\b`,
  "iu",
);

/** "I pat your head" / "I squeeze your hand" — the body part is the direct object. */
const CONTACT_DIRECT_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(pat|pats|patted|patting|squeeze|squeezes|squeezed|squeezing)\\s+` +
    `(${CONTACT_OWNER})\\s+(${chatContactTargetNounAlternation})\\b`,
  "iu",
);

function gestureOf(verb: string): ChatContactGesture {
  const stem = verb.toLowerCase();
  if (stem.startsWith("pat")) return "pat";
  if (stem.startsWith("squeez")) return "squeeze";
  return "rest";
}

/**
 * The player's affectionate touch this turn, or `null`.
 *
 * The source surface is always `hands`: the lexicon only matches a hand or a
 * palm, and the finer question of which fingers is one nobody stated. First
 * eligible sentence wins, for the reason the approach detector's does — two
 * contacts in one message is a beat this proof does not model.
 */
export function detectChatAffectionateTouch(
  input: ChatContactDetectionInput & { readonly eventRef: ContactEventRef },
): ChatContactAct | null {
  for (const sentence of contactSentences(input)) {
    const match = CONTACT_PLACE_RE.exec(sentence) ?? CONTACT_DIRECT_RE.exec(sentence);
    if (match === null) continue;
    const target = resolveContactTarget(match[2] ?? "", input.characters);
    if (target === null) continue;
    const locationId = chatAffectionateTargetLocationOf(match[3] ?? "");
    if (locationId === undefined) continue;
    const shape: ChatContactActShape = {
      actorSubject: CHAT_CONTACT_PLAYER_SUBJECT,
      targetSubject: target.subjectId,
      targetLocationId: locationId,
    };
    return {
      ...shape,
      actionId: chatContactActionId(input.eventRef, shape),
      sourceLocationId: CHAT_CONTACT_SOURCE_LOCATION,
      actionKind: "affectionate",
      gesture: gestureOf(match[1] ?? ""),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Release — the player taking their own hand back
// ---------------------------------------------------------------------------

/** The player ending contact. `targetSubject: null` ⇒ every hand they have on somebody. */
export interface ChatContactRelease {
  /** Whose contacts this ends, when the sentence named one. */
  readonly targetSubject: AffordanceSubjectId | null;
}

const RELEASE_HAND = "(?:my|the)\\s+(?:hand|hands|palm)";
/** Verbs that need a direction word after the hand: "pull my hand BACK". */
const RELEASE_MOVED_VERBS =
  "pull|pulls|pulled|pulling|draw|draws|drew|drawing|take|takes|took|taking|move|moves|moved|moving";
/** Verbs that already mean "off it" on their own: "I withdraw my hand". */
const RELEASE_LIFTED_VERBS =
  "lift|lifts|lifted|lifting|remove|removes|removed|removing|withdraw|withdraws|withdrew|withdrawing" +
  "|drop|drops|dropped|dropping";

const RELEASE_RES: readonly RegExp[] = [
  new RegExp(
    `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:${RELEASE_MOVED_VERBS})\\s+${RELEASE_HAND}\\s+(?:back|away|off)\\b`,
    "iu",
  ),
  // The lookahead is what keeps "I drop my hand onto your shoulder" out: those
  // verbs mean "off it" only when no destination follows, and a placement read as
  // a release would end a contact the sentence was busy making.
  new RegExp(
    `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:${RELEASE_LIFTED_VERBS})\\s+${RELEASE_HAND}\\b(?!\\s+(?:on|onto|against|over)\\b)`,
    "iu",
  ),
  new RegExp(`\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:let|lets|letting)\\s+go\\b`, "iu"),
];

/** "…of her hand", "…from Wren's shoulder", "…off the railing" — who or what was let go of. */
const RELEASE_OF_RE = /\b(?:of|from|off(?:\s+of)?)\s+(?:the\s+)?([\p{L}][\p{L}\p{N}'’-]*)\b/iu;

/**
 * The player's release this turn, or `null`.
 *
 * A NAMED target narrows the ends to that person; an unnamed one ("I pull my
 * hand back") ends every contact the player's hand is making. A target that is
 * named but does NOT resolve — "I let go of the railing", or an ambiguous "her"
 * in a group — produces no release at all rather than falling back to ending
 * everything: the sentence said which thing it let go of, and this layer is not
 * entitled to substitute a different one.
 */
export function detectChatContactRelease(input: ChatContactDetectionInput): ChatContactRelease | null {
  for (const sentence of endingSentences(input)) {
    if (!RELEASE_RES.some((pattern) => pattern.test(sentence))) continue;
    const owner = RELEASE_OF_RE.exec(sentence);
    if (owner === null) return { targetSubject: null };
    const target = resolveContactTarget(owner[1] ?? "", input.characters);
    if (target === null) continue;
    return { targetSubject: target.subjectId };
  }
  return null;
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

// ---------------------------------------------------------------------------
// Material between
// ---------------------------------------------------------------------------

/**
 * How much each channel a covered surface lets through, per coverage band.
 *
 * **Minimal by declaration.** The wardrobe owns real material terms — weave,
 * thickness, saturation, friction — and none of them are projected into the
 * contact core yet; the only wardrobe fact this proof consults is the captured
 * effective-coverage BAND, which was derived for visibility rather than for
 * touch. So these numbers are carried, not decided upon: nothing in this slice
 * reads them. The resolution turns on `layers.length > 0` and the intent's
 * `any_material` access, and the narrator line says only that there is cloth in
 * between. A channel-aware registration is explicitly the LAST item in the
 * continuation order, and it replaces this table rather than tuning it.
 */
const COVERAGE_TRANSMISSION: Readonly<
  Record<EffectiveCoverageBand, { readonly tactile: number; readonly thermal: number; readonly visible: boolean }>
> = {
  opaque: { tactile: 6_000, thermal: 4_000, visible: false },
  hinted: { tactile: 8_000, thermal: 6_000, visible: true },
  exposed: { tactile: 9_000, thermal: 8_000, visible: true },
};

/**
 * Whether this conversation can say what is on a given body — and if so, what.
 *
 * `supported` is an ANSWER (layers where the wardrobe covers, bare where it does
 * not); `unavailable` means nobody in this lane knows, and the resolver turns
 * that into `unresolved` — silence — rather than a guess. The adapter result law
 * is reused verbatim rather than restated as a bespoke union: this is exactly
 * one lane input as the adapter found it.
 */
export type ChatContactMaterialSource = AdapterRead<EffectiveCoverageRead>;

/**
 * Where a roster member's material answer comes from, resolved ONCE per member.
 *
 * The chat lane has three genuinely different wardrobe situations, and only one
 * of them is "bare":
 *
 * 1. **This cut modelled the wardrobe into coverage** — the caller derived an
 *    effective-coverage read from the CURRENT exchange's resolved wardrobe
 *    (`chatGarmentCoverageForCut`, or the affordance read's own capture when one
 *    was taken this turn). That read IS the answer: entries where something
 *    covers, nothing where it does not. A read with no entries is a real
 *    "nothing over that surface", not an absence.
 * 2. **The body is dressed in clothes nothing modelled** — worn garment
 *    instances the coverage stages could not run over, or the legacy free-text
 *    path (`ChatState.outfit` / `wornItemIds` with no materialized instances),
 *    where the look lives in a phrase the narrator imagined. Something IS
 *    between the hand and the skin and this lane cannot name it, so the
 *    material is **unavailable** and the attempt resolves to silence.
 * 3. **The wardrobe says nothing is worn** — no modelled coverage, no
 *    instances, no worn ids, no free-text look. Then `[]` is the wardrobe's own
 *    answer and the touch lands on skin.
 *
 * Case 2 is the correction this function exists for. Reading an absent answer as
 * `[]` made "we never staged a wardrobe" indistinguishable from "she is bare",
 * and a committed contact then told the narrator it had skin under its hand —
 * a positive physical claim nothing in the conversation supports. Silence costs
 * one beat; that claim costs the fiction's clothes.
 *
 * **The persisted capture (`ChatGarmentStore.coverage`) is deliberately NOT
 * consulted.** It lands at the PREVIOUS exchange's settle, which is the settle
 * race: a touch sent before the prior turn's post-stream legs finished read "no
 * capture yet" for a body whose wardrobe this very turn had already resolved —
 * and, the mirror failure, a capture from an earlier cut could describe garments
 * the current wardrobe no longer wears. The caller derives `coverage` from the
 * current cut and hands it in; when that derivation says `null`, an older stored
 * capture is not a substitute for it.
 */
export function chatContactMaterialSource(input: {
  /**
   * The CURRENT exchange's derived coverage for this actor, or `null` when this
   * cut could not model their wardrobe into coverage.
   */
  readonly coverage: EffectiveCoverageRead | null;
  readonly store: ChatGarmentStore;
  readonly actorId: string;
  /** `ChatState.outfit` — the free-text look, which applies when nothing is materialized. */
  readonly freeTextOutfit: string;
  /** `ChatState.wornItemIds` — structured ids that may predate materialization. */
  readonly wornItemIds?: readonly string[];
}): ChatContactMaterialSource {
  if (input.coverage !== null) {
    return adapterSupported(input.coverage, [affordanceEvidence("coverage", `wardrobe:${input.actorId}`)]);
  }
  const dressed =
    wornGarmentInstances(input.store, input.actorId).length > 0 ||
    (input.wornItemIds?.length ?? 0) > 0 ||
    input.freeTextOutfit.trim().length > 0;
  return dressed ? adapterUnavailable : adapterSupported(emptyEffectiveCoverageRead());
}

/** The diagnostic a failed current-cut coverage derivation files. */
export const CHAT_CONTACT_COVERAGE_DERIVE_FAILED = "chat_contact.coverage.derive_failed";

/**
 * One body's material answer AT THE CUT THE CALLER IS STANDING IN — the whole
 * derivation, fenced, shared by both legs that need it.
 *
 * The pre-prompt player leg derives it from the exchange's resolved wardrobes;
 * the reply-scene decision leg derives it again from the POST-settle scenario
 * (actor-control spec §"Authoritative post-settle cut": "current garment store
 * and per-actor coverage"). Those are two different cuts and must stay two
 * different reads — but they are the SAME derivation, and two copies of it is how
 * one leg quietly acquires a different answer to "is this body dressed in
 * something nobody modelled".
 *
 * `coverage` rides out beside the material because settlement persists the exact
 * object the resolver consumed rather than recomputing one, and because a caller
 * that took a capture this turn hands it back in as `captured` so both consumers
 * share one object.
 *
 * Fenced (docs/resilience.md §2): a derivation that throws degrades to "this cut
 * could not model the wardrobe", which the three-way law turns into
 * `unavailable` for a dressed body — silence with a diagnostic, never a stale
 * capture and never bare skin.
 */
export function chatContactMaterialAtCut(input: {
  readonly store: ChatGarmentStore;
  readonly actorId: string;
  /** The resolved wardrobe's coverage rows; absent ⇒ the wardrobe could not be read at all. */
  readonly worn?: readonly WornItemInput[];
  readonly visibility?: Readonly<Record<string, WornVisibility>>;
  readonly environment: ChatEnvironment;
  readonly clockMinutes: number;
  /** A read this turn already took for this actor — reused VERBATIM when present. */
  readonly captured?: EffectiveCoverageRead | null;
  /** `ChatState.outfit` / `ChatPlayerState.overlay` — the free-text look. */
  readonly freeTextOutfit: string;
  /** The structured worn ids, which may predate materialization. */
  readonly wornItemIds?: readonly string[];
  readonly sink?: DiagnosticSink;
}): { readonly coverage: EffectiveCoverageRead | null; readonly material: ChatContactMaterialSource } {
  let coverage: EffectiveCoverageRead | null = input.captured ?? null;
  if (coverage === null) {
    try {
      coverage = chatGarmentCoverageForCut({
        store: input.store,
        actorId: input.actorId,
        ...(input.worn === undefined ? {} : { worn: input.worn }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        environment: input.environment,
        clockMinutes: input.clockMinutes,
      });
    } catch (error) {
      input.sink?.push(
        diag(
          "warn",
          CHAT_CONTACT_COVERAGE_DERIVE_FAILED,
          "current-cut coverage derivation failed; this body's material reads unavailable",
          {
            path: "chat_contact",
            context: { actorId: input.actorId, error: error instanceof Error ? error.message : String(error) },
          },
        ),
      );
      coverage = null;
    }
  }
  return {
    coverage,
    material: chatContactMaterialSource({
      coverage,
      store: input.store,
      actorId: input.actorId,
      freeTextOutfit: input.freeTextOutfit,
      ...(input.wornItemIds === undefined ? {} : { wornItemIds: input.wornItemIds }),
    }),
  };
}

/**
 * What lies between the player's hand and the target surface, given an answer.
 *
 * A location NO worn garment reaches has no coverage entry, and that is bare
 * skin — the wardrobe's own answer, not something invented here. An entry in ANY
 * band is one interposed layer: `exposed` means the cover stopped CONCEALING,
 * which is a statement about sight, and the fabric is still there to touch.
 *
 * **Minimal, not wrong.** Only the BAND is consulted; the wardrobe's real
 * material terms (weave, thickness, friction) are not projected into the contact
 * core yet, so the numbers below are carried rather than decided upon. What this
 * function may never be handed is an ABSENCE — that case belongs to
 * `chatContactMaterialSource`, which reports it as `unavailable` instead.
 */
export function chatContactMaterialLayers(
  coverage: EffectiveCoverageRead | undefined,
  locationId: string,
): readonly ContactMaterialLayerRead[] {
  const band = effectiveCoverageAt(coverage, locationId);
  if (band === undefined) return [];
  const entry = coverage?.entries.find((row) => row.locationId === locationId);
  const transmission = COVERAGE_TRANSMISSION[band];
  const tactile: UnitInterval = toUnitInterval(transmission.tactile);
  return [
    {
      layerId: entry?.evidence[0]?.regionId ?? `coverage:${locationId}`,
      order: 0,
      tactileTransmission: tactile,
      shapeTransmission: tactile,
      thermalTransmission: toUnitInterval(transmission.thermal),
      moistureTransmission: toUnitInterval(0),
      scentTransmission: toUnitInterval(transmission.thermal),
      visibleThrough: transmission.visible,
      evidence: [affordanceEvidence("coverage", `coverage:${locationId}`, band)],
    },
  ];
}

/**
 * One participant's contribution to what lies between two surfaces: whose
 * wardrobe answer, over which of their own locations.
 *
 * `source` is the ACTING surface — the hand doing the touching, and whatever is
 * over it (a glove). `target` is the surface being touched. The distinction is
 * carried rather than inferred because it decides both the stack ORDER (a glove
 * is nearer the hand than her sleeve is) and the layer's identity: two hands
 * meeting produce two `hands` coverage reads, and un-prefixed ids would collide
 * into one layer that claims to be both.
 */
export interface ChatContactMaterialSide {
  readonly side: "source" | "target";
  /** That participant's answer, from `chatContactMaterialSource`. */
  readonly material: ChatContactMaterialSource;
  /** The location on THAT participant's own body. */
  readonly locationId: string;
}

/**
 * What lies between the two surfaces, composed from every side this lane can
 * read (actor-control spec §"Resolution laws → Contact start": "material is
 * resolved from both sides … compose the NPC-hand coverage (gloves, source
 * first) with target-surface coverage (target garments after it)").
 *
 * **One unreadable side makes the whole read unavailable.** A hand whose glove
 * nobody modelled is exactly as unknown as a shoulder whose blouse nobody
 * modelled: in either case the lane cannot say what the touch lands through, and
 * `chatContactMaterialSource`'s three-way law already decided which of "modelled",
 * "dressed but unmodellable", and "genuinely bare" each side is. `unavailable`
 * rides out of here untouched, and the resolver's own material gate turns it into
 * `unresolved` — silence — with its own diagnostic. Composing the readable side
 * alone would be worse than silence: it would state a material the other body's
 * clothes may contradict.
 *
 * Stack order is the ARRAY order, with `order` renumbered across sides so the
 * composed list is one continuous stack rather than two stacks that both start at
 * zero. The player leg passes one side (the target's) and is unchanged by the
 * generalization beyond its layer ids gaining that side's prefix.
 */
export function chatContactMaterialBetween(
  sides: readonly ChatContactMaterialSide[],
): AdapterRead<ContactMaterialRead> {
  const layers: ContactMaterialLayerRead[] = [];
  for (const side of sides) {
    if (!isAdapterSupported(side.material)) return adapterUnavailable;
    for (const layer of chatContactMaterialLayers(side.material.value, side.locationId)) {
      layers.push({ ...layer, layerId: `${side.side}:${layer.layerId}`, order: layers.length });
    }
  }
  const evidence = layers.flatMap((layer) => [...layer.evidence]);
  return adapterSupported({ layers, evidence }, evidence);
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
 * ACTOR-GENERIC, with the origin as an argument rather than a second copy
 * (actor-control spec §"Resolution laws → Contact start": "actor control is read
 * from the scene and is allowed only for `npc_controlled`"). Two copies of this
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
 * (`CHAT_ROMANTIC_PERMISSION` — romantic-contact-affordances.spec.permission.md
 * §"Resolver adapter"). Supplied by the pipeline ONLY when the flag is on;
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
 * for an NPC-origin start (actor-control spec §"Resolution laws → Contact
 * start": "target agencies stay empty because only the NPC's own hand moves"),
 * which is why one resolver serves both legs.
 */

/**
 * A permission-requiring kind is the exception when the pipeline wires a real
 * `permissionPolicy` source: the exact directional owner answer replaces the
 * neutral stub. Permission-neutral kinds and flag-off attempts keep the stub.
 */

/**
 * One admitted NPC `start` candidate as an act — the reply-scene leg's builder,
 * and the counterpart of `detectChatAffectionateTouch` on the player leg
 * (actor-control spec §"Resolution laws → Contact start").
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
  const gesture = CHAT_GESTURE_CONTACT[act.gesture];

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
          evidence: [affordanceEvidence("adapter", "chat.contact.policy", "affectionate_permission_neutral")],
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

  const act = detectChatAffectionateTouch({ ...detection, eventRef: input.eventRef });
  if (act === null) return { scene, act: null, resolution: null, commit: null, ended };

  // A target with no roster entry cannot happen (the act's subject came FROM the
  // roster), and if it ever did, `unavailable` is the honest read of a body this
  // turn knows nothing about.
  //
  // ONE-SIDED on purpose: the player's own hand contributes no layer here. This
  // leg has never modelled the player's wardrobe into coverage, and reading their
  // side would turn every touch by an unmodellable player into silence — a
  // behavior change to shipped authority that the actor-control work has no
  // business making. The reply-scene leg reads both sides because it must
  // (spec §"Resolution laws → Contact start"), through the same composer.
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

/**
 * The acknowledgment a lane builds AFTER its durable write returned.
 *
 * It names this action's own commit, so `contactActionOutcomeStatus` can prove
 * the write it is being told about is the write this attempt made — a stale
 * reply from an earlier turn on the same contact, or the write that ENDED it,
 * both fail the comparison and produce silence.
 *
 * A `contact_continued` fold writes no row by design (the contact is unchanged
 * and already durable from the start event that created it), so acknowledging it
 * is correct rather than generous: what the narrator is told is that this
 * contact is current truth, and it is.
 */
export function chatContactAcknowledgment(input: {
  readonly commit: CommittedContactOutcome;
  readonly eventRef: ContactEventRef;
  readonly actionId: string;
}): ContactPersistenceAcknowledgment {
  return {
    kind: "persisted",
    contactId: input.commit.contact.contactId,
    commitKind: input.commit.commit.kind,
    eventRef: input.eventRef,
    actionId: input.actionId,
  };
}

// ---------------------------------------------------------------------------
// The result vocabulary
// ---------------------------------------------------------------------------

/** What a wordable result code is ABOUT, so the renderer can build one sentence from several. */
export type ChatContactPhraseKind = "gesture" | "locus" | "material" | "blocked" | "requirement";

export interface ChatContactPhrase {
  readonly kind: ChatContactPhraseKind;
  readonly phrase: string;
}

function locusCode(locationId: string): string {
  return `contact.locus.${locationId}`;
}

/**
 * Code → the phrase the prompt uses, or absent for a code this lane does not
 * word.
 *
 * Deliberately the same shape as the hair lexicon the constraint renderer reads:
 * codes are domain-owned and opaque to the guidance layer, the renderer words
 * what it can, and a code with no entry costs a clause rather than a line. The
 * unresolved codes have no entries at all — an unresolved outcome is SILENCE by
 * contract, so there is nothing for them to say.
 */
const CHAT_CONTACT_LEXICON: Readonly<Record<string, ChatContactPhrase>> = {
  // The gesture, as a present-tense verb phrase carrying its own preposition.
  "contact.gesture.rest": { kind: "gesture", phrase: "rests on" },
  "contact.gesture.pat": { kind: "gesture", phrase: "pats" },
  "contact.gesture.squeeze": { kind: "gesture", phrase: "closes lightly around" },
  // The surface, named the way a sentence names it rather than the way the
  // registry ids it (`shoulders` is a pair; a hand lands on one).
  [locusCode("shoulders")]: { kind: "locus", phrase: "shoulder" },
  [locusCode("upper_arms")]: { kind: "locus", phrase: "upper arm" },
  [locusCode("arms")]: { kind: "locus", phrase: "arm" },
  [locusCode("forearms")]: { kind: "locus", phrase: "forearm" },
  [locusCode("hands")]: { kind: "locus", phrase: "hand" },
  [locusCode("back")]: { kind: "locus", phrase: "back" },
  [locusCode("head")]: { kind: "locus", phrase: "head" },
  [locusCode("hair")]: { kind: "locus", phrase: "hair" },
  // Material. `direct` has no phrase on purpose: a hand on a shoulder reads as
  // skin by default, so saying so would spend a clause volunteering a positive
  // detail — which is the one thing this block does not do.
  "contact.material.through": { kind: "material", phrase: "through the cloth over it" },
  // Refusals somebody actually gave.
  "contact.blocked.out_of_reach": { kind: "blocked", phrase: "they are too far apart for it" },
  "contact.blocked.actor_control_denied": { kind: "blocked", phrase: "that is not the player's body to move" },
  // What the scene would have to do first.
  "contact.requires.reposition": { kind: "requirement", phrase: "the distance would have to be closed first" },
  "contact.requires.close_distance": { kind: "requirement", phrase: "the distance would have to be closed first" },
  "contact.requires.change_support": { kind: "requirement", phrase: "the player's weight would have to shift first" },
  "contact.requires.free_limb": { kind: "requirement", phrase: "the player's hand is not free" },
  "contact.requires.remove_material_layer": {
    kind: "requirement",
    phrase: "something in the way would have to come off first",
  },
  "contact.requires.open_closure": { kind: "requirement", phrase: "something fastened would have to be opened first" },
  "contact.requires.target_must_act": { kind: "requirement", phrase: "the touch would have to be met from the other side" },
};

/** The phrase for one result code, or `undefined` for a code this lane cannot word. */
export function chatContactPhrase(code: string): ChatContactPhrase | undefined {
  return CHAT_CONTACT_LEXICON[code];
}

function blockedCode(reason: ContactRejectionReason): string {
  return `contact.blocked.${reason}`;
}

function requirementCode(code: ContactRequirementCode): string {
  return `contact.requires.${code}`;
}

function unresolvedCode(reason: ContactUnresolvedReason | "not_recorded"): string {
  return `contact.unresolved.${reason}`;
}

/**
 * The result codes for one resolved attempt, in a stable order.
 *
 * Order is identity here: `buildActionOutcome` folds the list into the
 * fingerprint every selection tie and every retake comparison rests on, so the
 * locus always leads and the qualifiers follow.
 */
function chatContactResultCodes(input: {
  readonly act: ChatContactAct;
  readonly resolution: ContactResolution;
  readonly committed: boolean;
}): readonly string[] {
  const locus = locusCode(input.act.targetLocationId);
  const resolution = input.resolution;
  switch (resolution.status) {
    case "committable":
      return input.committed
        ? [
            locus,
            `contact.gesture.${input.act.gesture}`,
            resolution.access.transmission.directSkinContact ? "contact.material.direct" : "contact.material.through",
          ]
        : [locus, unresolvedCode("not_recorded")];
    case "rejected":
      return [locus, blockedCode(resolution.reason)];
    case "explicit_transition_required":
      return [locus, ...resolution.requirements.map((requirement) => requirementCode(requirement.code))];
    case "unresolved":
      return [locus, unresolvedCode(resolution.reason)];
  }
}

// ---------------------------------------------------------------------------
// The narrator seam
// ---------------------------------------------------------------------------

export interface ChatContactOutcomeInput {
  readonly act: ChatContactAct;
  readonly resolution: ContactResolution;
  /** The fold, when there was one. */
  readonly commit?: ContactCommitOutcome;
  readonly eventRef: ContactEventRef;
  /** What the store did. Absent ⇒ nothing was written ⇒ the outcome is `unresolved`. */
  readonly acknowledgment?: ContactPersistenceAcknowledgment;
  readonly sink?: DiagnosticSink;
}

/**
 * One resolved attempt as the narrator-guidance seam receives it.
 *
 * `consistency_only` is the disclosure for every contact outcome, and the choice
 * is not incidental. `positive_detail_allowed` is for a fact that has cleared
 * viewpoint, channel, exposure, and policy gates and may be offered as
 * description; a contact outcome is not offered at all — it is a resolved
 * limitation on what the narration may say happened, which is precisely what
 * `consistency_only` licenses. It also keeps the block's register intact: this
 * layer states truths and fences claims, and never invites a detail.
 *
 * The outcome is built for EVERY resolved status, including `unresolved`. The
 * seam renders that one as silence, but the candidate still carries the
 * fingerprint and the codes the inspector and the eval harness read — a gap the
 * developer can see is worth more than one that looks like nothing happened.
 */
export function chatContactActionOutcome(input: ChatContactOutcomeInput): PhysicalActionOutcome {
  const expected =
    input.commit === undefined
      ? undefined
      : contactCommitExpectation({
          outcome: input.commit,
          eventRef: input.eventRef,
          actionId: input.act.actionId,
        });
  const status = contactActionOutcomeStatus({
    resolution: input.resolution.status,
    ...(expected === undefined ? {} : { expected }),
    ...(input.acknowledgment === undefined ? {} : { acknowledgment: input.acknowledgment }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  return buildActionOutcome({
    actionId: input.act.actionId,
    status,
    resultCodes: chatContactResultCodes({
      act: input.act,
      resolution: input.resolution,
      committed: status === "committed",
    }),
    disclosure: "consistency_only",
    evidence: input.resolution.evidence,
  });
}

// ---------------------------------------------------------------------------
// The reach premise
// ---------------------------------------------------------------------------

/**
 * A concrete act whose reach the scene could not establish — the ONE unresolved
 * case that earns a presentation line.
 *
 * An `unresolved` outcome is silence by contract, and that stays true: no
 * ledger row, no scene fold, no acknowledgment, and the outcome's own wording is
 * still empty. What the S3 trial showed is that silence alone does not stop the
 * PROSE from inventing the landing — the player wrote a touch, the guidance said
 * nothing, and the narrator depicted a hand crossing a room nobody measured. So
 * exactly one unresolved reason — `geometry_unavailable`, the typed "no
 * pose/reach owner could place these two surfaces" — produces a premise the
 * renderer words as a fence: reach is NOT ESTABLISHED, do not depict the touch
 * landing, do not invent movement to make it land.
 *
 * It states only the gap. It never claims the target is far away, pulled back,
 * or refused — those are positive facts the scene does not own, and the reasons
 * that DO own them (`out_of_reach`, the reposition/close-distance requirements)
 * keep their existing typed handling instead of degrading to this.
 */
export interface ChatContactReachPremise {
  /** The resolved target's display name — "Sabrina". */
  readonly targetName: string;
  /** The written surface ("shoulder"), when the lexicon can word the locus. */
  readonly locus?: string;
}

/**
 * The reach premise this turn's resolved attempt earns, or `null`.
 *
 * Typed end to end: the trigger is the resolution's own `unresolved /
 * geometry_unavailable` pair, never a diagnostic string. Every other status and
 * every other unresolved reason — material, support, control, agency — returns
 * `null`, because wording those as a reach problem would mislabel a different
 * gap.
 */
export function chatContactReachPremise(input: {
  readonly act: ChatContactAct | null;
  readonly resolution: ContactResolution | null;
  readonly characters: readonly ChatContactRosterMember[];
}): ChatContactReachPremise | null {
  const { act, resolution } = input;
  if (act === null || resolution === null) return null;
  if (resolution.status !== "unresolved" || resolution.reason !== "geometry_unavailable") return null;
  const target = input.characters.find((member) => member.subjectId === act.targetSubject);
  if (target === undefined) return null;
  const locus = chatContactPhrase(locusCode(act.targetLocationId));
  return {
    targetName: target.name,
    ...(locus === undefined ? {} : { locus: locus.phrase }),
  };
}


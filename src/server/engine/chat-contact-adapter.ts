import {
  adapterSupported,
  affordanceEvidence,
  affordanceSubjectId,
  applySceneIntents,
  buildActionOutcome,
  commitContactResolution,
  contactActionOutcomeStatus,
  contactCommitExpectation,
  contactEventRef,
  effectiveCoverageAt,
  resolveContactAttempt,
  sceneEventRef,
  sceneFact,
  sceneParticipant,
  sceneProvenance,
  sceneProvenanceEvidence,
  sceneGeometryRead,
  sceneSupportId,
  sceneSupportRead,
  sceneSupportSurface,
  toUnitInterval,
  withSceneParticipant,
  withSceneSupportSurface,
  type AffordanceEvidence,
  type AffordanceStoryTime,
  type AffordanceSubjectId,
  type CommittedContactOutcome,
  type ContactActionContext,
  type ContactActionIntent,
  type ContactActorControlDecision,
  type ContactAreaBand,
  type ContactBodySurfaceRef,
  type ContactCommitOutcome,
  type ContactEventRef,
  type ContactMaterialLayerRead,
  type ContactMotionBand,
  type ContactPersistenceAcknowledgment,
  type ContactPressureBand,
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
} from "@/contracts";
import { parseMessageSpans } from "@/lib/message-spans";

/**
 * The CHAT LANE's contact adapter — the affectionate integration proof
 * (romantic-contact-affordances.plan.md §"Continuation order" 1).
 *
 * Everything here is PURE and deterministic: a scene in, a player line in, a
 * seeded scene / a movement intent / a resolved attempt / an action outcome out.
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
 *    part: all of them produce nothing, because a contact this layer invented is
 *    worse than a contact it missed.
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

/** The acting surface for every act this proof detects. */
export const CHAT_CONTACT_SOURCE_LOCATION = "hands";

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
 * One attempt's id: the exchange's event plus the surface the act reaches for.
 *
 * The pair is what makes it unique WITHIN an exchange (a turn could in principle
 * detect a different act after a retake) while staying reproducible ACROSS a
 * retake of the same take, which is what `contactActionOutcomeStatus` compares
 * an acknowledgment against.
 */
export function chatContactActionId(eventRef: ContactEventRef, act: ChatContactActShape): string {
  return `${eventRef}#${act.targetSubject}:${act.targetLocationId}`;
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
   * This member's captured effective-coverage read, when the conversation has
   * one. The material-between adapter reads it and nothing else — see
   * `chatContactMaterialLayers` for why that is deliberately minimal here.
   */
  readonly coverage?: EffectiveCoverageRead;
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

/** Sentence boundaries: terminal punctuation, or a line break. */
const CONTACT_SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/u;

/**
 * Markers that put a whole sentence out of reach.
 *
 * Wider and blunter than the premise detector's positional rules on purpose: a
 * missed touch costs a turn of silence, and a committed one the player did not
 * make is a durable row claiming a contact that never happened.
 */
const CONTACT_CONDITIONAL_RE =
  /\b(?:if|would|could|should|might|may|maybe|perhaps|imagine|suppose|pretend|wish|almost|nearly|want to|wanted to|going to|about to|tr(?:y|ies|ied|ying) to|as if|as though|like a|like the)\b/iu;

/**
 * Negation anywhere in the sentence silences it. The premise detector can afford
 * a positional rule because it is judging a claim; here the question is whether
 * a body moved, and "I don't rest my hand on your shoulder" must never commit.
 */
const CONTACT_NEGATION_RE = /\b(?:not|never|no longer|don'?t|doesn'?t|didn'?t|won'?t|can'?t|cannot|without)\b/iu;

/**
 * Romantic and intimate framing — vetoed WHOLE-SENTENCE (owner ruling: a
 * genuinely affectionate proof, never a romantic case relabeled to commit).
 *
 * A sentence that kisses and also rests a hand on a shoulder is not an
 * affectionate touch with decoration; it is a beat whose framing this proof has
 * no permission owner for, and the honest answer is to commit nothing.
 */
const CONTACT_ROMANTIC_VERB_RE =
  /\b(?:kiss\w*|caress\w*|strok\w*|nuzzl\w*|cuddl\w*|snuggl\w*|embrac\w*|hugs?|hugg\w*|straddl\w*|grind\w*|undress\w*|strip\w*|lick\w*|tast\w*|suck\w*|nibbl\w*|bit(?:e|es|ing)|moan\w*|arous\w*|seduc\w*|fondl\w*|grop\w*|cups?|cupp\w*|trac(?:e|es|ed|ing)|glid\w*|fingertips?)\b/iu;
const CONTACT_ROMANTIC_TARGET_RE =
  /\b(?:lips?|mouth|tongue|thighs?|chest|breasts?|nipples?|cleavage|waist|hips?|belly|stomach|navel|neck|throat|nape|jaw|chin|cheeks?|ears?|earlobes?|buttocks?|butt|ass|arse|rear|groin|crotch|pussy|cunt|vulva|clit\w*|penis|cock|dick|naked|nude|bare skin|small of)\b/iu;

/**
 * Restraint, pinning, and force. `trapped` mobility has no producer in the scene
 * owner, so a scenario that would need one is refused at the door rather than
 * resolved against a model that cannot express it.
 */
const CONTACT_RESTRAINT_RE =
  /\b(?:pin\w*|trap\w*|restrain\w*|held down|hold\w* down|grabs?|grabb\w*|grips?|gripp\w*|yank\w*|shov(?:e|es|ed|ing)|push\w*|pull\w*|forc(?:e|es|ed|ing)|wrestl\w*|tackl\w*|drag\w*|hold\w* still|struggl\w*)\b/iu;

/** Is this sentence something this proof may read as a plain affectionate act? */
function contactSentenceEligible(sentence: string): boolean {
  if (sentence.includes("?")) return false;
  if (CONTACT_CONDITIONAL_RE.test(sentence)) return false;
  if (CONTACT_NEGATION_RE.test(sentence)) return false;
  if (CONTACT_ROMANTIC_VERB_RE.test(sentence)) return false;
  if (CONTACT_ROMANTIC_TARGET_RE.test(sentence)) return false;
  if (CONTACT_RESTRAINT_RE.test(sentence)) return false;
  return true;
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
function contactSentences(input: ChatContactDetectionInput): readonly string[] {
  if (input.narratorInput) return [];
  const message = input.message.trim();
  if (message.length === 0) return [];
  const sentences: string[] = [];
  for (const span of parseMessageSpans(message)) {
    if (span.kind !== "narration") continue;
    for (const sentence of span.text.split(CONTACT_SENTENCE_SPLIT)) {
      if (sentence.trim().length > 0 && contactSentenceEligible(sentence)) sentences.push(sentence);
    }
  }
  return sentences;
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
 * preposition, and a person. The first-person subject is the guard rail: "she
 * walks over to me" is an NPC's movement and this detector must never produce
 * one.
 */
const APPROACH_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:${APPROACH_VERBS})\\b[^.?!;:]{0,60}?\\b(${APPROACH_ADJACENCY})\\s+([\\p{L}][\\p{L}\\p{N}'’-]*)\\b`,
  "giu",
);

/**
 * The player's approach this turn, or `null`.
 *
 * First eligible sentence wins: two movements in one message is a beat this
 * proof does not model, and folding both would let a later sentence's distance
 * overwrite an earlier one on nothing better than array order.
 */
export function detectChatApproach(input: ChatContactDetectionInput): ChatApproach | null {
  for (const sentence of contactSentences(input)) {
    // Every first-person clause in the sentence, not just the first: "I walk over to
    // the window, then I step closer to Wren" opens on a destination that names no
    // person, and stopping there would throw away the movement that happened.
    // `matchAll` clones the regex, so the module-level `lastIndex` is never shared.
    for (const match of sentence.matchAll(APPROACH_RE)) {
      const target = resolveContactTarget(match[2] ?? "", input.characters);
      if (target === null) continue;
      const adjacency = (match[1] ?? "").toLowerCase();
      return { targetSubject: target.subjectId, band: APPROACH_TOUCHING.has(adjacency) ? "touching" : "close" };
    }
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
// Affectionate touch
// ---------------------------------------------------------------------------

/** How the hand meets the surface. Three gestures, and each one states its own pressure. */
export const chatContactGestures = ["rest", "pat", "squeeze"] as const;
export type ChatContactGesture = (typeof chatContactGestures)[number];

/** The identity half of an act — everything `chatContactActionId` keys on. */
export interface ChatContactActShape {
  readonly targetSubject: AffordanceSubjectId;
  readonly targetLocationId: string;
}

/** One detected affectionate act by the player, on the player's own hand. */
export interface ChatContactAct extends ChatContactActShape {
  readonly actionId: string;
  readonly actorSubject: AffordanceSubjectId;
  readonly sourceLocationId: string;
  readonly actionKind: "affectionate";
  readonly gesture: ChatContactGesture;
}

/**
 * The target lexicon: written noun → body-registry location id.
 *
 * An ALLOW-list, and everything romantic is simply absent from it rather than
 * being filtered afterwards. These are the surfaces an ordinary affectionate
 * hand lands on, and every id is one `bodyLocationRegistry` already carries — a
 * parallel anatomy is exactly what the contact core refuses to own.
 */
const CONTACT_TARGET_LOCATION: Readonly<Record<string, string>> = {
  shoulder: "shoulders",
  shoulders: "shoulders",
  "upper arm": "upper_arms",
  arm: "arms",
  arms: "arms",
  forearm: "forearms",
  forearms: "forearms",
  hand: "hands",
  hands: "hands",
  "upper back": "back",
  back: "back",
  head: "head",
  hair: "hair",
};

/** Longest-first, so "upper back" is not read as "back". */
const CONTACT_TARGET_ALTERNATION = "upper back|upper arm|shoulders?|forearms?|arms?|hands?|back|head|hair";
const CONTACT_OWNER = "your|her|his|their|[\\p{L}][\\p{L}\\p{N}'’-]*['’]s";

/** "I rest my hand on your shoulder" — the hand is the object, the body part the destination. */
const CONTACT_PLACE_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(rest|rests|rested|resting|place|places|placed|placing|put|puts|putting` +
    `|lay|lays|laid|laying|set|sets|setting|settle|settles|settled|settling)\\s+` +
    `(?:my|a|one|the)\\s+(?:hand|hands|palm)\\s+(?:on|onto|against|over|to)\\s+` +
    `(${CONTACT_OWNER})\\s+(${CONTACT_TARGET_ALTERNATION})\\b`,
  "iu",
);

/** "I pat your head" / "I squeeze your hand" — the body part is the direct object. */
const CONTACT_DIRECT_RE = new RegExp(
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(pat|pats|patted|patting|squeeze|squeezes|squeezed|squeezing)\\s+` +
    `(${CONTACT_OWNER})\\s+(${CONTACT_TARGET_ALTERNATION})\\b`,
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
    const locationId = CONTACT_TARGET_LOCATION[(match[3] ?? "").toLowerCase()];
    if (locationId === undefined) continue;
    const shape: ChatContactActShape = { targetSubject: target.subjectId, targetLocationId: locationId };
    return {
      ...shape,
      actionId: chatContactActionId(input.eventRef, shape),
      actorSubject: CHAT_CONTACT_PLAYER_SUBJECT,
      sourceLocationId: CHAT_CONTACT_SOURCE_LOCATION,
      actionKind: "affectionate",
      gesture: gestureOf(match[1] ?? ""),
    };
  }
  return null;
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
 * What lies between the player's hand and the target surface.
 *
 * A location NO worn garment reaches has no coverage entry, and that is bare
 * skin — the wardrobe's own answer, not something invented here. An entry in ANY
 * band is one interposed layer: `exposed` means the cover stopped CONCEALING,
 * which is a statement about sight, and the fabric is still there to touch.
 *
 * **The declared simplification.** An absent CAPTURE — a conversation whose
 * wardrobe was never staged at all — also reads `[]`, and that is a guess rather
 * than an answer, which this repo ordinarily refuses. It is accepted here on a
 * narrow argument: the intent asks for `any_material` access, so the layer list
 * cannot change WHETHER the touch commits, only whether the narrator line adds
 * "through the cloth over it". A wrong guess costs one clause; reporting the
 * material `unavailable` instead would resolve every attempt in an unstaged
 * conversation to silence, which would make the proof untestable without proving
 * anything. When the wardrobe's real material terms are projected into the
 * contact core (the continuation order's LAST item), this becomes an answer.
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

// ---------------------------------------------------------------------------
// Attempt assembly
// ---------------------------------------------------------------------------

/**
 * What each gesture states about the contact it makes.
 *
 * Pressure is stated because the VERB states it: "rest a hand" is a description
 * of light contact, not a guess at one. Area is deliberately absent — nobody
 * said how much of the hand — and the contact core is built to leave an unstated
 * band unknown rather than defaulting it to the lightest thing that could be true.
 */
const GESTURE_CONTACT: Readonly<
  Record<
    ChatContactGesture,
    { readonly pressure: ContactPressureBand; readonly motion?: ContactMotionBand; readonly area?: ContactAreaBand }
  >
> = {
  rest: { pressure: "light" },
  pat: { pressure: "light", motion: "tapping" },
  squeeze: { pressure: "moderate" },
};

/**
 * The actor-control decision, READ from the scene rather than asserted.
 *
 * The chat lane's player really is the controlling principal for the player
 * subject, so it would be easy to hard-code `allowed` — and that is exactly the
 * shortcut the actor-control law exists to close. Reading the scene's own
 * control fact means a body nobody declared a controller for produces
 * `unresolved` (silence, plus a diagnostic from the resolver) and a body the
 * scene says is NPC-controlled produces a refusal, whatever this lane believes.
 */
function chatActorControl(scene: SceneState, actorId: AffordanceSubjectId): ContactActorControlDecision {
  const laneEvidence: readonly AffordanceEvidence[] = [affordanceEvidence("adapter", "chat.contact.player_line")];
  const control = sceneParticipant(scene, actorId)?.control;
  if (control === undefined) return { status: "unresolved", actorId, evidence: laneEvidence };
  const evidence: readonly AffordanceEvidence[] = [...laneEvidence, ...sceneProvenanceEvidence([control.provenance])];
  return { status: control.value === "player_controlled" ? "allowed" : "denied", actorId, evidence };
}

export interface ChatContactAttemptInput {
  readonly scene: SceneState;
  readonly act: ChatContactAct;
  /** From `chatContactMaterialLayers`; `[]` is bare skin, not "unknown". */
  readonly garmentLayers: readonly ContactMaterialLayerRead[];
  readonly storyTime: AffordanceStoryTime;
  readonly sink?: DiagnosticSink;
}

/**
 * Resolve one detected act against the scene.
 *
 * Two of the four permissions are stated `not_required`, and that is honest
 * rather than convenient: affectionate contact needs neither an adult
 * eligibility pass nor an interaction-permission grant (owner ruling, 2026-07-30
 * — `contactActionRequiresAdultEligibility` / `contactActionRequiresPermission`),
 * so the resolver never consults either read. They ride the committed record
 * anyway, where they say exactly what happened: nobody was asked, because for
 * this action kind nobody had to be.
 *
 * `targetAgencies` is empty because the act moves ONE body — the player's hand.
 * Nothing is proposed on the other person's side, so there is no movement of
 * hers for her own authority to allow, and an `adjustments` list that proposed
 * one would need it.
 */
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
  const gesture = GESTURE_CONTACT[act.gesture];
  const materialEvidence = input.garmentLayers.flatMap((layer) => [...layer.evidence]);

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
  const context: ContactActionContext = {
    actorControl: chatActorControl(scene, act.actorSubject),
    targetAgencies: [],
    participantEligibility: {
      status: "not_required",
      participantIds: [act.actorSubject, act.targetSubject],
      evidence: [affordanceEvidence("adapter", "chat.contact.eligibility", "affectionate_not_gated")],
    },
    policy: {
      status: "not_required",
      scopes: [],
      evidence: [affordanceEvidence("adapter", "chat.contact.policy", "affectionate_permission_neutral")],
    },
    geometry: sceneGeometryRead({
      state: scene,
      source,
      target,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    }),
    sourceSupport: sceneSupportRead(scene, source, input.sink),
    targetSupport: sceneSupportRead(scene, targetSurface, input.sink),
    material: adapterSupported({ layers: input.garmentLayers, evidence: materialEvidence }, materialEvidence),
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
  readonly sink?: DiagnosticSink;
}

export interface ChatContactTurn {
  /**
   * The scene with seeding and any movement folded in — but NOT the contact.
   * The projection only advances once the caller has durably recorded the fold,
   * so a caller that persists nothing writes no contact either.
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
}

/**
 * The whole deterministic half of the contact leg: seed, move, detect, resolve,
 * fold.
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
  const approach = detectChatApproach(detection);
  if (approach !== null) {
    scene = applySceneIntents(
      scene,
      chatApproachSceneIntents(approach, { player: CHAT_CONTACT_PLAYER_SUBJECT, ref, storyTime: input.storyTime }),
      input.sink,
    ).state;
  }

  const act = detectChatAffectionateTouch({ ...detection, eventRef: input.eventRef });
  if (act === null) return { scene, act: null, resolution: null, commit: null };

  const target = input.characters.find((member) => member.subjectId === act.targetSubject);
  const resolution = resolveChatContactAttempt({
    scene,
    act,
    garmentLayers: chatContactMaterialLayers(target?.coverage, act.targetLocationId),
    storyTime: input.storyTime,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  if (resolution.status !== "committable") return { scene, act, resolution, commit: null };

  const commit = commitContactResolution({
    state: scene.contacts,
    resolution,
    eventRef: input.eventRef,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  return { scene, act, resolution, commit };
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

import {
  affordanceEvidence,
  contactParticipantIds,
  sceneProximityFact,
  type AffordanceStoryTime,
  type AffordanceSubjectId,
  type SceneEventRef,
  type SceneMovementIntent,
  type SceneProximityBand,
  type SceneState,
} from "@/contracts";
import {
  NAME_PHRASE,
  contactSentences,
  endingSentences,
  resolveNamePhrasePrefix,
  type ChatContactDetectionInput,
  type ChatContactRosterMember,
} from "./input-evidence";

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
  `\\bi\\s+(?:[\\p{L}']+\\s+){0,2}?(?:${APPROACH_VERBS})\\b[^.?!;:]{0,60}?\\b(${APPROACH_ADJACENCY})\\s+(${NAME_PHRASE})\\b(?=(\\s+[\\p{L}])?)`,
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
    // Resolve BEFORE guarding, because the capture may hold more words than the
    // name does and the guard's question is about what follows the NAME.
    const resolved = resolveNamePhrasePrefix(match[2] ?? "", (match[3] ?? "").length > 0, characters);
    if (resolved === null) continue;
    // A possessed destination keeps SCANNING rather than ending the sentence:
    // "I walk over to her desk, then I step closer to Wren" still moves.
    if (destinationIsPossessive(resolved.consumed, resolved.followedByWord)) continue;
    const adjacency = (match[1] ?? "").toLowerCase();
    return { targetSubject: resolved.member.subjectId, band: APPROACH_TOUCHING.has(adjacency) ? "touching" : "close" };
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
const DEPARTURE_FROM_RE = new RegExp(`\\bfrom\\s+(?:the\\s+)?(${NAME_PHRASE})\\b(?=(\\s+[\\p{L}])?)`, "iu");

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
    const resolved = resolveNamePhrasePrefix(from[1] ?? "", (from[2] ?? "").length > 0, input.characters);
    if (resolved === null) continue;
    if (destinationIsPossessive(resolved.consumed, resolved.followedByWord)) continue;
    return { targetSubject: resolved.member.subjectId, band };
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
 * the player leg, the NPC actor on the reply-scene leg, where `departedBand`
 * mirrors the player helper exactly. The law is a property of the PAIR, not of
 * whose turn it is, and proximity facts are pair-symmetric, so one helper serves
 * both and neither lane can quietly acquire a different distance rule.
 *
 * **Never invent a distance**. Two sources can license the claim and
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
 * The departure helper's inverse, and the same law read the other way round:
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
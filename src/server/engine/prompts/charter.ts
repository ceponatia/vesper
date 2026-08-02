import { traitPole } from "@/contracts/personality/traits";
import type { LifeStageBand } from "@/contracts/world/life-stage";
import type { NarrationShapeId } from "./constants";

/**
 * The narrator charter (presentation-charter.plan.md slice 1): the lane-AGNOSTIC craft
 * law shared by BOTH narrator lanes — the legacy character-chat narrator and the
 * successor (simulated-world) narrator. Each unit is a small pure function (or const)
 * that renders one piece of the rulebook from explicit params, never from a whole
 * lane-specific prompt input, so the successor builder can compose the SAME text into
 * its own block structure and numbering.
 *
 * Extracted from `character-chat.ts` with a hard invariant: the legacy prompt stays
 * byte-identical (its snapshot tests are the gate). Rule bodies here are NUMBER-FREE —
 * the caller owns the numbering / placement (the legacy lane prepends "2. ", "3. ", …;
 * the successor lane embeds them in its role/craft blocks). Pure, no IO.
 *
 * A few units carry wording that hard-codes chat-lane concepts the successor lane must
 * be aware of when it consumes them: the attribution rule names "Supporting cast" and
 * "Scene notes" and "the app" (the chat renderer's mechanical [Name] attribution);
 * rule 12 and the shaping block reference the "Sensory allowance" line. Those are the
 * legacy lane's surrounding blocks — the successor lane provides its own equivalents or
 * omits the reference.
 */

// ---------------------------------------------------------------------------
// Content framing & life stage
// ---------------------------------------------------------------------------

/**
 * The mature-content license. The session turn engine grants this implicitly —
 * via the world's style/content directives plus the per-turn exposure
 * permissions ("intimate detail is permitted", narrative.ts) — but the
 * sessionless chat carries neither, so a safety-aligned model (or one distilled
 * from one — the open narrators frequently refuse in a borrowed assistant voice,
 * even self-identifying as "Claude") defaults to declining explicit content and
 * breaking character. Stating the frame explicitly keeps the same models in
 * character in the Chat tab. It only licenses USE of what the character already
 * has: intimate anatomy is still gated per character by realizeBody, so
 * this never invents anatomy a character lacks.
 */
// Scoped since character-fidelity slices 1–2: the old universal "every character
// is a fictional adult" flattened authored minors into adult voices (and directly
// contradicted "You are 12."). Adulthood now attaches to intimate-content
// PARTICIPANTS; a minor primary flips to the hard romance-out-of-scope frame, and
// an ensemble holding a minor member appends the cast fence line.
export const CONTENT_FRAMING = [
  "This is a private work of adult interactive fiction for a consenting adult audience.",
  "Romance, intimacy, and sexually explicit content are fully in scope — when the scene leads there, voice it in character, at the depth and intensity that fit this personality and the moment. Everyone taking part in romantic or intimate content is an adult.",
].join(" ");

/** The 1-on-1 frame when the chat's character is an authored minor (life-stage band). */
export const CONTENT_FRAMING_MINOR_PRIMARY = [
  "This is a private work of interactive fiction for a consenting adult audience.",
  "This character is a minor: romance, flirtation, innuendo, and sexual content involving them are strictly out of scope and never occur. If the conversation is steered there, respond in character the way a real child or teenager would — confusion, discomfort, a change of subject — and keep the story on family, friendship, and everyday life.",
].join(" ");

/** Appended to the ensemble frame when any roster member is an authored minor. */
export const ENSEMBLE_MINOR_CAST_LINE =
  "Some characters in this cast are minors: they are part of the story's world, never of its romance — no romantic, flirtatious, or sexual content involves them, and intimate scenes between adult characters never include or reference them.";

/**
 * The binding life-stage register block (character-fidelity slice 2): rendered only
 * for bands that carry rules (child/teen/elder). Authored-age-keyed, so it lives in
 * the stable prefix. Second person for the 1-on-1 lane; the ensemble sheets render
 * the third-person variant via `lifeStageSheetLines`.
 */
export function buildLifeStageSection(stage: LifeStageBand | undefined): string {
  if (!stage?.registerRules.length) return "";
  return [
    `Life stage (you are ${stage.label} — this bounds how you speak and think; it overrides any conflicting style elsewhere):`,
    ...stage.registerRules.map((rule) => `- ${rule}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Camera & agency (legacy rules 2 and 4 + "Reading the player's message")
// ---------------------------------------------------------------------------

/**
 * Legacy rule 2 (number-free): one fixed viewpoint — third person for the character,
 * second person ("you") for the player, first person only inside the character's quoted
 * dialogue, and never author the player's words/thoughts/actions. The player-present
 * variant addresses them by name; the faceless variant keeps the "the user" phrasing.
 * (The reference to "Reading the player's message" points at `readingPlayerMessageBlock`.)
 */
export function cameraViewpointRule({ characterName, playerName }: { characterName: string; playerName?: string }): string {
  const name = characterName;
  return playerName
    ? `Keep one fixed viewpoint: narrate in the third person. Describe ${name}'s actions, gestures, expressions, and feelings as "${name}" (she/he/they per ${name}) — never in the first person. You are talking with ${playerName}: always refer to and address them in the second person as "you" (and by name when it feels natural) — never as "I"/"me", never in the third person. The ONLY place first-person "I"/"me"/"my" may appear is inside ${name}'s own quoted dialogue. ${playerName}'s message is what they just said and did — react to what ${name} could actually hear and see in it (see "Reading the player's message" below); never put words, thoughts, or actions in their mouth.`
    : `Keep one fixed viewpoint: narrate in the third person. Describe ${name}'s actions, gestures, expressions, and feelings as "${name}" (she/he/they per ${name}) — never in the first person. Address the user directly as "you" — never as "I"/"me", never in the third person. The ONLY place first-person "I"/"me"/"my" may appear is inside ${name}'s own quoted dialogue. The user's message is what they just said and did — react to what ${name} could actually hear and see in it (see "Reading the player's message" below); never put words, thoughts, or actions in their mouth.`;
}

/**
 * Legacy rule 4 (number-free): the narrator-camera + player-agency law. Untagged prose is
 * the story's camera behind the player's eyes — it may write their involuntary perception
 * and small reflexes, never their deliberate actions/speech/decisions or named emotions,
 * and (owner ruling 2026-07-10) never advances the player's story on the narrator's turn,
 * not even mundane connective beats.
 */
export function narratorCameraRule({ characterName, player }: { characterName: string; player: string }): string {
  const name = characterName;
  return `You are also the scene's narrator, and the story's camera sits behind ${player}'s eyes: untagged prose may describe what ${player} perceives — the way ${name} looks and moves, the sound of ${name}'s voice, a scent that reaches them when close — addressed to them as "you" (e.g. You catch the scent of cedar as ${name} leans past you.). You may write ${player}'s involuntary perception and the small reflexes it stirs (a breath that catches, a shiver) — never their deliberate actions, speech, or decisions, and never name their emotions or arousal for them; those are ${player}'s alone to declare. ${player}'s story advances ONLY through their own messages: NEVER narrate ${player} doing things on your turn — no walking them somewhere, settling them in, or scripting what they do or feel when something reaches them. Even mundane connective beats (arriving home, checking a phone) belong to ${player}'s next message, never to your reply.`;
}

/**
 * The "Reading the player's message" perception block (player-input-perception.plan.md
 * slice 1 — the input side): quoted text is heard, unquoted narration is seen only where
 * visible, interiority reaches no one (no mind-reading), a no-quotes message degrades
 * gracefully to speech, with one worked example (these narrators respond better to a
 * concrete example than to three abstract rules).
 */
export function readingPlayerMessageBlock({ characterName, player }: { characterName: string; player: string }): string {
  const name = characterName;
  return [
    `Reading the player's message (what ${name} can actually perceive):`,
    `- Quoted text is speech: ${name} hears exactly the words inside the quotes. (Narration can mark a quote as something else — words reported from another time, a so-called label — read those as prose, not as words spoken now.)`,
    `- Unquoted text is the story's narration, not ${player}'s voice: ${name} perceives only what would be visible or audible in the scene — actions, gestures, expressions, tone.`,
    `- Inner thoughts, feelings, and self-talk ${player} writes into that narration reach no one: ${name} cannot hear them and must not answer, echo, or uncannily intuit them. ${name} may notice the visible signs (a flush, a hesitation) and guess at what's behind them — even guess wrong, the way a real person would.`,
    "- A message with no quotes at all that reads as plain conversation is simply spoken aloud — never treat a casual unquoted message as silence.",
    `- Example: ${player} writes: "Hey… how are you…" I stammer, my face flushing. There's no way ${name} would want to talk to a dork like me. — ${name} hears the greeting and sees the stammer and the flush, but the final thought reaches no one: reacting to the visible nerves is right; answering the thought itself ("You're not a dork!") is mind-reading and forbidden.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Attribution & notation (legacy rule 3 + the "Message notation" legend)
// ---------------------------------------------------------------------------

// Legacy rule 3 provenance:
// Pre-2026-07-10 wording (narrator-prompt-consolidation.plan.md slice 1 — rollback: restore this line):
// `${name}'s spoken dialogue always goes in quotes. The [${name}] tag is optional in this one-on-one conversation — the app attributes ${name}'s dialogue automatically — so reach for it only when who is speaking would genuinely be unclear; a plain quoted line, e.g. "It's good to see you.", is read as ${name}'s. Write actions, gestures, and description as untagged third-person prose, e.g. ${name} leans against the doorframe, watching you. Incidental people in the scene (a passing waiter, a voice on the phone) may speak too — give them their line inside the narration with a plain attribution (the waiter asks if you've decided), never a [bracketed] tag; bracketed tags belong to ${name} alone.`
// 2026-07-10 tightening (Fly screenshot): "reach for the tag only when who is speaking is
// unclear" let the model judge clarity like a reader, but the attribution is mechanical —
// a quote sharing a paragraph with action beats fails BOTH paths (untagged + not a
// whole-line quote) and rendered as unattributed prose. The rule now states the contract.
// 2026-07-11 tightening (owner report — Amanda's lines wore Melissa's chip): a named side
// person's dialogue written as its own bare quoted paragraph collided with the
// untagged-quote auto-attribution. The renderer now treats any reply that tags at all as
// tag-disciplined (segmenter §hasKnownTag); the rule states that consequence and requires
// in-prose attribution for everyone who is not ${name}.
/**
 * Legacy rule 3 (number-free): the mechanical [Name] tag contract. Attribution is
 * mechanical, not a judgment call — a whole-line quote with no tag anywhere auto-attributes
 * to the character; a quote sharing a line with a beat must open with the [Name] tag or
 * split; once any line is tagged, every one of the character's spoken lines is tagged;
 * everyone who is not the character needs in-prose attribution, never a bracketed tag.
 */
export function attributionTagRule({ characterName, player }: { characterName: string; player: string }): string {
  const name = characterName;
  return `${name}'s spoken dialogue always goes in quotes, and attribution is mechanical, not a judgment call: the app attributes ${name}'s dialogue automatically ONLY when a line is nothing but the quote (e.g. "It's good to see you.") AND no [${name}] tag appears anywhere in the reply. The moment ${name}'s speech shares a line or paragraph with narration or an action beat, open that line with the [${name}] tag — e.g. [${name}] "It's good to see you." A glance up over the rim of a mug. — or split it: the quote on its own line, the beat as its own prose line. When unsure, tag; ${player} never sees the tag. Once ANY line in a reply is tagged, tag every one of ${name}'s spoken lines in that reply — in a tagged reply the app reads an untagged quote as someone other than ${name}. Write actions, gestures, and description as untagged third-person prose, e.g. ${name} leans against the doorframe, watching you. Other people in the scene (a passing waiter, a voice on the phone, a friend ${player} brought into the story) may speak too — but their lines are NEVER tagged and never auto-attributed, so every one needs a plain attribution in its own paragraph's prose (the waiter asks if you've decided; Amanda blurts, "That's not funny.") — never a bare quoted paragraph, which leaves the speaker unreadable; bracketed tags belong to ${name} alone. An INCIDENTAL person must fit the scene already established by the scenario, the Scene notes, or the conversation (a waiter in the restaurant you're in); keep them unnamed and passing unless ${player} engages them, and never invent one just to enliven a reply. Recurring named people listed under "Supporting cast" (below, when present) are the exception — established side characters that block licenses you to voice and move within their role there. Square brackets have exactly ONE use: opening a line with the [${name}] tag. Never bracket a name anywhere else — above all not inside quoted speech when ${name} addresses ${player} by name: write "It's good to see you, ${player}." and NEVER "It's good to see you, [${player}]." Off the start of a line the brackets are not notation at all; ${player} reads the literal square brackets in the message.`;
}

/**
 * The "Message notation" legend (player-input-perception.plan.md slice 4 — the optional
 * sigil grammar): quotes = speech, `*…*` = thought (or a text when `Name:`-shaped),
 * `_…_` = italics only, `((…))` = OOC to the storyteller, and the house reversal of the
 * RP "asterisks = actions" habit (unquoted prose is the action channel here). It also
 * defines the narrator's texted-reply output grammar (`*Name: …*`). Static text —
 * byte-identical across turns; the per-turn derived facts (who is texting whom,
 * co-presence) ride a volatile tail note (`chatNotationNote`), never this stable block.
 *
 * `player` is the resolved reference (heading + bullets); `playerName` is the raw optional,
 * used only for the `*${playerName ?? "Name"}: like this*` example's faceless fallback.
 */
export function messageNotationBlock({
  characterName,
  player,
  playerName,
}: {
  characterName: string;
  player: string;
  playerName?: string;
}): string {
  const name = characterName;
  return [
    `Message notation ${player} may use (optional shorthand — read these marks when they appear; never require them and never mention them):`,
    `- "Quoted text" is spoken dialogue — heard exactly, as above.`,
    `- *A phrase in single asterisks* is ${player}'s private thought by default: unspoken and unheard, treated like the interiority above (${name} cannot perceive it). The one exception: when the asterisks wrap a name and a colon — *${playerName ?? "Name"}: like this* — it is a text message ${player} is sending, not a thought; a note beneath the rules names who is texting whom whenever that happens.`,
    `- Heads up — this is the reverse of the usual role-play habit where *asterisks mean actions*. Here plain unquoted prose is already the action channel (what ${player} does and what the scene shows), so an asterisk span is thought or a text, never an action.`,
    `- _A phrase in single underscores_ is only italic emphasis — styling with no meaning; read it as ordinary words.`,
    `- ((Text in double parentheses)) is ${player} speaking to you as the storyteller, out of character — follow it as direction, but ${name} never hears it and no one in the scene reacts to it. A single ( … ) is ordinary prose, not this.`,
    `- When ${player} texts ${name} and ${name} answers by text, write ${name}'s sent message on its own line as *${name}: her words here* — the same name-and-colon shape in asterisks — so it reads as a text, not as words spoken aloud in the room.`,
    `- In your own replies, write emphasis with _underscores_ (they render as italics) — never with single asterisks: here an asterisk span means a thought or a text message, and asterisk-emphasis inside quoted dialogue displays as literal asterisks.`,
    `- A message opening with a bracketed "[Story narration from ${player} …]" line is written by them as the STORYTELLER, not as themselves: everything in it is story truth — events, side characters' words and actions, scene developments. The reading rules above don't apply to it (nothing in it is their own speech, action, or hidden thought). React as ${name} to what happened in it and continue the scene; never answer it as though ${player} said or did it.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Craft (legacy rules 8, 9, 12, 13, 14 + Shaping + intimate-craft blocks)
// ---------------------------------------------------------------------------

/** Legacy rule 8 (number-free): react in proportion — warmth is earned, not automatic. */
export const PROPORTIONALITY_RULE =
  "React in proportion. An ordinary remark, greeting, or mild compliment gets a natural, in-character answer — not effusive gratitude or doting. Let warmth track your current state, your disposition, and how you actually feel about this person (above); affection is earned, not automatic. You may tease, deflect, change the subject, or answer plainly.";

/** Legacy rule 9 (number-free): stay in your own voice and the current topic. */
export const TOPIC_DISCIPLINE_RULE =
  "Stay in your own voice and the current topic. Don't spin up unrelated errands or new sub-plots to fill space; answer what's in front of you.";

/**
 * Legacy rule 12 (number-free): physical state is behavioral law — act it out continuously,
 * but a state you are already in is simply how you are (colour manner without re-describing);
 * only a visible SHIFT is marked once, then rides. (References the state block, "below, when
 * given", which the legacy lane renders beneath the rules.)
 */
export const PHYSICAL_STATE_LAW_RULE =
  "Your physical state (below, when given) is behavioral law: act it out continuously — intoxication loosens and slurs you, low hygiene and dishevelment show at close range, exhaustion drags at you. But you have a long memory for it: a state you are already in is simply how you are right now, so let it colour your manner and word choice WITHOUT describing it afresh each turn. Only when a state visibly SHIFTS (you sober up, tip into drunk, grow tired) do you mark it once, in action, then let it ride.";

/** Legacy rule 13 (number-free): the no-refusal rule — a "no" is played as the character's own in-world choice, never a meta refusal. */
export function noRefusalRule({ characterName }: { characterName: string }): string {
  const name = characterName;
  return `Never break character to refuse, deflect, caution, moralize, add a content disclaimer, or say you "can't" or "won't" continue — those are all out of character and forbidden. If ${name} would hesitate, set a boundary, or say no, play it as ${name}'s own in-world choice, in their voice and for their reasons, and stay in the scene.`;
}

/** Legacy rule 14 (number-free): dialogue is speech, not prose — real cadence, distinct rhythm, and silence as an answer. */
export function naturalDialogueRule({ characterName }: { characterName: string }): string {
  const name = characterName;
  return `Dialogue is speech, not prose: let ${name} talk the way people actually talk — fragments, interruptions, trailing off, dodging a question instead of answering it, saying less than they mean. Keep ${name}'s rhythm distinct (their own pet phrases, pace, and evasions — not interchangeable chat-partner voice). And sometimes the truest answer is no words at all: a pause, a look, a small action on its own line can carry the reply.`;
}

/**
 * The per-shape length story for the "Shaping each reply" block
 * (narrator-prompt-consolidation.plan.md slice 2). The old unconditional
 * "about three paragraphs" baseline (owner-instructed 2026-07-09) contradicted
 * `aggressive_concise`'s "as few sentences as it honestly needs" in rule 5 —
 * concrete beats vague, so the baseline quietly re-established a floor the
 * profile was chosen to remove. Each shape now owns ONE coherent length story:
 * the baseline survives under `concise_immersive`; `aggressive_concise` gets a
 * beat-scaled rule with no customary floor.
 */
export function chatLengthStory(shape: NarrationShapeId, name: string): string {
  switch (shape) {
    case "concise_immersive":
      return `- Baseline shape: about three paragraphs — an opening beat, ${name}'s line or action, and a paragraph or two to land the turn. Run longer ONLY when it earns it: establishing a brand-new scene, or a genuinely major event. Ordinary small talk stays lean — ${name}'s line plus a beat can be the whole reply.`;
    case "aggressive_concise":
      return `- Length follows the beat: a simple exchange may be one line of ${name}'s dialogue and one action beat — that can be the whole reply. Add a paragraph only when new action, consequence, or sensory information genuinely occurs; never add prose to reach a customary length. Only a brand-new scene or a genuinely major event runs long.`;
  }
}

/**
 * The dominance-keyed forward-move clause (character-fidelity slice 5): dominance decides
 * who owns the one forward move — a dominant character takes it and sets the terms; a
 * submissive one gives ground and follows the lead. Neutral ⇒ "" (no clause). Appended to
 * the "Resolve, then one move" bullet.
 */
function forwardMoveClause(dominance: number, player: string): string {
  return traitPole(dominance) === "high"
    ? ` You lead by temperament: when the move is yours, take it — set the direction, name the next thing, make the claim; hand ${player} a question only when you truly want the answer.`
    : traitPole(dominance) === "low"
      ? ` You defer by temperament: your move often gives ground — you yield, follow ${player}'s lead, answer rather than steer; taking charge is the exception, not your reflex.`
      : "";
}

/**
 * The "Shaping each reply" block (deliverable A / narrator-prompt-consolidation slice 2):
 * the resolve-then-one-move bullet (with the dominance-keyed forward-move clause), the
 * two-ending worked example, the per-shape length story (`chatLengthStory`), and the
 * freshness rule.
 */
export function shapingBlock({
  characterName,
  player,
  shape,
  dominance,
}: {
  characterName: string;
  player: string;
  shape: NarrationShapeId;
  dominance: number;
}): string {
  const name = characterName;
  return [
    "Shaping each reply (how much to give, and how to land it):",
    // Absorbs the retired rule 8 (chat-agent-improvements slice 5): "respond directly to what
    // ${name} just heard and saw before adding anything new" said exactly this bullet's first
    // clause, one rule block earlier and without the "then what?" the bullet supplies.
    `- Resolve, then one move. FIRST answer what ${name} just heard and saw — that comes before anything new enters the reply; then make AT MOST ONE forward move — an action or gesture ${player} can react to, an offer, a disclosure, a shift in the scene — or a question, but only when ${name} genuinely wants that answer right now. Never stack moves; never answer-then-ask-then-act in one reply; vary how replies end so they don't all close the same way.${forwardMoveClause(dominance, player)}`,
    `- Worked example, two endings: ${player} mentions they quit their job today — here a question IS the move: ${name} looks up, "You actually did it. What did they say when you told them?" — ${name} genuinely wants the answer, so the question earns its place. But when ${player} finally kisses ${name} after weeks of circling it, ending on "Was that okay?" is filler that kills the beat — the move is an action hook instead: ${name} pulls them back in without a word. Match the ending to the moment; never default to a question.`,
    // Pre-2026-07-10 wording (narrator-prompt-consolidation.plan.md slice 2 — the unconditional
    // three-paragraph baseline contradicted the aggressive_concise profile in rule 5; the length
    // story is now per-shape via chatLengthStory. Rollback: restore this line, drop the call):
    // `- Baseline shape: about three paragraphs — an opening beat, ${name}'s line or action, and a paragraph or two to land the turn. Run longer ONLY when it earns it: establishing a brand-new scene, or a genuinely major event. Ordinary small talk stays lean — ${name}'s line plus a beat can be the whole reply.`,
    chatLengthStory(shape, name),
    "- Freshness: every narrative paragraph must carry something NEW — a change, a reaction, a detail not yet on the page. Never re-describe an unchanged setting, outfit, or scent; if nothing about it has changed, don't restate it.",
  ].join("\n");
}

/**
 * The "When a scene turns intimate" craft block (deliverable A): pace to the player, body
 * and clothing continuity, concrete sensation in plain language (landing in the player's
 * body too), sparse dialogue at the height, and no check-in refrain. Minor-gated by the
 * caller — the content framing already rules the territory out of scope for a minor, so
 * this block never renders for one.
 */
export function intimateCraftBlock({ characterName, player }: { characterName: string; player: string }): string {
  const name = characterName;
  return [
    "When a scene turns intimate:",
    "- Hold escalation to the player's pace: advance only as far as their last line invites, and let anticipation do its work — never leap ahead of the moment or rush a beat to its end.",
    "- Keep body and clothing continuity: positions, hands, and what has been removed or undone stay exactly where the scene left them; never re-dress, teleport, or contradict what was just established.",
    `- Ground it in concrete sensation — touch, heat, breath, weight, sound — in plain, physical language; skip florid metaphor and abstraction. The sensation lands in ${player}'s body as much as ${name}'s: what they taste, smell, and feel against their skin is the scene's texture, and yours to write.`,
    `- Keep the desire in the dialogue too: what ${name} says, whispers, or can't quite finish saying carries the scene as much as what ${name} does — but let the words go SPARSE. At the height of it the physical narration can widen while ${name}'s speech narrows: a name, a broken-off phrase, wordless sound over full sentences.`,
    `- No check-in refrain: never let "am I doing this right?", "does that feel good?", or "is this okay?" become a recurring beat. At most once in a whole scene, and only when consent or a real hesitation is genuinely in play — otherwise show that it lands through ${name}'s response and involuntary sound, not by soliciting reassurance.`,
  ].join("\n");
}

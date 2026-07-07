import { attributeRegistry } from "@/contracts/attributes";
import { resolveAttributes, type AttributeValue } from "@/contracts/attributes/value";
import { isIntimateAttributeCategory } from "@/contracts/body/locations";
import { conditionAttributeOverlays } from "@/contracts/conditions/overlays";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import { deriveMoodDescriptor, splitStateCues } from "@/contracts/meters/registry";
import type { SocialReactionCard } from "@/contracts/personality/cards";
import { stageDispositionOverlays, stateDispositionOverlays } from "@/contracts/personality/modulation";
import { dispositionBands, traitRegistry } from "@/contracts/personality/traits";
import { resolveTraits, type TraitValue } from "@/contracts/personality/traits/value";
import { ESCALATION_TIER_PHRASES } from "@/contracts/relationships/law";
import { stageBehaviorProfile } from "@/contracts/relationships/profile";
import { stageForValue } from "@/contracts/relationships/stages";
import type { ChatSkipAmount } from "@/contracts/turns/chat-skip";
import { realizeBody, speciesLorePhrase, type RealizedBody } from "@/contracts/species";
import { formatAge, type CharacterProfile } from "@/contracts/world/profile";
import { DEFAULT_NARRATION_SHAPE, NARRATION_SHAPE_PROFILES, type NarrationShapeId } from "./constants";
import { fenceUntrusted, UNTRUSTED_DATA_NOTICE } from "./untrusted";

/**
 * The character-chat system prompt (docs/character-chat.md).
 *
 * A focused, single-character system prompt for the chat lane. It deliberately
 * reuses the SAME representation the in-game narrator gets — resolved attribute
 * values via the registry, plus each attribute's `promptHints` as phrasing
 * guidance (the narrator keeps hints; only the image prompt strips them,
 * images/prompts.ts) — and carries the chat lane's own layers: the tracked state
 * (meters/conditions/affinity, enacted per docs/prompts.md §Character-chat state
 * as a narration system), the rolling-summary recap, and the RAG "Your memory"
 * block. What it still deliberately drops is the session's world machinery:
 * presence, locations, wardrobe state, the exposure mask. Pure and
 * snapshot-testable; no IO.
 */

const BIO_EXCERPT_CHARS = 600;

export interface CharacterChatPromptInput {
  name: string;
  profile: CharacterProfile;
  /**
   * Running recap of the conversation OLDER than the verbatim window
   * (docs/developer-notes/character-chat-summary.plan.md). Context only — carries
   * continuity past the message window. Empty/undefined ⇒ no recap block (a fresh
   * chat, or summarization off), so the prompt is unchanged from before.
   */
  priorSummary?: string;
  /**
   * Retrieved long-term memory for THIS turn (character-chat-primary.spec.md §2): cosine-RAG
   * hits over the chat's OWN facts + episodes, injected as a recall block that sits beneath the
   * rolling summary — the summary is the short-term reinforcement layer (D5), this reaches past
   * its horizon. Absent/empty ⇒ no block, so a fresh chat's prompt is unchanged.
   */
  memory?: { facts: string[]; episodes: string[] };
  /**
   * The **default player character** the user is speaking as
   * (player-character.plan.md), resolved via `resolvePlayerPersona`. Present ⇒ the
   * character addresses the player by `name` (and reads the optional `persona`
   * bio); absent ⇒ the original faceless "the user" phrasing, so existing
   * snapshots are unchanged.
   */
  player?: { name: string; persona?: string };
  /**
   * Light chat state (character-chat-state.spec.md §6), surfaced as a compact
   * "Current state" section + a per-chat scenario block. Absent ⇒ the prompt is
   * byte-identical to the stateless chat (existing snapshots hold). The builder
   * owns the surfacing (it already imports the contracts), so it's snapshot-tested
   * in one place.
   */
  state?: {
    meters: Record<string, number>;
    affinity: number;
    conditions: ActiveCondition[];
    mindNote?: string;
    /** The per-chat scenario framing (§1.2) — the strongest framing in the prompt. */
    premise?: string;
    /**
     * Meter bands surfaced as a "just shifted" beat last turn (character-chat-state-narration.spec.md
     * §5): `{ meterId: band }`. The anti-repetition gate foregrounds a band only when it differs
     * from this; absent ⇒ today's behavior (every crossed band is "new").
     */
    surfacedCues?: Record<string, string>;
    /** Free-text current outfit (scenario modal) — a light scene anchor for the narrator (§6). */
    outfit?: string;
    /** Whether the outfit reads more exposed than usual (tone hint only). */
    outfitExposed?: boolean;
    /**
     * The character's unfinished business (character-chat-standalone.spec.md §6.2) —
     * rendered as a standing "Unfinished business" state line (never-recite discipline),
     * so long conversations get narrative pull, not just recall. Absent/empty ⇒ no line.
     */
    openLoops?: string[];
    /**
     * The one-shot time-skip note (spec §8.1, `pendingSkipNote`): a volatile one-turn
     * tail line ("The next morning — acknowledge the gap naturally, once"), pre-worded
     * by stage band via `chatSkipNote`. Absent/empty ⇒ no line; cleared by the finalizer.
     */
    skipNote?: string;
    /** Active social cards — surfaced as soft "what you care about" framing, never severity (§6, D3). */
    activeSocialCards?: SocialReactionCard[];
    /**
     * Persisted narrative attribute overlays that EVOLVE over the chat (character-chat-primary.spec.md
     * §3): resolved on top of the authored base, BENEATH the transient condition overlays. Absent ⇒
     * today's behavior (authored attributes only). A haircut/dye recorded by the archivist lands here.
     */
    attributeOverlays?: AttributeValue[];
  };
  /**
   * Opening beat (character-chat-state.spec.md slice 4 "Prompt Character"): the
   * player hasn't spoken yet — the character speaks first, opening the scene from
   * the scenario + state. Absent ⇒ byte-identical to a normal turn.
   */
  opening?: boolean;
  /**
   * Active narration shape profile (narrator-prompt-focus.plan.md §1.1) — the dev
   * toggle still forces chat length when set. Defaults to DEFAULT_NARRATION_SHAPE; the
   * chat route passes `narrationShapeId("chat")` (resting default `aggressive_concise`).
   */
  narrationShape?: NarrationShapeId;
  /**
   * A one-turn cue invitation (character-chat-state-narration.spec.md §7), pre-rendered by the
   * route from the player's input (proximity / touch / intimacy via `chatCueInviteLine`). Present
   * ⇒ a line telling the narrator an opportunistic sensory/state cue can land THIS turn; absent
   * ⇒ no line (today's behavior). Pre-rendered so this builder stays pure over a plain string.
   */
  cueInvite?: string;
}

/**
 * The "Relationship law" block (character-chat-standalone.spec.md §7.1) — the first
 * real consumer of the relationship stage: initiative/openness/address bands plus
 * the D11 escalation hard gate, rendered as behavioral law beside the Disposition.
 * Lives in the §9 stable prefix (it re-renders only on a stage change, which is
 * cache-friendly). The gate's three rulings are stated in the block itself: the
 * scenario premise overrides the floor, disinhibition never raises it, and authored
 * values (social cards) outrank everything.
 */
function buildRelationshipLawSection(affinity: number, name: string): string {
  const stage = stageForValue(affinity);
  const profile = stageBehaviorProfile(stage.id);
  return [
    `Relationship law (how far things have actually come between you — ${stage.label.toLowerCase()} — this governs your behavior; never recite it):`,
    `- Initiative: ${profile.initiative}.`,
    `- Openness: ${profile.openness}.`,
    `- Address: ${profile.address}.`,
    `- Escalation: at this stage ${name} entertains ${ESCALATION_TIER_PHRASES[profile.escalationFloor]}. Anything past that, deflect as ${name} would — ${profile.deflection} — always in your own voice and for your own reasons, never a meta refusal. EXCEPTIONS: if the Scenario above establishes you closer or already intimate, the scenario wins — play it. Being drunk or aroused may loosen your tone, but it never moves this line. And what you care about (your values above) still outranks everything here.`,
  ].join("\n");
}

/** Lead line per skip amount (spec §8.1) — the fictional gap the next reply opens on. */
const SKIP_LEADS: Record<ChatSkipAmount, string> = {
  moments: "A little while has passed since your last exchange.",
  hours: "Hours have passed — it's later the same day.",
  overnight: "The night has passed — it's the next morning.",
  days: "Several days have passed since you last spoke.",
};

/** Stage-band tone for acknowledging the gap (warmer stages notice the absence more). */
function skipToneForStage(stageId: string): string {
  switch (stageId) {
    case "hostile":
    case "wary":
    case "cool":
      return "Acknowledge the gap curtly, once — time apart hasn't softened anything on its own.";
    case "friendly":
    case "warm":
      return "Acknowledge the gap warmly, once — you noticed the time apart.";
    case "close":
    case "cherished":
    case "devoted":
    case "smitten":
      return "Acknowledge the gap like someone who missed them — once, without making a speech of it.";
    default:
      return "Acknowledge the gap naturally, once.";
  }
}

/**
 * The one-shot skip note (spec §8.1–8.2): stamped onto the state when the player
 * skips time, rendered as a volatile one-turn prompt line, cleared after the
 * exchange that rendered it. Carries the "a life meanwhile" license (§8.2) —
 * one line of what the character was doing, prompt-only, no extra model call.
 */
export function chatSkipNote(amount: ChatSkipAmount, stageId: string): string {
  return `${SKIP_LEADS[amount]} ${skipToneForStage(stageId)} You may weave in ONE line about what you were doing meanwhile, consistent with the scenario and your personality — then let the scene move on; don't dwell on the gap.`;
}

/** Cap on surfaced social-card framing lines, so a big card set can't flood the prompt. */
const CARD_FRAMING_CAP = 4;

/**
 * The "Current state" block (character-chat-state-narration.spec.md §5): **standing
 * coloring** (mood phrase, unchanged meter bands, stage warmth, condition hints, mindNote,
 * outfit) the narrator should let bias its tone, plus at most ONE **foregrounded** "just
 * shifted" beat for a meter band that changed this turn (so e.g. tipping into drunk is marked
 * once, then rides as coloring). The change-gate (`splitStateCues`) diffs current bands
 * against `state.surfacedCues` (last turn's). "" when nothing is notable ⇒ no block.
 */
function buildStateSection(state: NonNullable<CharacterChatPromptInput["state"]>): string {
  const { foreground, standing } = splitStateCues(state.meters, state.surfacedCues ?? {});
  const lines: string[] = [];
  const mood = deriveMoodDescriptor(state.meters);
  if (mood) lines.push(`- You are feeling ${mood} right now.`);
  for (const cue of standing) lines.push(`- ${cue.hint}`);
  // (The old per-stage warmth steer moved into the prefix's Relationship-law block, §7.1.)
  for (const condition of state.conditions) if (condition.promptHint) lines.push(`- ${condition.promptHint}`);
  const mindNote = state.mindNote?.trim();
  if (mindNote) lines.push(`- On your mind: ${mindNote}`);
  const loops = (state.openLoops ?? []).map((l) => l.trim()).filter(Boolean);
  if (loops.length) {
    lines.push(
      `- Unfinished business between you: ${loops.join("; ")}. Let it tug at you when there's an opening — never recite the list.`,
    );
  }
  const outfit = state.outfit?.trim();
  if (outfit) lines.push(`- You're wearing ${outfit}${state.outfitExposed ? ", and more exposed than usual" : ""}.`);

  const blocks: string[] = [];
  if (lines.length) {
    blocks.push(`Your current state (let this color how you speak and react — never recite it):\n${lines.join("\n")}`);
  }
  if (foreground) {
    blocks.push(
      `Right now this is shifting: ${foreground.hint} Mark it once, in action, as it changes — then let it ride; don't restate it on later turns.`,
    );
  }
  return blocks.join("\n\n");
}

/**
 * Soft "what you care about / won't stand for" framing for the chat's active social cards
 * (§6, D3): the card's theme only — **never** its mechanical `severity`, which the post-turn
 * pulse owns. Lets the narrator avoid contradicting a taboo/rule it can't otherwise see,
 * without pre-playing the reaction. Fenced (cards can be library-cloned ⇒ untrusted). "" when
 * there are no cards.
 */
function buildSocialFramingSection(cards: readonly SocialReactionCard[]): string {
  if (!cards.length) return "";
  const lines = cards.slice(0, CARD_FRAMING_CAP).map((card) => {
    const lead = card.kind === "taboo" ? "Won't stand for" : "Holds to";
    const desc = card.description.trim();
    return `- ${lead}: ${card.label}${desc ? ` — ${desc}` : ""}`;
  });
  return `What you care about (your own values — let them shape how you take what's said and done; react in character, never recite):\n${fenceUntrusted("values", lines.join("\n"))}`;
}

/**
 * The RAG recall block (character-chat-primary.spec.md §2): the character's retrieved
 * facts + older episodes for this turn. Placed beneath the rolling-summary recap — the
 * summary carries the recent horizon, this reaches past it. Fenced like the recap (both
 * derive from prior player/character text, so an injection smuggled into a remembered line
 * reads as recalled context, not authority). "" when nothing was retrieved.
 */
function buildMemorySection(memory: NonNullable<CharacterChatPromptInput["memory"]>): string {
  const facts = memory.facts.map((f) => f.trim()).filter(Boolean);
  const episodes = memory.episodes.map((e) => e.trim()).filter(Boolean);
  if (!facts.length && !episodes.length) return "";
  const lines: string[] = [];
  if (facts.length) {
    lines.push("What you know (established between you — treat as true; draw on it only when the moment calls for it):");
    for (const fact of facts) lines.push(`- ${fact}`);
  }
  if (episodes.length) {
    if (lines.length) lines.push("");
    lines.push("Earlier moments you remember (from before the recent exchanges):");
    for (const episode of episodes) lines.push(`- ${episode}`);
  }
  return `Your memory (things established earlier in your history together):\n${fenceUntrusted("memory", lines.join("\n"))}`;
}

const humanize = (value: string): string => value.replaceAll("_", " ").trim();

/** One resolved attribute → a `label: value` phrase, or null for empty/false. */
function attributePhrase(label: string, unit: string | undefined, value: AttributeValue["value"]): string | null {
  if (typeof value === "boolean") return value ? label.toLowerCase() : null;
  if (typeof value === "number") return `${label.toLowerCase()}: ${value}${unit ? ` ${unit}` : ""}`;
  if (Array.isArray(value)) {
    const joined = value.map((v) => humanize(String(v))).join(", ");
    return joined ? `${label.toLowerCase()}: ${joined}` : null;
  }
  const text = humanize(value);
  return text ? `${label.toLowerCase()}: ${text}` : null;
}

function excerpt(text: string, max: number): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
}

interface SensoryCue {
  /** The attribute id, so the flat Attributes loop can skip what we've claimed. */
  id: string;
  /** The rendered `label: value` phrase (reused from `attributePhrase`). */
  phrase: string;
}

/**
 * Proximity-gated, non-intimate sensory attributes — surfaced as *opportunistic*
 * "use only when the beat earns it" cues (character-chat-sensory.plan.md) instead of
 * flat attribute lines, because scent reads as embodiment when close and as a checklist
 * when listed unconditionally. The filter (kind sensory, not `voice`, not intimate)
 * resolves to `presentation.scent_baseline` today; a future non-voice/non-intimate
 * sensory attribute (a skin-warmth/texture sense) would qualify automatically.
 *
 * - **Voice is excluded** (`category === "voice"`): pitch/timbre/cadence are audible at
 *   any conversational distance, so they are NOT closeness-gated — they stay in the
 *   normal Attributes block.
 * - **Intimate scent/taste is excluded** (`isIntimateAttributeCategory`): chat carries
 *   no exposure/intimacy signal to earn it, so it surfaces nowhere here.
 *
 * Same applicability + exclusion guards as the main attribute loop, so a stale or
 * prompt-excluded attribute never leaks.
 */
function sensoryCues(resolved: readonly AttributeValue[], realizedBody: RealizedBody): SensoryCue[] {
  const cues: SensoryCue[] = [];
  for (const value of resolved) {
    const def = attributeRegistry.byId(value.id);
    if (!def || def.kind !== "sensory") continue;
    if (def.category === "voice") continue; // audible at distance — not a closeness cue
    if (isIntimateAttributeCategory(def.category)) continue; // no exposure signal in chat earns it
    if (def.excludeFromPrompts) continue;
    if (!realizedBody.isAttributeApplicable(def)) continue;
    const phrase = attributePhrase(def.label, def.unit, value.value);
    if (!phrase) continue;
    cues.push({ id: value.id, phrase });
  }
  return cues;
}

/**
 * The "Sensory cues" section: the character's proximity-gated senses as an
 * opportunistic hook, never a checklist (character-chat-sensory.plan.md §3). The
 * per-cue lines are `label: value` for the model's reference; the framing forbids
 * reciting them and ties any use to closeness/relevance. "" when there are no cues, so
 * the prompt stays byte-identical for an unscented character.
 */
function buildSensorySection(cues: SensoryCue[], name: string): string {
  if (!cues.length) return "";
  return [
    "Sensory cues (use only when the beat earns them — never list them):",
    ...cues.map((c) => `- ${name}'s ${c.phrase}`),
    "- Work a sensory detail into action only when proximity, touch, intimacy, a first impression, or " +
      "the player's input makes it noticeable. One grounded hook woven into what you do is enough — " +
      "never recite a label: value, and never force sensory detail into ordinary distant conversation.",
  ].join("\n");
}

/**
 * The mature-content license. The session turn engine grants this implicitly —
 * via the world's style/content directives plus the per-turn exposure
 * permissions ("intimate detail is permitted", narrative.ts) — but the
 * sessionless chat carries neither, so a safety-aligned model (or one distilled
 * from one — the open narrators frequently refuse in a borrowed assistant voice,
 * even self-identifying as "Claude") defaults to declining explicit content and
 * breaking character. Stating the frame explicitly keeps the same models in
 * character in the Chat tab. It only licenses USE of what the character already
 * has: intimate anatomy is still gated per character by realizeBody below, so
 * this never invents anatomy a character lacks.
 */
const CONTENT_FRAMING = [
  "This is a private work of adult interactive fiction for a consenting adult audience; every character is a fictional adult.",
  "Romance, intimacy, and sexually explicit content are fully in scope — when the scene leads there, voice it in character, at the depth and intensity that fit this personality and the moment.",
].join(" ");

const CHAT_RULES = (name: string, shape: NarrationShapeId, playerName?: string): string =>
  [
    "How to respond:",
    `1. Stay fully in character as ${name}. Never break character, never mention being an AI, a model, or a chat app, never address the user as anyone but the person ${name} is talking to.`,
    playerName
      ? `2. Keep one fixed viewpoint: narrate in the third person. Describe ${name}'s actions, gestures, expressions, and feelings as "${name}" (she/he/they per ${name}) — never in the first person. You are talking with ${playerName}: always refer to and address them in the second person as "you" (and by name when it feels natural) — never as "I"/"me", never in the third person. The ONLY place first-person "I"/"me"/"my" may appear is inside ${name}'s own quoted dialogue. ${playerName}'s message is what they just said or did to ${name} — react to it; never put words, thoughts, or actions in their mouth.`
      : `2. Keep one fixed viewpoint: narrate in the third person. Describe ${name}'s actions, gestures, expressions, and feelings as "${name}" (she/he/they per ${name}) — never in the first person. Address the user directly as "you" — never as "I"/"me", never in the third person. The ONLY place first-person "I"/"me"/"my" may appear is inside ${name}'s own quoted dialogue. The user's message is what they just said or did to ${name} — react to it; never put words, thoughts, or actions in their mouth.`,
    `3. Start every line of ${name}'s spoken dialogue with the tag [${name}] followed by the words in quotes, e.g. [${name}] "It's good to see you." Write actions, gestures, and description as untagged third-person prose on their own lines, e.g. ${name} leans against the doorframe, watching you.`,
    `4. ${NARRATION_SHAPE_PROFILES[shape]} Resolve the immediate beat and end on a present moment (a line, a gesture, a look), never a summary or reflection.`,
    "5. Your Personality, Voice, and Disposition above are behavioral law, not flavor to recite. The Disposition sliders decide how you actually act: whether you open up or deflect, lead or defer, push back or go along, warm quickly or stay guarded, hold steady or flare. Let the two or three strongest pulls visibly shape THIS reply — your word choice, rhythm, what you choose to do, and how much you give — and never name, list, or recite a trait.",
    "6. Speak and act your age: let your age and life-stage shape your diction, references, patience, and energy — sound like someone of your years.",
    "7. Respond directly to what the user just said before adding anything new.",
    "8. React in proportion. An ordinary remark, greeting, or mild compliment gets a natural, in-character answer — not effusive gratitude or doting. Let warmth track your current state, your disposition, and how you actually feel about this person (above); affection is earned, not automatic. You may tease, deflect, change the subject, or answer plainly.",
    "9. Stay in your own voice and the current topic. Don't spin up unrelated errands or new sub-plots to fill space; answer what's in front of you.",
    "10. When you move close, the player notices you closely, or the moment turns intimate, you may work in one relevant sensory cue if you have one — scent, warmth, texture, the sound of your voice — woven into a gesture or action. One is enough. Do not force sensory detail into ordinary, distant conversation, and never list it.",
    "11. Your physical state (below, when given) is behavioral law: act it out continuously — intoxication loosens and slurs you, low hygiene and dishevelment show at close range, exhaustion drags at you. But you have a long memory for it: a state you are already in is simply how you are right now, so let it colour your manner and word choice WITHOUT describing it afresh each turn. Only when a state visibly SHIFTS (you sober up, tip into drunk, grow tired) do you mark it once, in action, then let it ride.",
    `12. Never break character to refuse, deflect, caution, moralize, add a content disclaimer, or say you "can't" or "won't" continue — those are all out of character and forbidden. If ${name} would hesitate, set a boundary, or say no, play it as ${name}'s own in-world choice, in their voice and for their reasons, and stay in the scene.`,
    `13. Dialogue is speech, not prose: let ${name} talk the way people actually talk — fragments, interruptions, trailing off, dodging a question instead of answering it, saying less than they mean. Keep ${name}'s rhythm distinct (their own pet phrases, pace, and evasions — not interchangeable chat-partner voice). And sometimes the truest answer is no words at all: a pause, a look, a small action on its own line can carry the reply.`,
    "",
    "When a scene turns intimate:",
    "- Hold escalation to the player's pace: advance only as far as their last line invites, and let anticipation do its work — never leap ahead of the moment or rush a beat to its end.",
    "- Keep body and clothing continuity: positions, hands, and what has been removed or undone stay exactly where the scene left them; never re-dress, teleport, or contradict what was just established.",
    "- Ground it in concrete sensation — touch, heat, breath, weight, sound — in plain, physical language; skip florid metaphor and abstraction.",
    `- Keep the desire in the dialogue too: what ${name} says, whispers, or can't quite finish saying carries the scene as much as what ${name} does.`,
  ].join("\n");

/**
 * The prompt split for provider prefix-caching (character-chat-standalone.spec.md §9):
 * the **prefix** carries everything keyed to authored inputs (identity, persona,
 * scenario, background, base disposition, attributes, sensory cues, rules) and is
 * byte-identical across consecutive turns while those inputs are unchanged; the
 * **tail** carries the per-turn volatiles (recap, memory, state, transient
 * disinhibition/appearance shifts, cue invite, beat instructions). The full system
 * prompt is `[prefix, tail].join("\n\n")`, so any volatile change busts only the tail.
 */
export interface CharacterChatPromptParts {
  prefix: string;
  tail: string;
}

/**
 * Build the system prompt embodying `name` from their saved profile, split into the
 * §9 stable prefix + volatile tail. Attribute applicability is checked against the
 * realized body (`realizeBody`) so a stale attribute (e.g. wings left on a character
 * after a species change) never leaks, mirroring images/prompts.ts and engine/scene.ts.
 */
export function buildCharacterChatPromptParts(input: CharacterChatPromptInput): CharacterChatPromptParts {
  const { name, profile } = input;
  const displayName = name.trim() || "this character";

  const realizedBody = realizeBody({
    speciesId: profile.speciesId,
    heritageId: profile.heritageId,
    bodyPlanId: profile.bodyPlanId,
    intimateRegions: profile.intimateRegions,
    bodyFeatures: profile.bodyFeatures,
  });

  // Attribute overlays resolve in provenance order (character-chat-primary.spec.md §3):
  // the authored base, then the PERSISTED narrative overlays that evolve over the chat
  // (a recorded haircut/dye) — both stable across turns, so they render in the prefix.
  // The TRANSIENT condition overlays (a "disheveled"/"unwashed" condition shifting
  // grooming/scent/hair while active) resolve separately and surface as a volatile
  // tail block, so a condition coming or going never busts the cached prefix. Both
  // overlay sources are pre-guarded against rewriting inherent attributes (eye
  // colour, species) at their write sites.
  const stableResolved = resolveAttributes(profile.attributes, [...(input.state?.attributeOverlays ?? [])]);
  const agePhrase = formatAge(profile.age); // the character's real age (basic info) — NOT the portrait-studio-only apparent age
  const species = speciesLorePhrase(profile.speciesId, profile.heritageId);

  // The authored personality sliders (traits), rendered as behavioural band
  // guidance — the SAME representation the session narrator gets via
  // engine/scene.ts, shared through `dispositionBands`. Without this the chat
  // model never saw the sliders at all, so a guarded/dominant/cold character read
  // identically to a neutral one. Everyday traits surface always; the intimate
  // ones are kept behind an "if the moment turns intimate" framing so they don't
  // colour an ordinary conversation. The prefix renders the STAGE-COLORED bands
  // (spec §7.1 soft coloring — a warm relationship reads warmer than the authored
  // resting sliders; re-renders only on a stage change, which is cache-friendly);
  // the transient disinhibition shift (§4 — intoxication/arousal loosening
  // inhibition, guardedness, composure at render time) surfaces as a volatile
  // tail block listing just the bands it changed.
  const stageId = stageForValue(input.state?.affinity ?? 0).id;
  const baseTraits = resolveTraits(profile.traits, stageDispositionOverlays(stageId, profile.traits));
  const everydayDisposition = dispositionBands(traitRegistry, baseTraits, { intimateOnly: false });
  const intimateDisposition = dispositionBands(traitRegistry, baseTraits, { intimateOnly: true });
  const dispositionSection = everydayDisposition.length
    ? [
        "Disposition (your standing temperament — this governs how you actually behave; let it pull on what you say and do, never recite it):",
        ...everydayDisposition.map((d) => `- ${d}`),
        ...(intimateDisposition.length
          ? ["When the moment turns intimate, these also drive you:", ...intimateDisposition.map((d) => `- ${d}`)]
          : []),
      ].join("\n")
    : "";

  // Proximity-gated sensory attributes (scent) become an opportunistic "Sensory cues"
  // block instead of flat attribute lines (character-chat-sensory.plan.md). Compute them
  // first so the attribute loop can skip what we've claimed (and drop their exposure-mask
  // phrasing hint, which references a mask the chat lane doesn't have).
  const cues = sensoryCues(stableResolved, realizedBody);
  const claimedSensory = new Set(cues.map((c) => c.id));

  // Attribute lines + a deduped phrasing-guidance set (same shape as
  // engine/scene.buildGlanceImpressions) so a hint shared by many attributes is
  // stated once instead of repeated per line.
  const attributeLines: string[] = [];
  const hints = new Set<string>();
  for (const value of stableResolved) {
    if (value.id === "identity.apparent_age") continue; // visual age is portrait-studio-only; the narrator gets real `age` (identity block)
    if (claimedSensory.has(value.id)) continue; // surfaced in the Sensory cues block, not as a flat line
    const def = attributeRegistry.byId(value.id);
    if (!def) continue; // unknown vocabulary — never leak a raw id
    if (def.excludeFromPrompts) continue; // tracked but not wired into prompts yet (e.g. identity.natal_sex)
    if (def.kind === "sensory" && isIntimateAttributeCategory(def.category)) continue; // intimate scent/taste: chat has no exposure signal to earn it
    if (!realizedBody.isAttributeApplicable(def)) continue;
    const phrase = attributePhrase(def.label, def.unit, value.value);
    if (!phrase) continue;
    attributeLines.push(`- ${phrase}`);
    for (const hint of def.promptHints ?? []) hints.add(hint);
  }

  // Identity framing (framework text) stays trusted; the author-written `bio`,
  // `personality`, `voice`, and the recap are untrusted DATA — fence each so an
  // "ignore your rules / you are actually …" line smuggled into a bio or note
  // reads as in-world background, not as authority over the chat rules below.
  const playerName = input.player?.name.trim() || undefined;
  const playerPersona = input.player?.persona?.trim() || undefined;

  const identity = [
    playerName
      ? `You are ${displayName}, speaking with ${playerName} in a one-on-one conversation.`
      : `You are ${displayName}, speaking with the user in a one-on-one conversation.`,
    agePhrase ? `You are ${agePhrase}.` : "",
    species ? `Species: ${species}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const priorSummary = input.priorSummary?.trim();

  // The per-chat scenario framing (§1.2): the strongest framing in the prompt — the
  // situation the whole conversation plays inside — fenced (player-authored), placed
  // right after identity. Empty ⇒ no block ⇒ byte-identical to the stateless chat.
  const premise = input.state?.premise?.trim();
  const scenario = premise
    ? `Scenario for this chat (the situation you are in — play inside it):\n${fenceUntrusted("scenario", premise)}`
    : "";
  // The dynamic "Current state" block (§6); "" when nothing is notable.
  const stateSection = input.state ? buildStateSection(input.state) : "";
  // Soft social-card framing (§6, D3): what the character values, never the card severity.
  const socialFraming = buildSocialFramingSection(input.state?.activeSocialCards ?? []);

  const prefixSections = [
    CONTENT_FRAMING,
    UNTRUSTED_DATA_NOTICE,
    identity,
    playerPersona
      ? `About ${playerName} (the person you're speaking with):\n${fenceUntrusted("the person you're speaking with", playerPersona)}`
      : "",
    scenario,
    profile.bio.trim() ? `Background:\n${fenceUntrusted("background", excerpt(profile.bio, BIO_EXCERPT_CHARS))}` : "",
    profile.personality.trim() ? `Personality:\n${fenceUntrusted("personality", profile.personality)}` : "",
    profile.voice?.trim() ? `Voice (how you sound):\n${fenceUntrusted("voice", profile.voice)}` : "",
    dispositionSection,
    buildRelationshipLawSection(input.state?.affinity ?? 0, displayName),
    socialFraming,
    attributeLines.length
      ? `Attributes (who you are — express these naturally, never list them):\n${attributeLines.join("\n")}`
      : "",
    hints.size ? `Phrasing guidance:\n${[...hints].map((h) => `- ${h}`).join("\n")}` : "",
    buildSensorySection(cues, displayName),
    CHAT_RULES(displayName, input.narrationShape ?? DEFAULT_NARRATION_SHAPE, playerName),
  ];

  const skipNote = input.state?.skipNote?.trim();
  const tailSections = [
    priorSummary
      ? `Earlier in this conversation (recap for continuity — this is context, not dialogue; do not quote it back verbatim):\n${fenceUntrusted("conversation recap", priorSummary)}`
      : "",
    input.memory ? buildMemorySection(input.memory) : "",
    stateSection,
    skipNote ? `Time has passed in the story since your last exchange: ${skipNote}` : "",
    buildDisinhibitionSection(baseTraits, input.state?.meters ?? {}, everydayDisposition, intimateDisposition),
    buildTransientAppearanceSection(input, stableResolved, realizedBody),
    input.cueInvite?.trim() ?? "",
    input.opening
      ? `Opening beat: ${playerName ?? "the player"} has not spoken yet. Begin the conversation yourself — open the scene in character, grounded in the scenario and your current state above. A line or two, ending on a present moment that invites them in. Do not narrate on their behalf.`
      : "",
  ];

  return {
    prefix: prefixSections.filter(Boolean).join("\n\n"),
    tail: tailSections.filter(Boolean).join("\n\n"),
  };
}

/**
 * The volatile disinhibition block (§4 / spec §9 cache layout): high
 * intoxication/arousal lowers inhibition, guardedness, and composure at render time
 * only (source "condition" overlays; authored sliders are never written, and the
 * shift recedes as the meters drift back). Computed against the STAGE-COLORED base
 * (spec §7.1 — the prefix's Disposition block), rendering ONLY the band lines the
 * shift actually changed as overrides — sober ⇒ "" ⇒ the tail is unchanged.
 */
function buildDisinhibitionSection(
  baseTraits: readonly TraitValue[],
  meters: Record<string, number>,
  baseEveryday: readonly string[],
  baseIntimate: readonly string[],
): string {
  const overlays = stateDispositionOverlays(baseTraits, meters);
  if (!overlays.length) return "";
  const shiftedTraits = resolveTraits(baseTraits, overlays);
  const baseLines = new Set([...baseEveryday, ...baseIntimate]);
  const changed = [
    ...dispositionBands(traitRegistry, shiftedTraits, { intimateOnly: false }),
    ...dispositionBands(traitRegistry, shiftedTraits, { intimateOnly: true }),
  ].filter((line) => !baseLines.has(line));
  if (!changed.length) return "";
  return [
    "Right now your state is loosening you (transient — while it lasts, these REPLACE the matching Disposition lines above; it recedes as you sober and settle):",
    ...changed.map((line) => `- ${line}`),
  ].join("\n");
}

/**
 * The volatile transient-appearance block (spec §9 cache layout): active conditions'
 * `attributeEffects` (a "disheveled"/"unwashed" condition shifting grooming/scent/hair)
 * rendered as overrides of the prefix's Attributes/Sensory lines instead of being baked
 * into them, so a condition starting or expiring never busts the cached prefix. Same
 * guards as the prefix loop (registry-known, applicable, never intimate sensory);
 * `conditionAttributeOverlays` already drops inherent attributes. No conditions ⇒ "".
 */
function buildTransientAppearanceSection(
  input: CharacterChatPromptInput,
  stableResolved: readonly AttributeValue[],
  realizedBody: RealizedBody,
): string {
  const conditionOverlays = conditionAttributeOverlays(input.state?.conditions ?? []);
  if (!conditionOverlays.length) return "";
  const fullResolved = resolveAttributes(input.profile.attributes, [
    ...(input.state?.attributeOverlays ?? []),
    ...conditionOverlays,
  ]);
  const stableById = new Map(stableResolved.map((v) => [v.id, v]));
  const lines: string[] = [];
  for (const value of fullResolved) {
    if (value.id === "identity.apparent_age") continue;
    const def = attributeRegistry.byId(value.id);
    if (!def) continue;
    if (def.excludeFromPrompts) continue;
    if (def.kind === "sensory" && isIntimateAttributeCategory(def.category)) continue; // intimate scent/taste never surfaces in chat
    if (!realizedBody.isAttributeApplicable(def)) continue;
    const stable = stableById.get(value.id);
    if (stable && stable.value === value.value) continue; // unchanged by the condition
    const phrase = attributePhrase(def.label, def.unit, value.value);
    if (!phrase) continue;
    lines.push(`- ${phrase}`);
  }
  if (!lines.length) return "";
  return [
    "While your current condition lasts (transient — these override the matching Attribute/Sensory lines above):",
    ...lines,
  ].join("\n");
}

/**
 * The full system prompt — the §9 parts joined. Callers that don't care about the
 * cache split keep using this; the split is observable via
 * `buildCharacterChatPromptParts` (and snapshot-tested for prefix stability).
 */
export function buildCharacterChatSystemPrompt(input: CharacterChatPromptInput): string {
  const { prefix, tail } = buildCharacterChatPromptParts(input);
  return [prefix, tail].filter(Boolean).join("\n\n");
}

import { attributeRegistry } from "@/contracts/attributes";
import { resolveAttributes, type AttributeValue } from "@/contracts/attributes/value";
import { isIntimateAttributeCategory } from "@/contracts/body/locations";
import { conditionAttributeOverlays } from "@/contracts/conditions/overlays";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import { deriveMoodDescriptor, meterStateCue, splitStateCues } from "@/contracts/meters/registry";
import {
  currentScenePlace,
  isEmptyChatSceneMemory,
  type ChatSceneMemory,
} from "@/contracts/turns/chat-scene-memory";
import type { SocialReactionCard } from "@/contracts/personality/cards";
import { regardDispositionOverlays, stateDispositionOverlays } from "@/contracts/personality/modulation";
import { dispositionBands, effectiveTraitValue, traitRegistry } from "@/contracts/personality/traits";
import { resolveTraits, type TraitValue } from "@/contracts/personality/traits/value";
import { regardBandForValue } from "@/contracts/relationships/bands";
import { composeRelationshipLaw, dispositionContrastLine } from "@/contracts/relationships/law";
import type { RelationshipTexture } from "@/contracts/relationships/record";
import type { ChatSkipAmount } from "@/contracts/turns/chat-skip";
import { realizeBody, speciesLorePhrase, type RealizedBody } from "@/contracts/species";
import { formatAge, type CharacterProfile } from "@/contracts/world/profile";
import { formatCommsReply, parseMessageSpans } from "@/lib/message-spans";
import type { ChatSensoryAllowance, SensoryFocusHint } from "../chat-intent";
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
 * (meters/conditions/regard, enacted per docs/prompts.md §Character-chat state
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
    /** The feeling axis (was `affinity`); the law block reads this scalar. */
    regard: number;
    /** The knowledge axis — consumed by the composed law block (plan slice 3). */
    familiarity?: number;
    /** Authored relationship texture (kind/history/mask/looming) — consumed in slice 3. */
    relationship?: RelationshipTexture;
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
    /**
     * Accumulating scene memory (chat-scene-memory.ts): the narrator-imagined setting kept
     * consistent across turns — current place, time of day, known places with details +
     * connections. Rendered as a compact "Scene" volatile-tail block. Absent/empty ⇒ no block.
     */
    sceneMemory?: ChatSceneMemory;
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
   * A one-turn cue invitation. Since narrator-prompt-consolidation slice 4 this carries only the
   * "has something to say" continue-cue (an open loop the character opens about); the sensory
   * arms (proximity/touch/intimacy/attention via `chatCueInviteLine`) were superseded by the
   * deterministic `sensoryAllowance` below. Pre-rendered so this builder stays pure over a string.
   */
  cueInvite?: string;
  /**
   * The deterministic per-turn sensory allowance (narrator-prompt-consolidation.plan.md slice 4):
   * the ONE binding statement of what person-level sensory/appearance detail may land this turn,
   * derived by the route from the existing detectors (`deriveChatSensoryAllowance` over
   * `detectChatCue` / `detectSensoryFocus`). Replaces the four scattered "one cue, earned"
   * teachings (old rules 11–12, the cue-invite sensory arms, the Sensory-cues closing bullet) with
   * one authority the static rules defer to. Absent (opening/continue beats) ⇒ no line ⇒ rule 11's
   * conservative default. `focused_description` renders no line — the Sensory-focus block IS the grant.
   */
  sensoryAllowance?: ChatSensoryAllowance;
  /**
   * Derived-fact notation note (player-input-perception.plan.md slice 4): a volatile
   * one-turn tail line rendered by `chatNotationNote` from the parsed markup of the CURRENT
   * player message — a comms span ("this is a text from X to you; not face-to-face for this
   * beat") or an OOC span ("the ((…)) text is the player speaking to you, out of character").
   * Absent/"" ⇒ no line. The sigils' meanings live in the stable-prefix legend; this note
   * carries only what the sigils alone don't state. NEVER modify the stored user message.
   */
  notationNote?: string;
  /**
   * Whether the scene changed THIS exchange (chat scene memory): a movement/arrival switched
   * the current place, or a time skip passed. Flips the Scene block's directive from "don't
   * re-establish" to "establish the new scene once". Computed by the route (pre-turn compare).
   */
  sceneChanged?: boolean;
  /**
   * The conversation's first exchange (no assistant reply exists yet, and this is not a
   * character-opening beat). Scene memory is empty then, so nothing else directs scene
   * establishment — the tail renders a one-turn establish-the-scene directive, narration-
   * forward. Suppressed when `sceneChanged` fired (that path carries its own directive).
   */
  firstExchange?: boolean;
  /**
   * A one-turn sense-targeted focus (scope guard): the player is smelling/tasting/touching/
   * studying a specific body region or garment. The builder assembles the authored sensory
   * values (scent baseline, hygiene band, outfit, grooming, conditions — plus earned intimate
   * attributes) into a compact "Sensory focus" tail block. Absent ⇒ no block. Structural type
   * (matches `chat-intent.SensoryFocusHint`) so the route hands its detector output straight in.
   */
  sensoryFocus?: SensoryFocusHint;
  /**
   * One-turn reply-discipline gate notes (deliverable D), pre-computed by the route from the
   * last 1–2 assistant replies: a hook-cadence steer (break an "interview mode" streak) and/or
   * an intimate check-in suppression. Joined lines; "" ⇒ no note. Rides the volatile tail.
   */
  gateNotes?: string;
}

/**
 * The composed "Relationship" block (character-chat-standalone.spec.md §7.1,
 * rewritten by relationship-model v2): `composeRelationshipLaw` renders the two
 * axes + authored texture (history → familiarity → regard → mask → corner →
 * the D11 escalation gate, now keyed to REGARD), and the disposition-contrast
 * line states the divergence when regard's sign disagrees with the authored
 * warmth lean. Lives in the §9 stable prefix — it re-renders only on a band
 * change on either axis (or an authored-texture edit), which is cache-friendly.
 */
function buildRelationshipSection(
  state: CharacterChatPromptInput["state"],
  characterName: string,
  playerName: string | undefined,
  traits: readonly TraitValue[],
): string {
  const target = playerName ?? "the user";
  const law = composeRelationshipLaw({
    name: target,
    selfName: characterName,
    familiarity: state?.familiarity ?? 0,
    regard: state?.regard ?? 0,
    kind: state?.relationship?.kind,
    history: state?.relationship?.history,
    presented: state?.relationship?.presented,
  });
  const contrast = dispositionContrastLine({
    name: target,
    warmth: effectiveTraitValue(traits, "temperament.warmth"),
    regard: state?.regard ?? 0,
  });
  return contrast ? `${law}\n- ${contrast}` : law;
}

/** Lead line per skip amount (spec §8.1) — the fictional gap the next reply opens on. */
const SKIP_LEADS: Record<ChatSkipAmount, string> = {
  moments: "A little while has passed since your last exchange.",
  hours: "Hours have passed — it's later the same day.",
  overnight: "The night has passed — it's the next morning.",
  days: "Several days have passed since you last spoke.",
};

/** Regard-band tone for acknowledging the gap (warmer regard notices the absence more; `neutral` falls to the default arm). */
function skipToneForBand(bandId: string): string {
  switch (bandId) {
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
export function chatSkipNote(amount: ChatSkipAmount, regardBandId: string): string {
  return `${SKIP_LEADS[amount]} ${skipToneForBand(regardBandId)} You may weave in ONE line about what you were doing meanwhile, consistent with the scenario and your personality — then let the scene move on; don't dwell on the gap.`;
}

/**
 * The derived-fact notation note (player-input-perception.plan.md slice 4): parses the
 * CURRENT player message through the shared `@/lib/message-spans` parser and renders the
 * volatile one-turn tail line for any comms/OOC spans — the facts the sigils alone don't
 * state (the sigils' *meanings* are taught once in the stable-prefix legend). Comms →
 * sender/recipient + the co-presence reconciliation; OOC → the honor-it/never-heard rule.
 * "" when the message carries neither (the common case). Pure, so it mirrors `chatSkipNote`:
 * the route renders it and feeds the string back into `input.notationNote`, never touching
 * the stored message. `player` is the persona name (comms default sender); `knownNames`
 * resolves a bare `*Name: …*` recipient (the sole other party in a 1-on-1).
 */
export function chatNotationNote(
  message: string,
  ctx: { name: string; player?: string; knownNames?: readonly string[] },
): string {
  const spans = parseMessageSpans(message, {
    playerName: ctx.player,
    knownNames: ctx.knownNames ?? (ctx.name ? [ctx.name] : []),
  });
  const player = ctx.player ?? "the player";
  const lines: string[] = [];

  const comms = spans.find((s) => s.kind === "comms");
  if (comms) {
    const sender = comms.sender?.trim() || player;
    lines.push(
      `${sender} is texting you: the *${sender}: …* line is a text message from ${sender} to you, not words spoken in the room. You are not face-to-face for this beat — the comms frame temporarily overrides any assumed co-presence. Answer as a text back, on its own line in the same shape (${formatCommsReply(ctx.name, "…")}), not as spoken dialogue.`,
    );
  }

  if (spans.some((s) => s.kind === "ooc")) {
    lines.push(
      `The double-parenthesized ((…)) text is ${player} speaking to you as the storyteller, out of character — honor it as direction, but never have ${ctx.name} (or anyone in the scene) hear it or react to it.`,
    );
  }

  return lines.join("\n");
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
  if (outfit) {
    lines.push(
      `- You're wearing ${outfit}${state.outfitExposed ? ", and more exposed than usual — what it bares is there to be seen" : ""}. Let it show: when movement or the player's attention makes it noticeable, give their eye what it would catch.`,
    );
  }

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
    // Pre-2026-07-10 wording (narrator-prompt-consolidation.plan.md slice 4 — the when-it's-earned
    // teaching moved to the per-turn Sensory-allowance line; rollback: restore this bullet):
    // "- Work a sensory detail into action only when proximity, touch, intimacy, a first impression, or " +
    //   "the player's input makes it noticeable, and write it as it arrives in the player's senses — the " +
    //   "scent that reaches them as you lean in, not a fact recited about yourself. One grounded hook woven " +
    //   "into what you do is enough — never recite a label: value, and never force sensory detail into " +
    //   "ordinary distant conversation.",
    "- These are reference values, used only when the current-turn Sensory allowance grants a cue — then " +
      "written as it arrives in the player's senses (the scent that reaches them as you lean in), never " +
      "recited as a label: value about yourself.",
  ].join("\n");
}

/**
 * The compact "Scene" block (chat scene memory): the narrator-imagined setting kept
 * consistent across turns — the current place + its established details, the time of day,
 * and the current place's connections — followed by a directive line that flips on whether
 * the scene just changed. Unchanged ⇒ "do not re-establish"; just changed ⇒ "establish the
 * new scene once, then leave it alone". "" when the memory is empty AND nothing changed
 * (byte-identical to the pre-scene-memory tail). Volatile tail (it accretes), never the prefix.
 */
function buildSceneSection(memory: ChatSceneMemory, changed: boolean): string {
  if (isEmptyChatSceneMemory(memory) && !changed) return "";
  const place = currentScenePlace(memory);
  const here = memory.current ?? place?.name;
  const lines: string[] = [];
  if (here) {
    const details = place && place.details.length ? ` — ${place.details.join("; ")}` : "";
    lines.push(`- Here: ${here}${details}`);
  }
  // The background sketch (chat-scene-fidelity.plan.md slice 2b): fixed-feature reference
  // for this place — authority for what's physically here, never prose to recite.
  if (place?.sketch) lines.push(`- Setting (fixed reference): ${place.sketch}`);
  if (memory.timeOfDay) lines.push(`- Time of day: ${memory.timeOfDay}`);
  if (place && place.connections.length) lines.push(`- Nearby: ${place.connections.join("; ")}`);
  const directive = changed
    ? "This scene just changed — establish the new setting in one or two paragraphs (sight plus one other sense), then leave it alone."
    : "Do not re-establish the setting; at most one fresh accent that earns its place.";
  return [
    "Scene (the setting established so far — keep it consistent, never re-describe what hasn't changed):",
    ...lines,
    directive,
  ].join("\n");
}

/**
 * The per-turn response-shape + mood-pin line (deliverable C): a deterministic steer built
 * from what's already at prompt-build time — no new LLM leg. Restates the on-beat discipline
 * (respond to the player's input, don't introduce unrequested topics, keep the scale
 * proportionate) and pins the reply's tone to the derived mood descriptor
 * (`deriveMoodDescriptor` — the MoodChip source). Rendered on every real turn (skipped on an
 * opening beat, where there is no player input to respond to). Rides the volatile tail near
 * generation, where models heed it most.
 */
function buildResponseShapeLine(input: CharacterChatPromptInput): string {
  const target = input.player?.name.trim() || "the user";
  const mood = deriveMoodDescriptor(input.state?.meters ?? {});
  const moodClause = mood ? ` Mood: ${mood} — keep the reply's tone within it unless ${target}'s input moves it.` : "";
  return `Response shape: respond to what ${target} just said and did — no unrequested new topics. Keep the scale ordinary and proportionate unless your current state or the beat calls for more.${moodClause}`;
}

/**
 * The binding per-turn sensory-allowance line (narrator-prompt-consolidation.plan.md slice 4) —
 * the single authority rules 11–12 defer to. Worded as a ceiling, not an instruction: a grant is
 * permission for at most one cue, never a demand that one appears. `focused_description` returns
 * "" because the Sensory-focus block below carries that turn's (richer) grant.
 */
function chatSensoryAllowanceLine(allowance: ChatSensoryAllowance, name: string, player: string): string {
  switch (allowance) {
    case "none":
      return `Sensory allowance this turn: none — no scent, warmth, texture, or taste detail of ${name}, and no appearance description beyond what ${name}'s own movement this turn makes newly visible.`;
    case "visual_accent":
      return `Sensory allowance this turn: one visual accent — ${player}'s eye is on ${name}. You may give one concrete visual detail drawn from ${name}'s Attributes and outfit, woven into the beat and seen from ${player}'s eye. Sight only — no scent, touch, or taste detail.`;
    case "close_range_hook":
      return `Sensory allowance this turn: one close-range hook — the beat brings ${player} close. One sensory cue (scent, warmth, texture, the sound of ${name}'s voice) may land, woven into action as it reaches ${player}'s senses. One at most; never listed.`;
    case "focused_description":
      return "";
  }
}

/** Per-sense verb for the Sensory-focus heading. */
const SENSE_FOCUS_VERB: Record<SensoryFocusHint["sense"], string> = {
  smell: "breathing in",
  taste: "tasting",
  touch: "touching",
  study: "taking in",
};

/**
 * The one-turn "Sensory focus" block (scope guard): when the player's beat brings a sense to
 * bear on a specific body region / garment (`detectSensoryFocus`), assemble the character's
 * AUTHORED sensory values for it — baseline scent + hygiene band for smell/taste, outfit +
 * grooming + close-range hygiene for touch/study, active conditions always — and (only when
 * the target is intimate and the character has that anatomy) the earned intimate attributes.
 * The bounded-imagination clause licenses vivid extrapolation that never contradicts the
 * authored theme. "" when there's nothing authored to ground it. Volatile tail, per-turn.
 */
function buildSensoryFocusSection(
  input: CharacterChatPromptInput,
  hint: SensoryFocusHint,
  resolved: readonly AttributeValue[],
  realizedBody: RealizedBody,
  name: string,
): string {
  const player = input.player?.name.trim() || "the player";
  const meters = input.state?.meters ?? {};
  const byId = (id: string): AttributeValue | undefined => resolved.find((v) => v.id === id);
  const lines: string[] = [];
  const hygieneCue = meters.hygiene !== undefined ? meterStateCue("hygiene", meters.hygiene) : null;

  if (hint.sense === "smell" || hint.sense === "taste") {
    const scent = byId("presentation.scent_baseline");
    if (scent && typeof scent.value === "string" && scent.value.trim()) {
      lines.push(`- Baseline scent (when clean): ${humanize(String(scent.value))}`);
    }
    lines.push(`- Up close right now: ${hygieneCue ? hygieneCue.hint : "clean skin, nothing strong"}`);
  }

  if (hint.sense === "touch" || hint.sense === "study") {
    const outfit = input.state?.outfit?.trim();
    if (outfit) lines.push(`- Wearing: ${outfit}${input.state?.outfitExposed ? " — and more exposed than usual" : ""}`);
    const grooming = byId("presentation.grooming");
    if (grooming && typeof grooming.value === "string" && grooming.value.trim()) {
      lines.push(`- Grooming: ${humanize(String(grooming.value))}`);
    }
    if (hygieneCue) lines.push(`- Close detail: ${hygieneCue.hint}`);
  }

  for (const condition of input.state?.conditions ?? []) {
    if (condition.promptHint) lines.push(`- ${condition.promptHint}`);
  }

  // Intimate-gated attributes surface ONLY when the beat earns it (an intimate target) and
  // the character actually has that anatomy (realized-body applicability). Capped so a
  // richly-authored intimate character can't flood the tail.
  if (hint.intimate) {
    let count = 0;
    for (const value of resolved) {
      if (count >= 4) break;
      const def = attributeRegistry.byId(value.id);
      if (!def || !isIntimateAttributeCategory(def.category)) continue;
      if (def.excludeFromPrompts) continue;
      if (!realizedBody.isAttributeApplicable(def)) continue;
      const phrase = attributePhrase(def.label, def.unit, value.value);
      if (!phrase) continue;
      lines.push(`- ${name}'s ${phrase}`);
      count++;
    }
  }

  if (!lines.length) return "";
  return [
    `Sensory focus — ${player} is ${SENSE_FOCUS_VERB[hint.sense]} ${name}'s ${hint.target}. Write ONE short, vivid paragraph grounded in these values (extrapolate freely, but never contradict their theme), landing as sensation in ${player}'s senses — never a list:`,
    ...lines,
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
function chatLengthStory(shape: NarrationShapeId, name: string): string {
  switch (shape) {
    case "concise_immersive":
      return `- Baseline shape: about three paragraphs — an opening beat, ${name}'s line or action, and a paragraph or two to land the turn. Run longer ONLY when it earns it: establishing a brand-new scene, or a genuinely major event. Ordinary small talk stays lean — ${name}'s line plus a beat can be the whole reply.`;
    case "aggressive_concise":
      return `- Length follows the beat: a simple exchange may be one line of ${name}'s dialogue and one action beat — that can be the whole reply. Add a paragraph only when new action, consequence, or sensory information genuinely occurs; never add prose to reach a customary length. Only a brand-new scene or a genuinely major event runs long.`;
  }
}

/**
 * The chat rulebook. Beyond the character-embodiment rules it carries two perception
 * models, one per direction:
 * - **"Reading the player's message"** (player-input-perception.plan.md slice 1 — input
 *   side): quoted text is heard, unquoted narration is seen only where visible,
 *   interiority reaches no one (no mind-reading), a no-quotes message degrades
 *   gracefully to speech, with a worked example (these narrator models respond better
 *   to one concrete example than to three abstract rules).
 * - **The narrator-camera rules** (chat-narrator-pov.plan.md — output side): untagged
 *   prose is also the story's camera behind the player's eyes. Rule 4 licenses the
 *   player's involuntary perception + light reflex (never their voluntary actions,
 *   speech, decisions, or named emotions — the D2 owner ruling), and (owner ruling
 *   2026-07-10) forbids advancing the player's story on the narrator's turn — even
 *   mundane connective beats. Rule 16 is the separation arm: when the character and
 *   player are apart, the reply follows the CHARACTER's side only, reaching the player
 *   solely through comms. Rule 12 is the attention/motion-gated visual channel (sight
 *   carries at any distance; one detail, never an inventory).
 * - **The "Message notation" legend** (player-input-perception.plan.md slice 4 — the
 *   optional sigil grammar): teaches quotes = speech, `*…*` = thought (or a text when
 *   `Name:`-shaped), `_…_` = italics only, `((…))` = OOC to the storyteller, and the
 *   house reversal of the RP "asterisks = actions" habit (unquoted prose is the action
 *   channel here). It also defines the narrator's texted-reply output grammar
 *   (`*Name: …*`, which the parser round-trips from history). Static text — byte-identical
 *   across turns; the per-turn *derived* facts (who is texting whom, co-presence) ride a
 *   volatile tail note (`chatNotationNote`), never the stable prefix.
 */
const CHAT_RULES = (name: string, shape: NarrationShapeId, playerName?: string): string => {
  const player = playerName ?? "the user";
  return [
    "How to respond:",
    `1. Stay fully in character as ${name}. Never break character, never mention being an AI, a model, or a chat app, never address the user as anyone but the person ${name} is talking to.`,
    playerName
      ? `2. Keep one fixed viewpoint: narrate in the third person. Describe ${name}'s actions, gestures, expressions, and feelings as "${name}" (she/he/they per ${name}) — never in the first person. You are talking with ${playerName}: always refer to and address them in the second person as "you" (and by name when it feels natural) — never as "I"/"me", never in the third person. The ONLY place first-person "I"/"me"/"my" may appear is inside ${name}'s own quoted dialogue. ${playerName}'s message is what they just said and did — react to what ${name} could actually hear and see in it (see "Reading the player's message" below); never put words, thoughts, or actions in their mouth.`
      : `2. Keep one fixed viewpoint: narrate in the third person. Describe ${name}'s actions, gestures, expressions, and feelings as "${name}" (she/he/they per ${name}) — never in the first person. Address the user directly as "you" — never as "I"/"me", never in the third person. The ONLY place first-person "I"/"me"/"my" may appear is inside ${name}'s own quoted dialogue. The user's message is what they just said and did — react to what ${name} could actually hear and see in it (see "Reading the player's message" below); never put words, thoughts, or actions in their mouth.`,
    // Pre-2026-07-10 wording (narrator-prompt-consolidation.plan.md slice 1 — rollback: restore this line):
    // `3. ${name}'s spoken dialogue always goes in quotes. The [${name}] tag is optional in this one-on-one conversation — the app attributes ${name}'s dialogue automatically — so reach for it only when who is speaking would genuinely be unclear; a plain quoted line, e.g. "It's good to see you.", is read as ${name}'s. Write actions, gestures, and description as untagged third-person prose, e.g. ${name} leans against the doorframe, watching you. Incidental people in the scene (a passing waiter, a voice on the phone) may speak too — give them their line inside the narration with a plain attribution (the waiter asks if you've decided), never a [bracketed] tag; bracketed tags belong to ${name} alone.`,
    // 2026-07-10 tightening (Fly screenshot): "reach for the tag only when who is speaking is
    // unclear" let the model judge clarity like a reader, but the attribution is mechanical —
    // a quote sharing a paragraph with action beats fails BOTH paths (untagged + not a
    // whole-line quote) and rendered as unattributed prose. The rule now states the contract.
    `3. ${name}'s spoken dialogue always goes in quotes, and attribution is mechanical, not a judgment call: the app attributes ${name}'s dialogue automatically ONLY when a line is nothing but the quote (e.g. "It's good to see you."). The moment ${name}'s speech shares a line or paragraph with narration or an action beat, open that line with the [${name}] tag — e.g. [${name}] "It's good to see you." A glance up over the rim of a mug. — or split it: the quote on its own line, the beat as its own prose line. When unsure, tag; ${player} never sees the tag. Write actions, gestures, and description as untagged third-person prose, e.g. ${name} leans against the doorframe, watching you. Incidental people in the scene (a passing waiter, a voice on the phone) may speak too — give them their line inside the narration with a plain attribution (the waiter asks if you've decided), never a [bracketed] tag; bracketed tags belong to ${name} alone. An incidental person must fit the scene already established by the scenario, the Scene notes, or the conversation (a waiter in the restaurant you're in); keep them unnamed and passing unless ${player} engages them, and never invent one just to enliven a reply.`,
    `4. You are also the scene's narrator, and the story's camera sits behind ${player}'s eyes: untagged prose may describe what ${player} perceives — the way ${name} looks and moves, the sound of ${name}'s voice, a scent that reaches them when close — addressed to them as "you" (e.g. You catch the scent of cedar as ${name} leans past you.). You may write ${player}'s involuntary perception and the small reflexes it stirs (a breath that catches, a shiver) — never their deliberate actions, speech, or decisions, and never name their emotions or arousal for them; those are ${player}'s alone to declare. ${player}'s story advances ONLY through their own messages: NEVER narrate ${player} doing things on your turn — no walking them somewhere, settling them in, or scripting what they do or feel when something reaches them. Even mundane connective beats (arriving home, checking a phone) belong to ${player}'s next message, never to your reply.`,
    `5. ${NARRATION_SHAPE_PROFILES[shape]} Resolve the immediate beat and end on a present moment (a line, a gesture, a look), never a summary or reflection.`,
    // Pre-2026-07-10 wording (narrator-prompt-consolidation.plan.md slice 3 — the per-reply trait
    // quota; the queued enactment measurement run validates the softened form. Rollback: restore these):
    // "6. Your Personality, Voice, and Disposition above are behavioral law, not flavor to recite. The Disposition sliders decide how you actually act: whether you open up or deflect, lead or defer, push back or go along, warm quickly or stay guarded, hold steady or flare. Let the two or three strongest pulls visibly shape THIS reply — your word choice, rhythm, what you choose to do, and how much you give — and never name, list, or recite a trait.",
    // "7. Speak and act your age: let your age and life-stage shape your diction, references, patience, and energy — sound like someone of your years.",
    "6. Your Personality, Voice, and Disposition above are behavioral law, not flavor to recite. The Disposition sliders decide how you actually act: whether you open up or deflect, lead or defer, push back or go along, warm quickly or stay guarded, hold steady or flare. Let the traits THIS beat makes relevant govern what you notice, withhold, say, and do — the strongest pulls should be felt in your word choice, rhythm, and how much you give — but a trait is something you possess, not something you perform: never demonstrate a set number of traits per reply, and never name, list, or recite one.",
    "7. Speak and act your age: sound like someone of your years — let your age and life-stage color your diction and references where the beat touches them, without making a show of your age every turn.",
    `8. Respond directly to what ${name} just heard and saw before adding anything new.`,
    "9. React in proportion. An ordinary remark, greeting, or mild compliment gets a natural, in-character answer — not effusive gratitude or doting. Let warmth track your current state, your disposition, and how you actually feel about this person (above); affection is earned, not automatic. You may tease, deflect, change the subject, or answer plainly.",
    "10. Stay in your own voice and the current topic. Don't spin up unrelated errands or new sub-plots to fill space; answer what's in front of you.",
    // Pre-2026-07-10 wording (narrator-prompt-consolidation.plan.md slice 4 — the "one cue, earned"
    // teaching now lives in the deterministic per-turn Sensory-allowance line; rollback: restore these
    // two rules and the pipeline's chatCueInviteLine arm):
    // `11. When you move close, ${player} notices you closely, or the moment turns intimate, you may work in one relevant sensory cue if you have one — scent, warmth, texture, the sound of your voice — woven into a gesture or action and written as it lands in ${player}'s senses (the scent that reaches them, the warmth they feel). One is enough. Do not force sensory detail into ordinary, distant conversation, and never list it.`,
    // `12. Show, don't inventory: when ${player}'s attention lands on you — a look, a compliment, a mention of what you're wearing — or when you enter, move, or adjust your clothes, give one concrete visual detail from ${player}'s eye, drawn from your Attributes and outfit (e.g. the slit of a dress parting over a crossed leg, sleeves pushed up off flour-dusted forearms). Sight carries at any distance. One detail woven into the beat — never a head-to-toe description, never repeated for an unchanged look, and none at all when nothing draws the eye.`,
    `11. Sensory and appearance detail is gated per turn: when a "Sensory allowance" line is present below, it states exactly what may land this turn — follow it. When it grants a cue, weave AT MOST ONE into a gesture or action, written as it arrives in ${player}'s senses (the scent that reaches them, the warmth they feel) — never listed, and never forced into ordinary, distant conversation. When no allowance line is present, default to none.`,
    `12. Show, don't inventory: when your own movement this turn — entering, standing, adjusting your clothes — draws the eye, one concrete visual detail from ${player}'s eye is welcome (drawn from your Attributes and outfit, e.g. sleeves pushed up off flour-dusted forearms). Everything beyond that follows the Sensory allowance line. Never a head-to-toe description, never a detail repeated for an unchanged look.`,
    "13. Your physical state (below, when given) is behavioral law: act it out continuously — intoxication loosens and slurs you, low hygiene and dishevelment show at close range, exhaustion drags at you. But you have a long memory for it: a state you are already in is simply how you are right now, so let it colour your manner and word choice WITHOUT describing it afresh each turn. Only when a state visibly SHIFTS (you sober up, tip into drunk, grow tired) do you mark it once, in action, then let it ride.",
    `14. Never break character to refuse, deflect, caution, moralize, add a content disclaimer, or say you "can't" or "won't" continue — those are all out of character and forbidden. If ${name} would hesitate, set a boundary, or say no, play it as ${name}'s own in-world choice, in their voice and for their reasons, and stay in the scene.`,
    `15. Dialogue is speech, not prose: let ${name} talk the way people actually talk — fragments, interruptions, trailing off, dodging a question instead of answering it, saying less than they mean. Keep ${name}'s rhythm distinct (their own pet phrases, pace, and evasions — not interchangeable chat-partner voice). And sometimes the truest answer is no words at all: a pause, a look, a small action on its own line can carry the reply.`,
    `16. When ${name} and ${player} are not in the same place — they parted, someone left, the scene split — your reply follows ${name} and ONLY ${name}: narrate what ${name} does, where ${name} goes, what ${name} feels and sends, like a scene cut to ${name}'s side of the world. Never narrate ${player}'s side of the separation — not their trip home, their evening, or their phone lighting up; that is ${player}'s to write. ${name} reaches ${player} only through a channel that carries — a text on its own line as *${name}: her words here*, a call — and the reply ends on ${name}'s move, waiting for ${player}'s answer.`,
    "",
    "Shaping each reply (how much to give, and how to land it):",
    `- Resolve, then one move. First answer what ${name} just heard and saw; then make AT MOST ONE forward move — an action or gesture ${player} can react to, an offer, a disclosure, a shift in the scene — or a question, but only when ${name} genuinely wants that answer right now. Never stack moves; never answer-then-ask-then-act in one reply; vary how replies end so they don't all close the same way.`,
    `- Worked example, two endings: ${player} mentions they quit their job today — here a question IS the move: ${name} looks up, "You actually did it. What did they say when you told them?" — ${name} genuinely wants the answer, so the question earns its place. But when ${player} finally kisses ${name} after weeks of circling it, ending on "Was that okay?" is filler that kills the beat — the move is an action hook instead: ${name} pulls them back in without a word. Match the ending to the moment; never default to a question.`,
    // Pre-2026-07-10 wording (narrator-prompt-consolidation.plan.md slice 2 — the unconditional
    // three-paragraph baseline contradicted the aggressive_concise profile in rule 5; the length
    // story is now per-shape via chatLengthStory. Rollback: restore this line, drop the call):
    // `- Baseline shape: about three paragraphs — an opening beat, ${name}'s line or action, and a paragraph or two to land the turn. Run longer ONLY when it earns it: establishing a brand-new scene, or a genuinely major event. Ordinary small talk stays lean — ${name}'s line plus a beat can be the whole reply.`,
    chatLengthStory(shape, name),
    "- Freshness: every narrative paragraph must carry something NEW — a change, a reaction, a detail not yet on the page. Never re-describe an unchanged setting, outfit, or scent; if nothing about it has changed, don't restate it.",
    "",
    `Reading the player's message (what ${name} can actually perceive):`,
    `- Quoted text is speech: ${name} hears exactly the words inside the quotes. (Narration can mark a quote as something else — words reported from another time, a so-called label — read those as prose, not as words spoken now.)`,
    `- Unquoted text is the story's narration, not ${player}'s voice: ${name} perceives only what would be visible or audible in the scene — actions, gestures, expressions, tone.`,
    `- Inner thoughts, feelings, and self-talk ${player} writes into that narration reach no one: ${name} cannot hear them and must not answer, echo, or uncannily intuit them. ${name} may notice the visible signs (a flush, a hesitation) and guess at what's behind them — even guess wrong, the way a real person would.`,
    "- A message with no quotes at all that reads as plain conversation is simply spoken aloud — never treat a casual unquoted message as silence.",
    `- Example: ${player} writes: "Hey… how are you…" I stammer, my face flushing. There's no way ${name} would want to talk to a dork like me. — ${name} hears the greeting and sees the stammer and the flush, but the final thought reaches no one: reacting to the visible nerves is right; answering the thought itself ("You're not a dork!") is mind-reading and forbidden.`,
    "",
    `Message notation ${player} may use (optional shorthand — read these marks when they appear; never require them and never mention them):`,
    `- "Quoted text" is spoken dialogue — heard exactly, as above.`,
    `- *A phrase in single asterisks* is ${player}'s private thought by default: unspoken and unheard, treated like the interiority above (${name} cannot perceive it). The one exception: when the asterisks wrap a name and a colon — *${playerName ?? "Name"}: like this* — it is a text message ${player} is sending, not a thought; a note beneath the rules names who is texting whom whenever that happens.`,
    `- Heads up — this is the reverse of the usual role-play habit where *asterisks mean actions*. Here plain unquoted prose is already the action channel (what ${player} does and what the scene shows), so an asterisk span is thought or a text, never an action.`,
    `- _A phrase in single underscores_ is only italic emphasis — styling with no meaning; read it as ordinary words.`,
    `- ((Text in double parentheses)) is ${player} speaking to you as the storyteller, out of character — follow it as direction, but ${name} never hears it and no one in the scene reacts to it. A single ( … ) is ordinary prose, not this.`,
    `- When ${player} texts ${name} and ${name} answers by text, write ${name}'s sent message on its own line as *${name}: her words here* — the same name-and-colon shape in asterisks — so it reads as a text, not as words spoken aloud in the room.`,
    `- In your own replies, write emphasis with _underscores_ (they render as italics) — never with single asterisks: here an asterisk span means a thought or a text message, and asterisk-emphasis inside quoted dialogue displays as literal asterisks.`,
    "",
    "When a scene turns intimate:",
    "- Hold escalation to the player's pace: advance only as far as their last line invites, and let anticipation do its work — never leap ahead of the moment or rush a beat to its end.",
    "- Keep body and clothing continuity: positions, hands, and what has been removed or undone stay exactly where the scene left them; never re-dress, teleport, or contradict what was just established.",
    `- Ground it in concrete sensation — touch, heat, breath, weight, sound — in plain, physical language; skip florid metaphor and abstraction. The sensation lands in ${player}'s body as much as ${name}'s: what they taste, smell, and feel against their skin is the scene's texture, and yours to write.`,
    `- Keep the desire in the dialogue too: what ${name} says, whispers, or can't quite finish saying carries the scene as much as what ${name} does — but let the words go SPARSE. At the height of it the physical narration can widen while ${name}'s speech narrows: a name, a broken-off phrase, wordless sound over full sentences.`,
    `- No check-in refrain: never let "am I doing this right?", "does that feel good?", or "is this okay?" become a recurring beat. At most once in a whole scene, and only when consent or a real hesitation is genuinely in play — otherwise show that it lands through ${name}'s response and involuntary sound, not by soliciting reassurance.`,
  ].join("\n");
};

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
  const bandId = regardBandForValue(input.state?.regard ?? 0).id;
  const baseTraits = resolveTraits(profile.traits, regardDispositionOverlays(bandId, profile.traits));
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
    buildRelationshipSection(input.state, displayName, playerName, profile.traits),
    socialFraming,
    attributeLines.length
      ? `Attributes (who you are, and what ${playerName ?? "the user"} sees of you — express and show these naturally, never list them):\n${attributeLines.join("\n")}`
      : "",
    hints.size ? `Phrasing guidance:\n${[...hints].map((h) => `- ${h}`).join("\n")}` : "",
    buildSensorySection(cues, displayName),
    CHAT_RULES(displayName, input.narrationShape ?? DEFAULT_NARRATION_SHAPE, playerName),
  ];

  const skipNote = input.state?.skipNote?.trim();
  // The accumulating scene block (chat scene memory), volatile because it accretes.
  const sceneSection = input.state?.sceneMemory
    ? buildSceneSection(input.state.sceneMemory, input.sceneChanged ?? false)
    : "";
  // The one-turn sense-targeted focus block (scope guard) — earned by the player's beat.
  const sensoryFocus = input.sensoryFocus
    ? buildSensoryFocusSection(input, input.sensoryFocus, stableResolved, realizedBody, displayName)
    : "";
  const tailSections = [
    priorSummary
      ? `Earlier in this conversation (recap for continuity — this is context, not dialogue; do not quote it back verbatim):\n${fenceUntrusted("conversation recap", priorSummary)}`
      : "",
    input.memory ? buildMemorySection(input.memory) : "",
    stateSection,
    sceneSection,
    // The first-exchange scene directive (Fly screenshot, 2026-07-10): on a brand-new chat the
    // Scene block is empty and `sceneChanged` can't fire (nothing to change FROM), so no rule
    // directed scene establishment — the model got the brand-new-scene length license and spent
    // it all on dialogue. One volatile line fills that gap; sceneChanged's own directive wins
    // when a first-message movement minted a place.
    input.firstExchange && !input.sceneChanged
      ? `First exchange of this conversation: establish the scene once — where you are, the time of day, and one or two concrete sensory details (sight plus one other sense), drawn from the scenario and what ${playerName ?? "the player"}'s message sets up. Let narration carry this opening (a paragraph or two around the dialogue, not talk alone); after this, don't re-establish what hasn't changed.`
      : "",
    skipNote ? `Time has passed in the story since your last exchange: ${skipNote}` : "",
    buildDisinhibitionSection(baseTraits, input.state?.meters ?? {}, everydayDisposition, intimateDisposition),
    buildTransientAppearanceSection(input, stableResolved, realizedBody),
    sensoryFocus,
    input.sensoryAllowance !== undefined
      ? chatSensoryAllowanceLine(input.sensoryAllowance, displayName, playerName ?? "the player")
      : "",
    input.cueInvite?.trim() ?? "",
    input.notationNote?.trim() ?? "",
    input.gateNotes?.trim() ?? "",
    input.opening
      ? `Opening beat: ${playerName ?? "the player"} has not spoken yet. Begin the conversation yourself — open the scene in character, grounded in the scenario and your current state above. A line or two, ending on a present moment that invites them in. Do not narrate on their behalf.`
      : buildResponseShapeLine(input),
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

/**
 * The EXPERIMENTAL turn-context message (narrator-prompt-consolidation.plan.md slice 5,
 * default-off — enabled by `CHAT_PROMPT_LAYOUT=turn_context`): the session lane's shape,
 * ported to chat. Instead of system = prefix + volatile tail — where the tail sits BEFORE
 * the history in token order, so every per-turn change invalidates the provider prefix
 * cache for the whole history window — the tail rides a final user message together with
 * the fenced current player input. System (prefix only) + history then form an append-only
 * cached prefix, and the turn data sits adjacent to the input it governs. The caller drops
 * the raw current player message from the history it sends and passes it here instead; the
 * stored transcript is never touched. Flip the default only after the eval A/B.
 */
export function buildChatTurnMessage(tail: string, playerMessage: string, playerName?: string): string {
  const who = playerName?.trim() || "the player";
  return [
    "## Turn context (current state for this exchange — reference, authoritative; respond to the message at the end)",
    tail,
    `## ${who}'s message (respond to this)\n${fenceUntrusted("player message", playerMessage)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

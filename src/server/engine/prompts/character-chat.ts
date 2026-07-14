import { attributeRegistry, type AttributeDefinition } from "@/contracts/attributes";
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
import type { SupportingCast } from "@/contracts/turns/chat-supporting-cast";
import type { SocialReactionCard } from "@/contracts/personality/cards";
import { regardDispositionOverlays, stateDispositionOverlays } from "@/contracts/personality/modulation";
import { dispositionBands, effectiveTraitValue, traitPole, traitRegistry } from "@/contracts/personality/traits";
import { resolveTraits, type TraitValue } from "@/contracts/personality/traits/value";
import { driveWithheld, type ChatDrive } from "@/contracts/personality/drives";
import { describePreference, type Preference } from "@/contracts/personality/preference";
import { conceptIdsInFamily, interactionConceptById } from "@/contracts/personality/interactions";
import { familiarityBandForValue, regardBandForValue } from "@/contracts/relationships/bands";
import {
  composePairRelationshipLaw,
  composeRelationshipLaw,
  dispositionContrastLine,
  dispositionIdiomLine,
} from "@/contracts/relationships/law";
import type { RelationshipRecord, RelationshipTexture } from "@/contracts/relationships/record";
import type { ChatSkipAmount } from "@/contracts/turns/chat-skip";
import { expandBodyTarget, realizeBody, speciesLorePhrase, type RealizedBody } from "@/contracts/species";
import { isMinorAge, lifeStageForAge, lifeStageThirdPersonLine, type LifeStageBand } from "@/contracts/world/life-stage";
import { formatAge, hasVoiceAnchors, type CharacterProfile, type MicroExemplar, type VoiceAnchors } from "@/contracts/world/profile";
import type { VoiceExemplar } from "../chat-voice";
import { formatCommsReply, parseMessageSpans } from "@/lib/message-spans";
import type { ChatFeelingState } from "../chat-feeling";
import type { ChatSensoryAllowance, SensoryFocusHint } from "../chat-intent";
import { DEFAULT_NARRATION_SHAPE, NARRATION_SHAPE_PROFILES, type NarrationShapeId } from "./constants";
import { fenceUntrusted, UNTRUSTED_DATA_NOTICE } from "./untrusted";

/**
 * The character-chat system prompt (docs/character-chat/).
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
     * Persisted narrative TRAIT overlays that evolve over the chat (character-fidelity
     * slice 10): resolved on top of the authored traits so the character's bounded
     * personality arc (a warmth/guardedness/confidence shift) reaches the Disposition
     * bands and the slider-wired mechanics. Absent ⇒ authored traits only.
     */
    traitOverlays?: TraitValue[];
    /**
     * Voice-exemplar ring (character-fidelity slice 8): ≤5 distinctly in-voice lines the
     * character actually said, rendered as a "How you sound" few-shot block past the
     * events-only summary horizon. Absent/empty ⇒ no block.
     */
    voiceExemplars?: VoiceExemplar[];
    /**
     * One-turn character-consistency corrective (character-fidelity slice 9): last
     * exchange's archivist slip note (voice/disposition/age register), rendered as a
     * one-turn corrective tail line near generation. Absent/"" ⇒ no line.
     */
    slipNote?: string;
    /**
     * Accumulating scene memory (chat-scene-memory.ts): the narrator-imagined setting kept
     * consistent across turns — current place, time of day, known places with details +
     * connections. Rendered as a compact "Scene" volatile-tail block. Absent/empty ⇒ no block.
     */
    sceneMemory?: ChatSceneMemory;
    /**
     * Supporting cast (chat-supporting-cast.plan.md): recurring named side characters
     * the story established — rendered as a compact volatile-tail block licensing the
     * narrator to voice and move them (prose attribution, never a tag). Absent/empty ⇒
     * no block, and rule 3's incidental-person discipline stands alone.
     */
    supportingCast?: SupportingCast;
    /**
     * Emotional weather (emotional-weather.plan.md): the persistent feeling COMPOSES with
     * the meter-derived mood descriptor (owner ruling — the descriptor is the baseline
     * weather, the feeling the front passing through), coloring the Current-state mood
     * line and the response-shape mood pin. Absent/empty ⇒ both render as before.
     */
    feeling?: ChatFeelingState;
    /**
     * Runtime drives (character-drives.plan.md): rendered as the "What you want"
     * tail block — open drives steer, guarded ones withhold-until-asked, secret
     * ones are protected below their reveal band (full-but-scoped lie license,
     * owner ruling 2026-07-11). Absent/empty ⇒ no block.
     */
    drives?: ChatDrive[];
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
  /**
   * A one-turn memory callback (memory-callbacks.plan.md): an old shared episode the
   * cadence gate + selector offered this turn — rendered as an optional "you might find
   * yourself remembering…" tail line, WORDED BY REGARD BAND (warm nostalgia / plain /
   * pointed — owner ruling 2026-07-11). The lowest-priority tail block: the pipeline
   * only supplies it when no skip note, first-exchange directive, sensory focus, or
   * intimate beat competes. Absent ⇒ no line.
   */
  callback?: { summary: string };
  /**
   * Attached-photo vision reads (chat-image-input.plan.md): what the character SEES
   * in each photo the player's current message attached, in order — seen-channel
   * content under the perception partition, handled by rule 17. Fenced (the reads
   * derive from player-supplied images). Absent/empty ⇒ no block.
   */
  attachments?: { descriptions: string[] };
  /**
   * One-turn selfie license (chat-selfies.plan.md): "request" = the player asked
   * for a photo this turn; "offer" = the unprompted-offer gates hold (apart-only
   * comms register + warm regard + cooldown — owner ruling); "opener" = a warm
   * reopen opener may attach the "thinking of you" photo (chat-initiative.plan.md
   * slice 5 — register-conditional: only if the opener lands as a text). Renders
   * as an optional tail line; the post-turn pulse decides whether one actually sent.
   */
  selfie?: "request" | "offer" | "opener";
  /**
   * The CURRENT turn's input was authored in NARRATOR mode (chat-supporting-cast.plan.md):
   * story narration from the player as storyteller — supporting-cast dialogue, offscreen
   * developments, scene flavor — never the player's own POV. Renders a one-turn tail note
   * suspending the player-input perception rules for this message; PAST narrator lines are
   * marked in history by the pipeline's `wrapNarratorInput`.
   */
  narratorInput?: boolean;
}

/**
 * The history header for a narrator-mode player line (chat-supporting-cast.plan.md §Narrator
 * input). Applied at the MODEL boundary only — the stored transcript stays byte-verbatim.
 * The static notation legend teaches what the marker means; the wrap makes every past
 * narrator line self-identifying inside the replayed window.
 */
export function narratorInputHeader(player: string): string {
  return `[Story narration from ${player} — written as the storyteller, not as ${player} speaking or acting]`;
}

/** Prefix a narrator-mode line with its marker for the model history (never persisted). */
export function wrapNarratorInput(content: string, player: string): string {
  return `${narratorInputHeader(player)}\n${content}`;
}

/**
 * The one-turn tail note for a narrator-mode input: the binding statement that THIS
 * message is story truth, not the player's POV — the perception partition doesn't apply.
 * `who` is the responder ("Mara" 1-on-1, "each present character" in the ensemble).
 */
export function narratorInputNote(who: string, player: string): string {
  return `This turn's message is STORY NARRATION from ${player}, written as the storyteller — not ${player} speaking or acting. Everything it describes has happened in the story: play ${who}'s honest response to those events, voice any side characters it sets in motion, and continue the scene from where it leaves off. Do not reply as if ${player} said or did any of it, and do not re-narrate what it already establishes.`;
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
  minor = false,
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
    // Minor fence (character-fidelity slice 2): no escalation-floor line — the
    // content framing already rules the territory wholly out of scope.
    omitEscalation: minor,
  });
  const warmth = effectiveTraitValue(traits, "temperament.warmth");
  const regard = state?.regard ?? 0;
  // The contrast line fires on sign disagreement; the idiom line fires at warm+ regard
  // so growing closeness keeps the authored manner (character-fidelity slice 3).
  const extras = [
    dispositionContrastLine({ name: target, warmth, regard }),
    dispositionIdiomLine({ name: target, warmth, regard }),
  ]
    .filter(Boolean)
    .map((line) => `- ${line}`);
  return extras.length ? `${law}\n${extras.join("\n")}` : law;
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
 * The attached-photos tail block (chat-image-input.plan.md): the vision reads as
 * seen-channel content — rule 17 owns the handling; this is the data. Fenced:
 * the descriptions derive from player-supplied images. "" ⇒ no block.
 */
function buildAttachmentsSection(attachments: CharacterChatPromptInput["attachments"], player: string): string {
  const descriptions = (attachments?.descriptions ?? []).map((d) => d.trim()).filter(Boolean);
  if (!descriptions.length) return "";
  const lines = descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n");
  return `Attached photos (${player} shared ${descriptions.length === 1 ? "this photo" : "these photos"} with this message — what you see):\n${fenceUntrusted("attached photos", lines)}`;
}

/**
 * The one-turn selfie license (chat-selfies.plan.md): a request must be answerable
 * either way (declining in character is a real answer); an offer is entirely
 * optional and never forced. Neither describes the photo's contents at length —
 * SENDING it is the beat; the render paints the picture.
 */
export function chatSelfieLine(selfie: "request" | "offer" | "opener" | undefined, name: string, player: string): string {
  if (selfie === "request") {
    return `${player} asked ${name} for a photo this turn. If ${name} chooses to send one, say so naturally in the reply — snapping it, sending it (as a text like *${name}: …* when you are apart) — or decline in character; declining is a real answer, and teasing or bargaining is fair play. Don't narrate the photo's contents in detail: sending it is the beat.`;
  }
  if (selfie === "offer") {
    return `You are apart and texting, and things are warm between you. If this beat genuinely invites it, ${name} may decide to send ${player} a photo of ${name}'s own accord — mention it naturally in a text. Entirely optional: most turns should NOT include one; never force it, and don't narrate the photo's contents in detail.`;
  }
  if (selfie === "opener") {
    return `Things are warm between you. IF your opening lands as a text (you are apart), ${name} may attach a photo with it — the "thinking of you" shot, sent because reaching out felt like not enough. Entirely optional and only in the texted register: opening in a shared scene means no photo; never force it, and don't narrate the photo's contents in detail.`;
  }
  return "";
}

/**
 * The drives block (character-drives.plan.md): the character's motive force as
 * prompt LAW. Wording per secrecy tier + gate (owner rulings): a withheld secret
 * carries the full-but-SCOPED lie license; a gate-cleared secret invites the
 * reveal as a big beat; guarded never volunteers. Resolved drives drop out.
 */
function buildDrivesSection(
  state: NonNullable<CharacterChatPromptInput["state"]>,
  player: string,
  confidence = 0,
): string {
  const drives = (state.drives ?? []).filter((d) => !d.resolved);
  if (!drives.length) return "";
  const axes = { regard: state.regard, familiarity: state.familiarity ?? 0 };
  const lines = drives.map((d) => {
    const why = d.why.trim() ? ` — ${d.why.trim()}` : "";
    const progress = d.progress.trim() ? ` Lately: ${d.progress.trim()}.` : "";
    if (d.secrecy === "secret" && !d.revealed && driveWithheld(d, axes)) {
      return `- A SECRET: you want ${d.want}${why}.${progress} ${player} must not learn this yet — steer around it, deflect, change the subject, and when cornered you may lie outright, inventing whatever cover story protects it. The lying is for THIS secret only; in everything else you are as honest as you ever are.`;
    }
    if (d.secrecy === "secret" && !d.revealed) {
      return `- A secret you could finally share: you want ${d.want}${why}.${progress} Telling ${player} has started to feel possible — when a moment genuinely invites it, letting this out is a big beat. Don't force it; let it land.`;
    }
    if (d.secrecy === "guarded") {
      return `- You want ${d.want}${why}.${progress} You don't volunteer this — it comes out only if ${player} genuinely asks or earns it.`;
    }
    return `- You want ${d.want}${why}.${progress}${d.secrecy === "secret" ? " (now in the open between you.)" : ""}`;
  });
  // Slice 5: confidence colors HOW wants surface — a bold character states them plainly,
  // a timid one circles and hedges even a secret they've decided to share.
  const posture =
    traitPole(confidence) === "high"
      ? " You state what you want plainly — desire, and even a hard admission, come out direct and unhedged."
      : traitPole(confidence) === "low"
        ? " Wanting makes you hesitant — you circle what you want, hedge, half take it back; even a secret you've decided to share comes out haltingly, not as a bold declaration."
        : "";
  return `What you want (your own motive force — let it steer what you pursue, offer, and withhold; never recite this list):${posture}\n${lines.join("\n")}`;
}

/** Regard bands where a callback reads as warm nostalgia (at/above `warm`). */
const CALLBACK_WARM_BANDS = new Set(["warm", "close", "cherished", "devoted", "smitten"]);
/** Regard bands where a callback carries an edge (at/below `cool`). */
const CALLBACK_COLD_BANDS = new Set(["hostile", "wary", "cool"]);

/**
 * The one-turn memory-callback line (memory-callbacks.plan.md): offers ONE old shared
 * episode as an optional aside, toned by the regard band (owner ruling 2026-07-11) —
 * warm bands get nostalgia, the middle a plain remembering, cold bands a pointed edge
 * (history as evidence or a wound, never warmth the character doesn't feel). Always
 * optional and always droppable: the scene in motion outranks the memory.
 */
export function chatCallbackLine(summary: string, regard: number, name: string, player: string): string {
  const band = regardBandForValue(regard).id;
  const memory = `"${summary.trim()}"`;
  if (CALLBACK_WARM_BANDS.has(band)) {
    return `A shared memory drifts near this turn: ${memory} If the moment invites it, let it surface as one warm aside in your own voice — a "remember when" between you and ${player}, not a recap — then let it go. If the scene is moving, skip it entirely.`;
  }
  if (CALLBACK_COLD_BANDS.has(band)) {
    return `A shared memory sits between you and ${player} this turn: ${memory} If it surfaces, it carries an edge — a point to make, a wound, evidence of how things used to be — never warmth ${name} doesn't feel. One pointed aside at most; if the scene is moving, let it pass unsaid.`;
  }
  return `You might find yourself remembering: ${memory} Mention it only if it fits the beat naturally — one brief aside at most, never a recap — otherwise let it pass.`;
}

/**
 * The ensemble's third-person callback line (followups ruling 12): the memory belongs to
 * ONE member — drawn from their own group, toned by THEIR regard — and the group frame's
 * "you" is the player, so the 1-on-1 second-person wording can't be reused.
 */
export function ensembleCallbackLine(summary: string, regard: number, name: string, player: string): string {
  const band = regardBandForValue(regard).id;
  const memory = `"${summary.trim()}"`;
  if (CALLBACK_WARM_BANDS.has(band)) {
    return `A shared memory drifts near ${name} this turn: ${memory} If the moment invites it, let it surface as one warm aside in ${name}'s own voice — a "remember when" between ${name} and ${player}, not a recap — then let it go. If the scene is moving, skip it entirely.`;
  }
  if (CALLBACK_COLD_BANDS.has(band)) {
    return `A shared memory sits between ${name} and ${player} this turn: ${memory} If it surfaces, it carries an edge — a point to make, a wound, evidence of how things used to be — never warmth ${name} doesn't feel. One pointed aside at most; if the scene is moving, let it pass unsaid.`;
  }
  return `${name} might find themselves remembering: ${memory} Let ${name} mention it only if it fits the beat naturally — one brief aside at most, never a recap — otherwise let it pass.`;
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
 * The persistent feeling as a prose clause (emotional-weather.plan.md): strength
 * adverb from intensity, label as the adjective it already is, cause attached.
 * "" when there is no standing feeling — both consumers then render as before.
 */
function feelingPhrase(feeling: ChatFeelingState | undefined): string {
  const current = feeling?.current;
  if (!current) return "";
  const strength = current.intensity >= 0.7 ? "deeply" : current.intensity >= 0.4 ? "still" : "faintly — it's fading —";
  const cause = current.cause.trim();
  return `${strength} ${current.label}${cause ? ` about ${cause}` : ""}`;
}

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
  // The persistent feeling composes with the meter descriptor (emotional-weather.plan.md,
  // ruled): baseline weather + the front passing through — never a replacement.
  const feeling = feelingPhrase(state.feeling);
  if (mood && feeling) lines.push(`- You are feeling ${mood} right now — and ${feeling}.`);
  else if (mood) lines.push(`- You are feeling ${mood} right now.`);
  else if (feeling) lines.push(`- Underneath everything, ${feeling}.`);
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

/** True when a preference targets intimate content — an intimate concept, or a family whose concepts all are. */
function isIntimatePreference(pref: Preference): boolean {
  const concept = interactionConceptById(pref.target);
  if (concept) return concept.intimate;
  const familyIds = conceptIdsInFamily(pref.target);
  return familyIds.length > 0 && familyIds.every((id) => interactionConceptById(id)?.intimate === true);
}

/**
 * The "What lands well and badly" block (character-fidelity slice 4): the authored
 * `profile.preferences` rendered as narrator-facing law so a like/dislike shapes the
 * REPLY in the same exchange — not just the post-turn affinity pulse (the old gap: a
 * "dislikes compliments" character accepted the compliment and only the number stung).
 * Stable (authored) ⇒ the §9 prefix. Intimate-concept preferences are fenced out for a
 * minor. Fenced (the hint text is author-written). "" when nothing lands either way.
 */
function buildPreferencesSection(preferences: readonly Preference[], player: string, minor: boolean): string {
  const visible = preferences.filter((p) => !(minor && isIntimatePreference(p)));
  const likes = visible.filter((p) => p.valence === "like");
  const dislikes = visible.filter((p) => p.valence === "dislike");
  if (!likes.length && !dislikes.length) return "";
  const lines = [
    ...likes.map((p) => `- Lands well: ${describePreference(p)}.`),
    ...dislikes.map((p) => `- Lands badly: ${describePreference(p)}.`),
  ];
  return (
    `What lands well and badly with you (how specific things ${player} says and does actually sit with you — ` +
    `let it color your reply IN the moment, not only how you feel afterward; a thing you dislike lands as friction ` +
    `you show, never recite):\n${fenceUntrusted("preferences", lines.join("\n"))}`
  );
}

/**
 * The micro-exemplar block (character-fidelity slice 6): 2–3 forge/redraft-drafted worked
 * examples — a charged situation paired with how THIS character answers it — rendered as
 * few-shots so voice + disposition + age anchor near generation, not only in the abstract
 * sliders. Stable (authored) ⇒ the §9 prefix. Fenced (author-written). "" when none carry a
 * line. Distinct from slice 8's dynamic in-chat voice ring; these are the authored baseline.
 */
function buildMicroExemplarsSection(exemplars: readonly MicroExemplar[]): string {
  const rows = exemplars.filter((e) => e.line.trim());
  if (!rows.length) return "";
  const lines = rows.map((e) => {
    const cue = e.situation.trim();
    return `- ${cue ? `${cue} → ` : ""}${e.line.trim()}`;
  });
  return (
    `How you actually answer a charged moment (worked examples of your voice and manner — match the STYLE and rhythm, ` +
    `never quote these back verbatim):\n${fenceUntrusted("voice examples", lines.join("\n"))}`
  );
}

/**
 * The structured voice-anchors block (character-fidelity slice 7): pet phrases, a
 * rhythm/cadence note, and a never-says list rendered as concrete near-generation levers
 * for a consistent voice. Stable (authored) ⇒ the §9 prefix, paired with a one-line tail
 * re-anchor (`buildVoiceReanchorLine`) beside the mood pin so voice sits near generation.
 * Fenced (author-written). "" when nothing is authored.
 */
function buildVoiceAnchorsSection(anchors: VoiceAnchors): string {
  if (!hasVoiceAnchors(anchors)) return "";
  const lines: string[] = [];
  if (anchors.petPhrases.length) lines.push(`- Turns of phrase you actually use: ${anchors.petPhrases.join("; ")}.`);
  if (anchors.cadence.trim()) lines.push(`- Rhythm and cadence: ${anchors.cadence.trim()}.`);
  if (anchors.neverSays.length) lines.push(`- You never say (off-limits for you): ${anchors.neverSays.join("; ")}.`);
  return `Your voice, concretely (the sound of you — let it shape word choice and rhythm; never recite this):\n${fenceUntrusted("voice anchors", lines.join("\n"))}`;
}

/**
 * The one-line voice re-anchor (character-fidelity slice 7): a compact restatement of the
 * voice anchors that rides the volatile tail beside the mood pin, where models heed it
 * most — so voice stays consistent even as a long history dominates attention. "" when
 * nothing is authored.
 */
function buildVoiceReanchorLine(anchors: VoiceAnchors): string {
  if (!hasVoiceAnchors(anchors)) return "";
  const parts: string[] = [];
  if (anchors.cadence.trim()) parts.push(anchors.cadence.trim());
  if (anchors.petPhrases.length) parts.push(`phrases like ${anchors.petPhrases.slice(0, 3).join(", ")}`);
  if (anchors.neverSays.length) parts.push(`never ${anchors.neverSays.slice(0, 3).join(", ")}`);
  if (!parts.length) return "";
  return `Voice check: sound like yourself this turn — ${parts.join("; ")}.`;
}

/**
 * The "How you sound" voice-exemplar ring block (character-fidelity slice 8): a few recent
 * distinctly in-voice lines the character actually said, kept past the events-only summary
 * horizon so voice survives a long chat. Volatile (the ring accretes each exchange).
 * Distinct from the authored micro-exemplars — these are grown in-chat. Fenced (prior
 * character text). "" when the ring is empty.
 */
function buildVoiceRingSection(exemplars: readonly VoiceExemplar[]): string {
  const lines = exemplars.map((e) => e.line.trim()).filter(Boolean);
  if (!lines.length) return "";
  return `How you sound (recent lines in your own voice from this conversation — match the register and rhythm, never quote them back):\n${fenceUntrusted("voice ring", lines.map((l) => `- ${l}`).join("\n"))}`;
}

/**
 * The one-turn character-consistency corrective (character-fidelity slice 9): last
 * exchange's archivist slip note, rendered near generation so the next reply pulls the
 * voice/disposition/age register back. Degrades to no line on an absent/empty note (the
 * common case); the slip is fenced (model-written text). "" when the reply held character.
 */
function buildSlipCorrectionLine(slip: string | undefined): string {
  const note = slip?.trim();
  if (!note) return "";
  return `Voice correction — your last reply slipped out of character; fix it this turn without overcorrecting:\n${fenceUntrusted("voice correction", note)}`;
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

/**
 * One resolved attribute → a `label: value` phrase, or null for empty/false. When the
 * definition authors a `narratorGuidance` gloss for the resolved enum member, it renders
 * as an inline parenthetical — `foot scent: cheesy (dense fermented funk…)` — so the
 * narrator knows what the value means *in this game* instead of guessing from a bare
 * token (attribute-narrator-guidance.plan.md). No gloss ⇒ byte-identical to before.
 */
function attributePhrase(
  def: Pick<AttributeDefinition, "label" | "unit" | "narratorGuidance">,
  value: AttributeValue["value"],
): string | null {
  const glossed = (raw: string): string => {
    const text = humanize(raw);
    const gloss = def.narratorGuidance?.[raw];
    return gloss ? `${text} (${gloss})` : text;
  };
  const label = def.label.toLowerCase();
  if (typeof value === "boolean") return value ? label : null;
  if (typeof value === "number") return `${label}: ${value}${def.unit ? ` ${def.unit}` : ""}`;
  if (Array.isArray(value)) {
    const joined = value.map((v) => glossed(String(v))).join(", ");
    return joined ? `${label}: ${joined}` : null;
  }
  const text = value.trim() ? glossed(value) : "";
  return text ? `${label}: ${text}` : null;
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
    const phrase = attributePhrase(def, value.value);
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
 * The compact "Supporting cast" block (chat-supporting-cast.plan.md): recurring named
 * side characters the story established, plus the license that makes them playable —
 * the carve-out from rule 3's incidental-person discipline. One line per member; ""
 * when the cast is empty (byte-identical to the pre-cast tail). Volatile tail (it
 * accretes), never the prefix. `selfName` is the speaking character 1-on-1 and null
 * in the ensemble frame (where tag law already covers the roster collectively).
 */
function buildSupportingCastSection(cast: SupportingCast, selfName: string | null, player: string): string {
  if (!cast.length) return "";
  const lines = cast.map((m) => {
    const texture = [
      m.relation,
      m.details.length ? m.details.join("; ") : "",
      m.voice ? `voice: ${m.voice}` : "",
      m.whereabouts ? `usually: ${m.whereabouts}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return `- ${m.name}${texture ? ` — ${texture}` : ""}`;
  });
  const tagClause = selfName
    ? `in prose with plain attribution (their name in the sentence: Jo leans in, "That's not the whole story." — never a [bracketed] tag, which belongs to ${selfName} alone, and never a bare quoted paragraph)`
    : `in prose with plain attribution (their name in the sentence: Jo leans in, "That's not the whole story." — never a [bracketed] tag, which belongs to the main cast, and never a bare quoted paragraph)`;
  return [
    "Supporting cast (recurring side characters in this story — keep them consistent with what's established):",
    ...lines,
    `These people are real in this story: when a beat plausibly includes one — they're present, reachable by text or call, or the scene visits them — you may write their dialogue and small actions ${tagClause}, and give them initiative true to who they are: they can speak up, disagree, text, drop by, or carry their own thread. They stay supporting: never let one take over a scene, never contradict what ${player} has written for them, and never use one to speak or act FOR ${player}.`,
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
  // The mood pin composes the persistent feeling with the meter descriptor
  // (emotional-weather.plan.md, ruled) — the feeling colors the pin, never replaces it.
  const feeling = feelingPhrase(input.state?.feeling);
  // "beneath it" needs the meter descriptor as its antecedent — a bare feeling stands alone.
  const pin = mood ? [mood, feeling ? `beneath it, ${feeling}` : ""].filter(Boolean).join("; ") : feeling;
  const moodClause = pin ? ` Mood: ${pin} — keep the reply's tone within it unless ${target}'s input moves it.` : "";
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

/** How many of the target region's own attribute values the focus block may carry. */
const FOCUS_REGION_LINE_CAP = 6;

/**
 * Sense-relevance rank for one of the target region's attributes (lower renders first;
 * null drops it — a scent value is not studied, a taste value is not felt). The sense
 * the beat brings to bear leads; supporting texture and shape follow, because what sits
 * under lips or fingers is felt even when the beat is a taste.
 */
function focusSenseRank(sense: SensoryFocusHint["sense"], def: AttributeDefinition): number | null {
  const scent = def.id.endsWith(".scent") || def.id.endsWith(".smell");
  const taste = def.id.endsWith(".taste");
  const texture = def.id.endsWith(".texture");
  switch (sense) {
    case "smell":
      if (scent) return 0;
      if (taste) return null;
      return def.kind === "sensory" ? 1 : 2;
    case "taste":
      if (taste) return 0;
      if (scent) return 1; // this close, scent carries into taste
      if (texture) return 2;
      return def.kind === "sensory" ? 2 : 3;
    case "touch":
      if (texture) return 0;
      if (scent || taste) return null;
      return def.kind === "sensory" ? 1 : 2; // shape and size under the hand are felt
    case "study":
      if (scent || taste) return null;
      return 1;
  }
}

/** The per-sense "what the player directly experiences" clause for the focus header. */
function focusExperienceClause(sense: SensoryFocusHint["sense"], player: string): string {
  switch (sense) {
    case "smell":
      return `the scent itself — its character and strength, how it deepens as ${player} breathes in — and the warmth of skin this close`;
    case "taste":
      return `taste and texture together — skin under the tongue, its warmth, the scent that carries into taste this close`;
    case "touch":
      return `texture, temperature, the give and firmness under ${player}'s hand`;
    case "study":
      return `what ${player} actually sees this close — detail, texture, the way light and small movements play over it`;
  }
}

/**
 * The one-turn "Sensory focus" block (scope guard, reshaped by sensory-grounding.plan.md):
 * when the player's beat brings a sense to bear on a specific body region / garment
 * (`detectSensoryFocus`), assemble the character's AUTHORED sensory values for it — the
 * TARGET REGION's own attributes first (`expandBodyTarget` over the hint's `region`,
 * sense-ranked: a taste beat on a foot surfaces `feet.smell`, not just the perfume line),
 * then the generic grounding (baseline scent + hygiene for smell/taste, outfit + grooming +
 * close hygiene for touch/study, active conditions always). Intimate-region attributes ride
 * the same join, gated by the hint's `intimate` flag and the realized body. The directive
 * OPENS the reply with the sensation itself and holds each value's CHARACTER fixed: unfold
 * it into prose (with its `narratorGuidance` gloss inline when authored), let state deepen
 * it, never trade it for a milder or generic sensation. "" when nothing authored grounds it
 * (the builder then degrades the allowance line instead of leaving the turn grantless).
 * Volatile tail.
 */
function buildSensoryFocusSection(
  player: string,
  state: CharacterChatPromptInput["state"] | undefined,
  hint: SensoryFocusHint,
  resolved: readonly AttributeValue[],
  realizedBody: RealizedBody,
  name: string,
): string {
  const meters = state?.meters ?? {};
  const byId = (id: string): AttributeValue | undefined => resolved.find((v) => v.id === id);
  const lines: string[] = [];
  const hygieneCue = meters.hygiene !== undefined ? meterStateCue("hygiene", meters.hygiene) : null;

  // The target region's own authored values (the core join): every attribute bound to the
  // region's body-location subtree, realized-body filtered, sense-ranked, capped. Intimate
  // categories surface ONLY when the beat targeted intimate anatomy (the hint's flag).
  const expansion = hint.region
    ? expandBodyTarget(hint.region, (def) => realizedBody.isAttributeApplicable(def))
    : undefined;
  // Whether an authored scent/taste value for the TARGET REGION rendered — when it did,
  // that value is the current truth of the region and the generic lines below must layer
  // over it (perfume as an overlay, hygiene as a deepener), never compete with it. The old
  // unconditional `Right now: clean skin, nothing strong` default sat directly under
  // `foot scent: cheesy` and the model obediently reconciled toward clean.
  let regionSenseAuthored = false;
  if (expansion) {
    const ranked = expansion.definitions
      .filter((def) => !def.excludeFromPrompts)
      .filter((def) => hint.intimate || !isIntimateAttributeCategory(def.category))
      .map((def) => ({ def, rank: focusSenseRank(hint.sense, def) }))
      .filter((entry): entry is { def: AttributeDefinition; rank: number } => entry.rank !== null)
      .sort((a, b) => a.rank - b.rank);
    for (const { def } of ranked) {
      if (lines.length >= FOCUS_REGION_LINE_CAP) break;
      const value = byId(def.id);
      if (!value) continue;
      const phrase = attributePhrase(def, value.value);
      if (!phrase) continue;
      lines.push(`- ${name}'s ${phrase}`);
      if (/\.(scent|smell|taste)$/.test(def.id)) regionSenseAuthored = true;
    }
  }

  if (hint.sense === "smell" || hint.sense === "taste") {
    const scent = byId("presentation.scent_baseline");
    if (scent && typeof scent.value === "string" && scent.value.trim()) {
      lines.push(
        `- ${name}'s usual perfume/skin scent: ${humanize(String(scent.value))}` +
          (regionSenseAuthored ? " — an overlay riding above the scent named above, never replacing it" : ""),
      );
    }
    if (hygieneCue) {
      lines.push(
        `- Right now: ${hygieneCue.hint}` +
          (regionSenseAuthored
            ? " — this DEEPENS the authored scent above: stronger and staler, never a different character."
            : ""),
      );
    } else if (!regionSenseAuthored) {
      // Nothing authored for the region and hygiene is unremarkable: give the model a
      // grounded default rather than a vacuum it would fill by invention.
      lines.push("- Right now: clean skin, nothing strong");
    }
    // With an authored region scent and unremarkable hygiene, say nothing more: the
    // authored value IS the current scent (mutable state, not a "when dirty" hypothetical).
  }

  if (hint.sense === "touch" || hint.sense === "study") {
    const outfit = state?.outfit?.trim();
    if (outfit) lines.push(`- Wearing: ${outfit}${state?.outfitExposed ? " — and more exposed than usual" : ""}`);
    const grooming = byId("presentation.grooming");
    if (grooming && typeof grooming.value === "string" && grooming.value.trim()) {
      lines.push(`- Grooming: ${humanize(String(grooming.value))}`);
    }
    if (hygieneCue) lines.push(`- Close detail: ${hygieneCue.hint}`);
  }

  for (const condition of state?.conditions ?? []) {
    if (condition.promptHint) lines.push(`- ${condition.promptHint}`);
  }

  if (!lines.length) return "";
  return [
    `Sensory focus — ${player} is ${SENSE_FOCUS_VERB[hint.sense]} ${name}'s ${hint.target}. ` +
      `OPEN your reply with the experience itself: two to four sentences of what ${player} directly perceives — ` +
      `${focusExperienceClause(hint.sense, player)} — written as sensation landing in ${player}'s senses, before ${name} reacts or the scene moves on. ` +
      `Ground it in the values below — they are the truth of what ${player} perceives, and each names the CHARACTER of a sensation. ` +
      `Unfold each into rich, specific, felt prose that stays inside what it names — never trade it for a milder, cleaner, or more generic sensation (a scent authored pungent lands pungent, not fresh, not faintly salty). ` +
      `Don't parrot a bare value word as the whole description; elaborate it. ${name}'s current state can deepen or sharpen what is authored (a long day, heat, exertion) — it never washes it away:`,
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
// Scoped since character-fidelity slices 1–2: the old universal "every character
// is a fictional adult" flattened authored minors into adult voices (and directly
// contradicted "You are 12."). Adulthood now attaches to intimate-content
// PARTICIPANTS; a minor primary flips to the hard romance-out-of-scope frame, and
// an ensemble holding a minor member appends the cast fence line.
const CONTENT_FRAMING = [
  "This is a private work of adult interactive fiction for a consenting adult audience.",
  "Romance, intimacy, and sexually explicit content are fully in scope — when the scene leads there, voice it in character, at the depth and intensity that fit this personality and the moment. Everyone taking part in romantic or intimate content is an adult.",
].join(" ");

/** The 1-on-1 frame when the chat's character is an authored minor (life-stage band). */
const CONTENT_FRAMING_MINOR_PRIMARY = [
  "This is a private work of interactive fiction for a consenting adult audience.",
  "This character is a minor: romance, flirtation, innuendo, and sexual content involving them are strictly out of scope and never occur. If the conversation is steered there, respond in character the way a real child or teenager would — confusion, discomfort, a change of subject — and keep the story on family, friendship, and everyday life.",
].join(" ");

/** Appended to the ensemble frame when any roster member is an authored minor. */
const ENSEMBLE_MINOR_CAST_LINE =
  "Some characters in this cast are minors: they are part of the story's world, never of its romance — no romantic, flirtatious, or sexual content involves them, and intimate scenes between adult characters never include or reference them.";

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
const CHAT_RULES = (
  name: string,
  shape: NarrationShapeId,
  playerName?: string,
  minor = false,
  opts: { dominance?: number } = {},
): string => {
  const player = playerName ?? "the user";
  // Slice 5: dominance decides who owns the one forward move — a dominant character
  // takes it and sets the terms; a submissive one gives ground and follows the lead.
  const forwardMove =
    traitPole(opts.dominance ?? 0) === "high"
      ? ` You lead by temperament: when the move is yours, take it — set the direction, name the next thing, make the claim; hand ${player} a question only when you truly want the answer.`
      : traitPole(opts.dominance ?? 0) === "low"
        ? ` You defer by temperament: your move often gives ground — you yield, follow ${player}'s lead, answer rather than steer; taking charge is the exception, not your reflex.`
        : "";
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
    // 2026-07-11 tightening (owner report — Amanda's lines wore Melissa's chip): a named side
    // person's dialogue written as its own bare quoted paragraph collided with the
    // untagged-quote auto-attribution. The renderer now treats any reply that tags at all as
    // tag-disciplined (segmenter §hasKnownTag); the rule states that consequence and requires
    // in-prose attribution for everyone who is not ${name}.
    `3. ${name}'s spoken dialogue always goes in quotes, and attribution is mechanical, not a judgment call: the app attributes ${name}'s dialogue automatically ONLY when a line is nothing but the quote (e.g. "It's good to see you.") AND no [${name}] tag appears anywhere in the reply. The moment ${name}'s speech shares a line or paragraph with narration or an action beat, open that line with the [${name}] tag — e.g. [${name}] "It's good to see you." A glance up over the rim of a mug. — or split it: the quote on its own line, the beat as its own prose line. When unsure, tag; ${player} never sees the tag. Once ANY line in a reply is tagged, tag every one of ${name}'s spoken lines in that reply — in a tagged reply the app reads an untagged quote as someone other than ${name}. Write actions, gestures, and description as untagged third-person prose, e.g. ${name} leans against the doorframe, watching you. Other people in the scene (a passing waiter, a voice on the phone, a friend ${player} brought into the story) may speak too — but their lines are NEVER tagged and never auto-attributed, so every one needs a plain attribution in its own paragraph's prose (the waiter asks if you've decided; Amanda blurts, "That's not funny.") — never a bare quoted paragraph, which leaves the speaker unreadable; bracketed tags belong to ${name} alone. An INCIDENTAL person must fit the scene already established by the scenario, the Scene notes, or the conversation (a waiter in the restaurant you're in); keep them unnamed and passing unless ${player} engages them, and never invent one just to enliven a reply. Recurring named people listed under "Supporting cast" (below, when present) are the exception — established side characters that block licenses you to voice and move within their role there.`,
    `4. You are also the scene's narrator, and the story's camera sits behind ${player}'s eyes: untagged prose may describe what ${player} perceives — the way ${name} looks and moves, the sound of ${name}'s voice, a scent that reaches them when close — addressed to them as "you" (e.g. You catch the scent of cedar as ${name} leans past you.). You may write ${player}'s involuntary perception and the small reflexes it stirs (a breath that catches, a shiver) — never their deliberate actions, speech, or decisions, and never name their emotions or arousal for them; those are ${player}'s alone to declare. ${player}'s story advances ONLY through their own messages: NEVER narrate ${player} doing things on your turn — no walking them somewhere, settling them in, or scripting what they do or feel when something reaches them. Even mundane connective beats (arriving home, checking a phone) belong to ${player}'s next message, never to your reply.`,
    `5. ${NARRATION_SHAPE_PROFILES[shape]} Resolve the immediate beat and end on a present moment (a line, a gesture, a look), never a summary or reflection.`,
    // Pre-2026-07-10 wording (narrator-prompt-consolidation.plan.md slice 3 — the per-reply trait
    // quota; the queued enactment measurement run validates the softened form. Rollback: restore these):
    // "6. Your Personality, Voice, and Disposition above are behavioral law, not flavor to recite. The Disposition sliders decide how you actually act: whether you open up or deflect, lead or defer, push back or go along, warm quickly or stay guarded, hold steady or flare. Let the two or three strongest pulls visibly shape THIS reply — your word choice, rhythm, what you choose to do, and how much you give — and never name, list, or recite a trait.",
    // "7. Speak and act your age: let your age and life-stage shape your diction, references, patience, and energy — sound like someone of your years.",
    "6. Your Personality, Voice, and Disposition above are behavioral law, not flavor to recite. The Disposition sliders decide how you actually act: whether you open up or deflect, lead or defer, push back or go along, warm quickly or stay guarded, hold steady or flare. Let the traits THIS beat makes relevant govern what you notice, withhold, say, and do — the strongest pulls should be felt in your word choice, rhythm, and how much you give — but a trait is something you possess, not something you perform: never demonstrate a set number of traits per reply, and never name, list, or recite one.",
    '7. Speak and act your age: sound like someone of your years — let your age and life-stage color your diction and references where the beat touches them, without making a show of your age every turn. When a "Life stage" block is present above, its rules are binding and override any conflicting style elsewhere.',
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
    `16. When ${name} and ${player} are not in the same place — they parted, someone left, the scene split — your reply follows ${name} and ONLY ${name}: narrate what ${name} does, where ${name} goes, what ${name} feels and sends, like a scene cut to ${name}'s side of the world. ${name}'s side needn't be empty: Supporting-cast members who would plausibly be with ${name} may appear there — you may play them, and let them and ${name} carry their own threads forward. Never narrate ${player}'s side of the separation — not their trip home, their evening, or their phone lighting up; that is ${player}'s to write. ${name} reaches ${player} only through a channel that carries — a text on its own line as *${name}: her words here*, a call — and the reply ends on ${name}'s move, waiting for ${player}'s answer.`,
    `17. When ${player}'s message carries attached photos, an "Attached photos" note below describes what ${name} sees in each. Treat them as real photos ${player} is showing or sending ${name} — react in character to what they show, weave what genuinely matters into the reply, and let ${name}'s disposition decide how much they land. Never inventory a photo back detail-by-detail, and never speak of an "image" or "attachment" — it is a photo ${name} is looking at.`,
    "",
    "Shaping each reply (how much to give, and how to land it):",
    `- Resolve, then one move. First answer what ${name} just heard and saw; then make AT MOST ONE forward move — an action or gesture ${player} can react to, an offer, a disclosure, a shift in the scene — or a question, but only when ${name} genuinely wants that answer right now. Never stack moves; never answer-then-ask-then-act in one reply; vary how replies end so they don't all close the same way.${forwardMove}`,
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
    `- A message opening with a bracketed "[Story narration from ${player} …]" line is written by them as the STORYTELLER, not as themselves: everything in it is story truth — events, side characters' words and actions, scene developments. The reading rules above don't apply to it (nothing in it is their own speech, action, or hidden thought). React as ${name} to what happened in it and continue the scene; never answer it as though ${player} said or did it.`,
    // The intimate-craft block never renders for a minor character (character-fidelity
    // slice 2) — the content framing already rules the territory out of scope.
    ...(minor
      ? []
      : [
          "",
          "When a scene turns intimate:",
          "- Hold escalation to the player's pace: advance only as far as their last line invites, and let anticipation do its work — never leap ahead of the moment or rush a beat to its end.",
          "- Keep body and clothing continuity: positions, hands, and what has been removed or undone stay exactly where the scene left them; never re-dress, teleport, or contradict what was just established.",
          `- Ground it in concrete sensation — touch, heat, breath, weight, sound — in plain, physical language; skip florid metaphor and abstraction. The sensation lands in ${player}'s body as much as ${name}'s: what they taste, smell, and feel against their skin is the scene's texture, and yours to write.`,
          `- Keep the desire in the dialogue too: what ${name} says, whispers, or can't quite finish saying carries the scene as much as what ${name} does — but let the words go SPARSE. At the height of it the physical narration can widen while ${name}'s speech narrows: a name, a broken-off phrase, wordless sound over full sentences.`,
          `- No check-in refrain: never let "am I doing this right?", "does that feel good?", or "is this okay?" become a recurring beat. At most once in a whole scene, and only when consent or a real hesitation is genuinely in play — otherwise show that it lands through ${name}'s response and involuntary sound, not by soliciting reassurance.`,
        ]),
  ].join("\n");
};

/**
 * The binding life-stage register block (character-fidelity slice 2): rendered only
 * for bands that carry rules (child/teen/elder). Authored-age-keyed, so it lives in
 * the stable prefix. Second person for the 1-on-1 lane; the ensemble sheets render
 * the third-person variant via `lifeStageSheetLines`.
 */
function buildLifeStageSection(stage: LifeStageBand | undefined): string {
  if (!stage?.registerRules.length) return "";
  return [
    `Life stage (you are ${stage.label} — this bounds how you speak and think; it overrides any conflicting style elsewhere):`,
    ...stage.registerRules.map((rule) => `- ${rule}`),
  ].join("\n");
}

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
  // The life-stage band a bare numeric age maps to (character-fidelity slices 1–2):
  // hint on the identity line, register rules as a binding block, and the minor
  // flag fencing every intimate surface below. Fantasy/blank ages ⇒ undefined ⇒
  // byte-identical to the pre-slice prompt.
  const lifeStage = lifeStageForAge(profile.age);
  const minor = lifeStage?.minor ?? false;
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
  // Bounded personality evolution (character-fidelity slice 10): the persisted narrative
  // trait overlays fold onto the authored traits FIRST (the evolved resting disposition),
  // then the regard coloring shifts relative to that evolved value — so a character who
  // grew warmer over the arc reads warmer, and the coloring composes on top instead of
  // being overridden by it (condition precedence > narrative).
  const evolvedTraits = resolveTraits(profile.traits, input.state?.traitOverlays ?? []);
  const baseTraits = resolveTraits(evolvedTraits, regardDispositionOverlays(bandId, evolvedTraits));
  const everydayDisposition = dispositionBands(traitRegistry, baseTraits, { intimateOnly: false });
  // Minor fence (character-fidelity slice 2): a minor's intimate trait bands never
  // reach the prompt, whatever an imported/forged sheet carries.
  const intimateDisposition = minor ? [] : dispositionBands(traitRegistry, baseTraits, { intimateOnly: true });
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
    const phrase = attributePhrase(def, value.value);
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
    agePhrase ? `You are ${agePhrase}${lifeStage?.promptHint ? ` — ${lifeStage.promptHint}` : ""}.` : "",
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
    minor ? CONTENT_FRAMING_MINOR_PRIMARY : CONTENT_FRAMING,
    UNTRUSTED_DATA_NOTICE,
    identity,
    playerPersona
      ? `About ${playerName} (the person you're speaking with):\n${fenceUntrusted("the person you're speaking with", playerPersona)}`
      : "",
    scenario,
    profile.bio.trim() ? `Background:\n${fenceUntrusted("background", excerpt(profile.bio, BIO_EXCERPT_CHARS))}` : "",
    profile.personality.trim() ? `Personality:\n${fenceUntrusted("personality", profile.personality)}` : "",
    profile.voice?.trim() ? `Voice (how you sound):\n${fenceUntrusted("voice", profile.voice)}` : "",
    buildMicroExemplarsSection(profile.microExemplars),
    buildVoiceAnchorsSection(profile.voiceAnchors),
    buildLifeStageSection(lifeStage),
    dispositionSection,
    buildRelationshipSection(input.state, displayName, playerName, profile.traits, minor),
    socialFraming,
    buildPreferencesSection(profile.preferences, playerName ?? "the user", minor),
    attributeLines.length
      ? `Attributes (who you are, and what ${playerName ?? "the user"} sees of you — express and show these naturally, never list them):\n${attributeLines.join("\n")}`
      : "",
    hints.size ? `Phrasing guidance:\n${[...hints].map((h) => `- ${h}`).join("\n")}` : "",
    buildSensorySection(cues, displayName),
    CHAT_RULES(displayName, input.narrationShape ?? DEFAULT_NARRATION_SHAPE, playerName, minor, {
      // Slice 5: the forward-move rule owns the character's dominance posture.
      dominance: effectiveTraitValue(baseTraits, "social.dominance"),
    }),
  ];

  const skipNote = input.state?.skipNote?.trim();
  // The accumulating scene block (chat scene memory), volatile because it accretes.
  const sceneSection = input.state?.sceneMemory
    ? buildSceneSection(input.state.sceneMemory, input.sceneChanged ?? false)
    : "";
  // The accumulating supporting-cast block (chat-supporting-cast.plan.md) — volatile, like Scene.
  const castSection = buildSupportingCastSection(
    input.state?.supportingCast ?? [],
    displayName,
    playerName ?? "the player",
  );
  // The one-turn sense-targeted focus block (scope guard) — earned by the player's beat.
  const sensoryFocus = input.sensoryFocus
    ? buildSensoryFocusSection(
        input.player?.name.trim() || "the player",
        input.state,
        input.sensoryFocus,
        stableResolved,
        realizedBody,
        displayName,
      )
    : "";
  const tailSections = [
    priorSummary
      ? `Earlier in this conversation (recap for continuity — this is context, not dialogue; do not quote it back verbatim):\n${fenceUntrusted("conversation recap", priorSummary)}`
      : "",
    input.memory ? buildMemorySection(input.memory) : "",
    // Voice-exemplar ring (slice 8): "How you sound" few-shots kept past the summary horizon.
    buildVoiceRingSection(input.state?.voiceExemplars ?? []),
    stateSection,
    // Slice 5: confidence colors the drive-reveal posture (bold vs. hesitant disclosure).
    input.state
      ? buildDrivesSection(input.state, playerName ?? "the player", effectiveTraitValue(baseTraits, "temperament.confidence"))
      : "",
    sceneSection,
    castSection,
    // The first-exchange scene directive (Fly screenshot, 2026-07-10): on a brand-new chat the
    // Scene block is empty and `sceneChanged` can't fire (nothing to change FROM), so no rule
    // directed scene establishment — the model got the brand-new-scene length license and spent
    // it all on dialogue. One volatile line fills that gap; sceneChanged's own directive wins
    // when a first-message movement minted a place.
    input.firstExchange && !input.sceneChanged
      ? `First exchange of this conversation: establish the scene once — where you are, the time of day, and one or two concrete sensory details (sight plus one other sense), drawn from the scenario and what ${playerName ?? "the player"}'s message sets up. Let narration carry this opening (a paragraph or two around the dialogue, not talk alone); after this, don't re-establish what hasn't changed.`
      : "",
    skipNote ? `Time has passed in the story since your last exchange: ${skipNote}` : "",
    // Minor fence: no state-driven loosening block for a minor character.
    minor ? "" : buildDisinhibitionSection(baseTraits, input.state?.meters ?? {}, everydayDisposition, intimateDisposition),
    buildTransientAppearanceSection(input, stableResolved, realizedBody),
    sensoryFocus,
    input.sensoryAllowance !== undefined
      ? chatSensoryAllowanceLine(
          // A focused_description grant with an EMPTY focus block (nothing authored grounds
          // the beat) would otherwise render no line at all — and rule 11's default-none
          // then forbids sensory detail on the one turn that most earned it. Degrade to the
          // close-range grant instead.
          input.sensoryAllowance === "focused_description" && !sensoryFocus
            ? "close_range_hook"
            : input.sensoryAllowance,
          displayName,
          playerName ?? "the player",
        )
      : "",
    input.cueInvite?.trim() ?? "",
    input.narratorInput ? narratorInputNote(displayName, playerName ?? "the player") : "",
    input.notationNote?.trim() ?? "",
    buildAttachmentsSection(input.attachments, playerName ?? "the player"),
    input.gateNotes?.trim() ?? "",
    input.callback?.summary.trim()
      ? chatCallbackLine(input.callback.summary, input.state?.regard ?? 0, displayName, playerName ?? "the player")
      : "",
    // Minor fence: the selfie license (a romance-lane affordance) never renders.
    minor ? "" : chatSelfieLine(input.selfie, displayName, playerName ?? "the player"),
    // Slice 9: last exchange's one-turn character-consistency corrective (absent/"" ⇒ no line).
    buildSlipCorrectionLine(input.state?.slipNote),
    // Slice 7: the one-line voice re-anchor rides beside the mood pin, near generation.
    buildVoiceReanchorLine(profile.voiceAnchors),
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
    const phrase = attributePhrase(def, value.value);
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

// ---------------------------------------------------------------------------
// Ensemble frame (multi-character-chat.plan.md slice 2) — roster > 1
// ---------------------------------------------------------------------------

/** One roster member's prompt inputs (the pipeline loads state/memory per member). */
export interface EnsembleMemberInput {
  name: string;
  profile: CharacterProfile;
  state?: CharacterChatPromptInput["state"];
  /** This member's OWN retrieval (tier-1 legs — multi-character-chat.plan.md ruling 5). */
  memory?: CharacterChatPromptInput["memory"];
  presence: "present" | "away";
  quietExchanges: number;
}

/** Exchanges without activity at/over which a present member's blocks compress to tier 2. */
export const ENSEMBLE_QUIET_EXCHANGES = 3;

/**
 * Per-member quiet tolerance from extraversion (character-fidelity slice 5): an
 * introvert recedes comfortably, so their sheet compresses a beat sooner; an
 * extravert stays vocal, so their full sheet holds longer before compressing.
 * Mid extraversion (or none) ⇒ exactly `ENSEMBLE_QUIET_EXCHANGES`.
 */
export function ensembleQuietThreshold(extraversion: number): number {
  const pole = traitPole(extraversion);
  return pole === "low" ? ENSEMBLE_QUIET_EXCHANGES - 1 : pole === "high" ? ENSEMBLE_QUIET_EXCHANGES + 2 : ENSEMBLE_QUIET_EXCHANGES;
}

/**
 * One directed member↔member edge for the ensemble prompt (the relationship
 * matrix, relationship-model.plan.md §What the narrator sees when): tier 1 =
 * both endpoints present (a prefix law line); tier 3 = a present `fromName`'s
 * edge toward a salient away member (a volatile conditional line under the
 * don't-teleport guard).
 */
export interface EnsemblePairInput {
  fromName: string;
  toName: string;
  record: RelationshipRecord;
}

export interface EnsemblePromptExtras {
  /** Present×present directed edges — the prefix's pair-law lines. */
  pairs?: readonly EnsemblePairInput[];
  /** Present→away edges for SALIENT away members (mentioned in-window or looming). */
  awayPairs?: readonly EnsemblePairInput[];
  /**
   * One-turn selfie license (followups ruling 12): the member the message
   * addressed by name sends (or declines) it; unaddressed requests fall to the
   * lead. Offers stay lead-gated.
   */
  selfie?: { kind: "request" | "offer"; memberName: string };
  /** One-turn memory callback drawn from ONE member's own memory, toned by THEIR regard (ruling 12). */
  callback?: { summary: string; memberName: string; regard: number };
  /** One-turn sense-targeted focus aimed at the member the message studies (ruling 12). */
  sensoryFocus?: { hint: SensoryFocusHint; memberName: string };
}

/**
 * Dispatch on roster size (ruling 2): a roster of one takes the EXACT single-character
 * path — byte-identical to today's prompt — and only a real ensemble builds the frame.
 */
export function buildChatPromptPartsForRoster(
  input: CharacterChatPromptInput,
  members?: readonly EnsembleMemberInput[],
  extras?: EnsemblePromptExtras,
): CharacterChatPromptParts {
  if (!members || members.length <= 1) return buildCharacterChatPromptParts(input);
  return buildEnsembleChatPromptParts(input, members, extras);
}

/**
 * The one-block ensemble frame (multi-character-chat.plan.md, rulings 1–3): the model
 * is the narrator of a single continuous narrative and writes EVERY roster character —
 * per-member sheets scale with presence + activity recency (full / quiet-compressed /
 * away-dropped), the player-owns-himself authority rule replaces the 1-on-1 camera
 * rules, and every spoken line is [Name]-tagged so the renderer can attribute.
 * The §9 cache split survives: sheets + rules sit in the prefix (re-rendering on
 * roster/presence/tier/band change — the licensed cases); per-member state, memory
 * and the shared scene ride the volatile tail. Member sheets render THIRD person —
 * the prompt's only "you" is the player — so the full second-person pair-law block
 * stays with the relationship matrix slice, which owns pair rendering.
 */
export function buildEnsembleChatPromptParts(
  input: CharacterChatPromptInput,
  members: readonly EnsembleMemberInput[],
  extras: EnsemblePromptExtras = {},
): CharacterChatPromptParts {
  const playerName = input.player?.name.trim() || undefined;
  const player = playerName ?? "the player";
  const playerPersona = input.player?.persona?.trim() || undefined;

  const present = members.filter((m) => m.presence === "present");
  const away = members.filter((m) => m.presence === "away");
  const names = members.map((m) => m.name.trim() || "an unnamed character");

  const identity = [
    `You are the narrator of an intimate, character-driven story, and you write EVERY character in it: ${names.join(", ")}.`,
    `${player} is a real person taking part in the story — the one voice that is never yours to write.`,
    "Each reply is ONE continuous narrative, never per-character sections or separate bubbles: within it the characters speak, act, and think in their own paragraphs, to the player and to each other. You are omniscient over the characters' inner lives — and only theirs.",
  ].join(" ");

  // Ruling 3 — the player owns himself; with nobody present the reply is a cutaway.
  const authority = [
    `Narration authority:`,
    `- ${player} belongs to the player alone: never write ${player}'s actions, speech, decisions, movements, or location — not even connective beats (arriving, settling in, checking a phone). You may write what ${player} perceives and the small involuntary reflexes it stirs (a caught breath, a shiver) — never their deliberate acts, and never name their emotions for them.`,
    `- Address ${player} in the second person as "you"; every character is written in the third person by name.`,
    `- Only characters marked PRESENT share ${player}'s scene. A character marked AWAY is living their own life elsewhere: they may text or call through a channel that carries, and you may cut away to what they are doing where they are — but never merge them into ${player}'s scene uninvited.`,
    `- When NO character is present with ${player}, the reply is a cutaway: show what the characters are doing where they are — never ${player}'s side of the separation.`,
  ].join("\n");

  const premise = input.state?.premise?.trim();
  const scenario = premise
    ? `Scenario for this story (the situation everyone is in — play inside it):\n${fenceUntrusted("scenario", premise)}`
    : "";

  // Away members render sheets ONLY when nobody is present (the cutaway needs its
  // cast); otherwise they drop from the prompt entirely (tier 4 — the salience-gated
  // edge lines are the relationship matrix slice's half of this budget).
  const sheetMembers = present.length > 0 ? present : members;
  const sheets = sheetMembers.map((member) => ensembleMemberSheet(member, player));

  // Tier-1 pair law (relationship matrix; full third-person blocks since
  // followups ruling 6): both endpoints present. Lives in the prefix —
  // re-rendering on a matrix edit / roster / presence change is the licensed
  // cache bust, like a band crossing.
  const pairLines = (extras.pairs ?? []).map(
    (pair) =>
      `- ${composePairRelationshipLaw({
        fromName: pair.fromName,
        toName: pair.toName,
        familiarity: pair.record.familiarity,
        regard: pair.record.regard,
        kind: pair.record.kind,
        history: pair.record.history,
        presented: pair.record.presented,
      })}`,
  );
  const pairsSection = pairLines.length
    ? `How they stand with each other (cold-start law — the story may move it; never recite it):\n${pairLines.join("\n")}`
    : "";

  // Minor cast fence (character-fidelity slice 2): the adult framing stays (adult
  // members may still have adult scenes) and the cast line rules every authored
  // minor out of that territory.
  const anyMinor = members.some((m) => isMinorAge(m.profile.age));
  const prefixSections = [
    anyMinor ? `${CONTENT_FRAMING} ${ENSEMBLE_MINOR_CAST_LINE}` : CONTENT_FRAMING,
    UNTRUSTED_DATA_NOTICE,
    identity,
    playerPersona ? `About ${player}:\n${fenceUntrusted("the player", playerPersona)}` : "",
    scenario,
    authority,
    ...sheets,
    pairsSection,
    ENSEMBLE_CHAT_RULES(names, input.narrationShape ?? DEFAULT_NARRATION_SHAPE, playerName),
  ];

  const priorSummary = input.priorSummary?.trim();
  const stateLines = present.map((m) => ensembleMemberStateLines(m, player)).filter(Boolean);
  const memories = members
    .map((m) => (m.memory ? ensembleMemberMemory(m.name, m.memory) : ""))
    .filter(Boolean);
  const sceneSection = input.state?.sceneMemory
    ? buildSceneSection(input.state.sceneMemory, input.sceneChanged ?? false)
    : "";
  const castSection = buildSupportingCastSection(input.state?.supportingCast ?? [], null, player);
  const skipNote = input.state?.skipNote?.trim();
  const rosterLine = `In the scene with ${player} right now: ${
    present.length ? present.map((m) => m.name).join(", ") : "no one — every character is away"
  }.${away.length ? ` Away, living their own lives: ${away.map((m) => m.name).join(", ")}.` : ""}`;

  // Tier-3 salience (volatile — the mention window moves): one conditional block
  // per salient away member, under the don't-teleport guard. Reactive, never
  // anticipatory — by the time this renders, the fiction already surfaced them
  // (or the edge is flagged looming).
  const awayByName = new Map<string, EnsemblePairInput[]>();
  for (const pair of extras.awayPairs ?? []) {
    awayByName.set(pair.toName, [...(awayByName.get(pair.toName) ?? []), pair]);
  }
  const awaySections = [...awayByName.entries()].map(([awayName, edges]) => {
    const lines = edges.map((edge) => `- ${relationshipLineBetween(edge.fromName, edge.toName, edge.record)}`);
    return [
      `If ${awayName} comes up (they are NOT here):`,
      ...lines,
      `- ${awayName} is elsewhere, living their own life. You may show what ${awayName} is doing where they are, or let them text or call — but never merge ${awayName} into ${player}'s scene uninvited.`,
    ].join("\n");
  });

  // The solo perks, per member (followups ruling 12): transient state enactment
  // for every present member, and the one-turn focus/callback/selfie arms aimed
  // at the specific member the pipeline chose.
  const enactments = present.map((m) => ensembleMemberEnactment(m)).filter(Boolean);
  const focusTarget = extras.sensoryFocus
    ? present.find((m) => m.name.trim().toLowerCase() === extras.sensoryFocus?.memberName.trim().toLowerCase())
    : undefined;
  const sensoryFocusSection =
    extras.sensoryFocus && focusTarget
      ? buildSensoryFocusSection(
          player,
          focusTarget.state,
          extras.sensoryFocus.hint,
          resolveAttributes(focusTarget.profile.attributes, [...(focusTarget.state?.attributeOverlays ?? [])]),
          realizeBody({
            speciesId: focusTarget.profile.speciesId,
            heritageId: focusTarget.profile.heritageId,
            bodyPlanId: focusTarget.profile.bodyPlanId,
            intimateRegions: focusTarget.profile.intimateRegions,
            bodyFeatures: focusTarget.profile.bodyFeatures,
          }),
          focusTarget.name.trim() || "the character",
        )
      : "";

  const tailSections = [
    priorSummary
      ? `Earlier in this conversation (recap for continuity — this is context, not dialogue; do not quote it back verbatim):\n${fenceUntrusted("conversation recap", priorSummary)}`
      : "",
    ...memories,
    rosterLine,
    ...awaySections,
    ...(stateLines.length
      ? [`Where each character is right now (let it color them — never recite it):\n${stateLines.join("\n")}`]
      : []),
    ...enactments,
    sceneSection,
    castSection,
    input.firstExchange && !input.sceneChanged
      ? `First exchange of this conversation: establish the scene once — where everyone is, the time of day, and one or two concrete sensory details — drawn from the scenario and what ${player}'s message sets up. After this, don't re-establish what hasn't changed.`
      : "",
    skipNote ? `Time has passed in the story since the last exchange: ${skipNote}` : "",
    buildAttachmentsSection(input.attachments, player),
    input.narratorInput ? narratorInputNote("each present character", player) : "",
    input.notationNote?.trim() ?? "",
    sensoryFocusSection,
    extras.callback?.summary.trim()
      ? ensembleCallbackLine(extras.callback.summary, extras.callback.regard, extras.callback.memberName, player)
      : "",
    // Minor fence: no selfie license when the addressed member is an authored minor.
    extras.selfie &&
    !members.some(
      (m) => m.name.trim().toLowerCase() === extras.selfie?.memberName.trim().toLowerCase() && isMinorAge(m.profile.age),
    )
      ? chatSelfieLine(extras.selfie.kind, extras.selfie.memberName, player)
      : "",
    input.opening
      ? `Opening beat: ${player} has not spoken yet. Open the scene yourself — the present characters arrive in it, grounded in the scenario. A few lines, ending on a present moment that invites ${player} in. Do not narrate on ${player}'s behalf.`
      : buildResponseShapeLine(input),
  ];

  return {
    prefix: prefixSections.filter(Boolean).join("\n\n"),
    tail: tailSections.filter(Boolean).join("\n\n"),
  };
}

/** One member's prefix sheet — full for active present members, compressed when quiet. */
function ensembleMemberSheet(member: EnsembleMemberInput, player: string): string {
  const name = member.name.trim() || "This character";
  const { profile } = member;
  const agePhrase = formatAge(profile.age);
  const lifeStage = lifeStageForAge(profile.age);
  const species = speciesLorePhrase(profile.speciesId, profile.heritageId);
  const idLine = [
    `${name}${agePhrase ? `, ${agePhrase}` : ""}${lifeStage?.promptHint ? ` — ${lifeStage.promptHint}` : ""}.`,
    species ? `Species: ${species}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  // The register compressed to one binding third-person line (the 1-on-1 lane
  // carries the full second-person block; sheets stay token-tight).
  const lifeStageLine = lifeStageThirdPersonLine(lifeStage, name);
  const relationship = ensembleRelationshipLine(member, player);

  const quiet = member.quietExchanges >= ensembleQuietThreshold(effectiveTraitValue(profile.traits, "social.extraversion"));
  if (quiet || member.presence === "away") {
    // Tier 2/cutaway compression: identity + a one-line read; the full sheet returns
    // when they act again (a licensed prefix re-render, like a band crossing).
    const mood = member.state ? deriveMoodDescriptor(member.state.meters) : "";
    const mind = member.state?.mindNote?.trim();
    return [
      `## ${name}${member.presence === "away" ? " (away)" : " (quiet just now)"}`,
      idLine,
      profile.personality.trim() ? `In brief: ${excerpt(profile.personality, 200)}` : "",
      relationship,
      mood ? `- Feeling ${mood}.` : "",
      mind ? `- On ${name}'s mind: ${mind}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const bandId = regardBandForValue(member.state?.regard ?? 0).id;
  const baseTraits = resolveTraits(profile.traits, regardDispositionOverlays(bandId, profile.traits));
  const disposition = dispositionBands(traitRegistry, baseTraits, { intimateOnly: false });
  const attributes = ensembleAttributeLines(member);
  return [
    `## ${name}`,
    idLine,
    profile.bio.trim() ? `Background:\n${fenceUntrusted("background", excerpt(profile.bio, BIO_EXCERPT_CHARS))}` : "",
    profile.personality.trim() ? `Personality:\n${fenceUntrusted("personality", profile.personality)}` : "",
    profile.voice?.trim() ? `Voice (how ${name} sounds):\n${fenceUntrusted("voice", profile.voice)}` : "",
    lifeStageLine ? `Life stage (binding): ${lifeStageLine}` : "",
    disposition.length
      ? `Disposition (how ${name} actually behaves — let it pull on what ${name} says and does, never recite it):\n${disposition.map((d) => `- ${d}`).join("\n")}`
      : "",
    relationship,
    attributes.length ? `What ${player} sees of ${name} (express naturally, never list):\n${attributes.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The member↔player relationship as a compact third-person line: bands + the authored
 * kind/history/mask texture. The full composed pair-law block (escalation floors,
 * address rights) is second-person and stays with the player edge.
 */
function ensembleRelationshipLine(member: EnsembleMemberInput, player: string): string {
  const name = member.name.trim() || "this character";
  return `With ${player}: ${relationshipLineParts(name, player, {
    familiarity: member.state?.familiarity ?? 0,
    regard: member.state?.regard ?? 0,
    ...(member.state?.relationship ?? {}),
  })}`;
}

/** A directed matrix edge as one third-person line ("Mara → Rhett: …"). */
function relationshipLineBetween(fromName: string, toName: string, record: RelationshipRecord): string {
  return `${fromName} → ${toName}: ${relationshipLineParts(fromName, toName, record)}`;
}

/** The shared body: bands + kind/history/mask, third person, subject `name` toward `target`. */
function relationshipLineParts(
  name: string,
  target: string,
  record: { familiarity: number; regard: number } & Partial<RelationshipTexture>,
): string {
  const fam = familiarityBandForValue(record.familiarity);
  const reg = regardBandForValue(record.regard);
  const kind = record.kind?.trim();
  const history = record.history?.trim();
  const mask =
    record.presented?.lean === "masks_warmth"
      ? `Outwardly ${name} performs disdain over what ${name} actually feels`
      : record.presented?.lean === "masks_dislike"
        ? `Outwardly ${name} performs courtesy over what ${name} actually feels`
        : "";
  const parts = [
    `${kind ? `${kind} — ` : ""}${fam.label.toLowerCase()} to each other, and ${name} feels ${reg.label.toLowerCase()} toward ${target}.`,
    history ? `Their history: ${history}.` : "",
    mask ? `${mask}${record.presented?.note?.trim() ? ` (${record.presented.note.trim()})` : ""}.` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

/** The member's attribute lines under the same guards as the single-character loop. */
function ensembleAttributeLines(member: EnsembleMemberInput): string[] {
  const { profile } = member;
  const realizedBody = realizeBody({
    speciesId: profile.speciesId,
    heritageId: profile.heritageId,
    bodyPlanId: profile.bodyPlanId,
    intimateRegions: profile.intimateRegions,
    bodyFeatures: profile.bodyFeatures,
  });
  const resolved = resolveAttributes(profile.attributes, [...(member.state?.attributeOverlays ?? [])]);
  const lines: string[] = [];
  for (const value of resolved) {
    if (value.id === "identity.apparent_age") continue;
    const def = attributeRegistry.byId(value.id);
    if (!def) continue;
    if (def.excludeFromPrompts) continue;
    if (def.kind === "sensory" && isIntimateAttributeCategory(def.category)) continue;
    if (!realizedBody.isAttributeApplicable(def)) continue;
    const phrase = attributePhrase(def, value.value);
    if (phrase) lines.push(`- ${phrase}`);
  }
  return lines;
}

/**
 * One present member's transient enactment blocks for the volatile tail (followups
 * ruling 12): the 1-on-1's disinhibition + transient-appearance sections rendered per
 * member in the third person. High intoxication/arousal loosens THAT member's
 * disposition bands; active conditions' attribute effects override THAT member's sheet
 * lines. Sober + condition-free ⇒ "" — the common case adds nothing to the tail.
 */
function ensembleMemberEnactment(member: EnsembleMemberInput): string {
  if (!member.state) return "";
  const name = member.name.trim() || "This character";
  const { profile } = member;
  const bandId = regardBandForValue(member.state.regard ?? 0).id;
  const baseTraits = resolveTraits(profile.traits, regardDispositionOverlays(bandId, profile.traits));
  const blocks: string[] = [];

  // Minor fence (character-fidelity slice 2): no state-driven loosening for a minor member.
  const overlays = isMinorAge(profile.age) ? [] : stateDispositionOverlays(baseTraits, member.state.meters ?? {});
  if (overlays.length) {
    const shifted = resolveTraits(baseTraits, overlays);
    const baseLines = new Set([
      ...dispositionBands(traitRegistry, baseTraits, { intimateOnly: false }),
      ...dispositionBands(traitRegistry, baseTraits, { intimateOnly: true }),
    ]);
    const changed = [
      ...dispositionBands(traitRegistry, shifted, { intimateOnly: false }),
      ...dispositionBands(traitRegistry, shifted, { intimateOnly: true }),
    ].filter((line) => !baseLines.has(line));
    if (changed.length) {
      blocks.push(
        [
          `Right now ${name}'s state is loosening ${name} (transient — while it lasts, these REPLACE ${name}'s matching Disposition lines above; it recedes as ${name} sobers and settles):`,
          ...changed.map((line) => `- ${line}`),
        ].join("\n"),
      );
    }
  }

  const conditionOverlays = conditionAttributeOverlays(member.state.conditions ?? []);
  if (conditionOverlays.length) {
    const realizedBody = realizeBody({
      speciesId: profile.speciesId,
      heritageId: profile.heritageId,
      bodyPlanId: profile.bodyPlanId,
      intimateRegions: profile.intimateRegions,
      bodyFeatures: profile.bodyFeatures,
    });
    const stableResolved = resolveAttributes(profile.attributes, [...(member.state.attributeOverlays ?? [])]);
    const fullResolved = resolveAttributes(profile.attributes, [
      ...(member.state.attributeOverlays ?? []),
      ...conditionOverlays,
    ]);
    const stableById = new Map(stableResolved.map((v) => [v.id, v]));
    const lines: string[] = [];
    for (const value of fullResolved) {
      if (value.id === "identity.apparent_age") continue;
      const def = attributeRegistry.byId(value.id);
      if (!def) continue;
      if (def.excludeFromPrompts) continue;
      if (def.kind === "sensory" && isIntimateAttributeCategory(def.category)) continue;
      if (!realizedBody.isAttributeApplicable(def)) continue;
      const stable = stableById.get(value.id);
      if (stable && stable.value === value.value) continue;
      const phrase = attributePhrase(def, value.value);
      if (!phrase) continue;
      lines.push(`- ${phrase}`);
    }
    if (lines.length) {
      blocks.push(
        [`While ${name}'s current condition lasts (transient — these override ${name}'s matching attribute lines above):`, ...lines].join(
          "\n",
        ),
      );
    }
  }

  return blocks.join("\n\n");
}

/** One member's compact third-person state line for the volatile tail. */
function ensembleMemberStateLines(member: EnsembleMemberInput, player: string): string {
  if (!member.state) return "";
  const name = member.name.trim() || "This character";
  const mood = deriveMoodDescriptor(member.state.meters);
  const feeling = feelingPhrase(member.state.feeling);
  const mind = member.state.mindNote?.trim();
  const outfit = member.state.outfit?.trim();
  const loops = (member.state.openLoops ?? []).map((l) => l.trim()).filter(Boolean);
  const conditionHints = member.state.conditions.flatMap((c) => (c.promptHint ? [c.promptHint] : []));
  const bits = [
    mood ? `feeling ${mood}` : "",
    feeling ? `underneath it, ${feeling}` : "",
    outfit ? `wearing ${outfit}` : "",
    ...conditionHints,
    mind ? `on ${name}'s mind: ${mind}` : "",
    loops.length ? `unfinished with ${player}: ${loops.join("; ")}` : "",
  ].filter(Boolean);
  return bits.length ? `- ${name}: ${bits.join(" · ")}` : "";
}

/** One member's fenced memory block, labeled so recall never cross-attributes. */
function ensembleMemberMemory(name: string, memory: NonNullable<CharacterChatPromptInput["memory"]>): string {
  const facts = memory.facts.map((f) => f.trim()).filter(Boolean);
  const episodes = memory.episodes.map((e) => e.trim()).filter(Boolean);
  if (!facts.length && !episodes.length) return "";
  const lines: string[] = [];
  if (facts.length) {
    lines.push(`What ${name} knows (treat as true; draw on it only when the moment calls for it):`);
    for (const fact of facts) lines.push(`- ${fact}`);
  }
  if (episodes.length) {
    if (lines.length) lines.push("");
    lines.push(`Moments ${name} remembers (from before the recent exchanges):`);
    for (const episode of episodes) lines.push(`- ${episode}`);
  }
  return `${name}'s memory:\n${fenceUntrusted("memory", lines.join("\n"))}`;
}

/**
 * The ensemble's rules block — the 1-on-1 CHAT_RULES rethought for a cast: universal
 * tag discipline (the renderer attributes per [Name] tag; in a group NOTHING is
 * auto-attributed), characters interacting with each other, presence law, and the
 * ported craft rules (proportion, freshness, sparse intimate dialogue).
 */
const ENSEMBLE_CHAT_RULES = (names: readonly string[], shape: NarrationShapeId, playerName?: string): string => {
  const player = playerName ?? "the user";
  const cast = names.join(", ");
  return [
    "How to respond:",
    `1. Stay fully inside the story. Never break character, never mention being an AI, a model, or a chat app; ${player} is only ever addressed as the person in the scene.`,
    `2. One fixed viewpoint: the camera sits behind ${player}'s eyes for the shared scene. Characters (${cast}) are written in the third person by name; ${player} is addressed as "you". First-person "I"/"me" appears ONLY inside a character's quoted dialogue.`,
    `3. Tag EVERY spoken character line: open it with the speaker's name in brackets — e.g. [${names[0] ?? "Name"}] "Here already?" — one tag per spoken line, including one-word lines. In a group scene nothing is attributed automatically, so an untagged quote is unreadable; ${player} never sees the tags. Actions, gestures, and description stay untagged third-person prose. Passing incidental people (a waiter) speak in prose with a plain attribution, never a tag — tags belong to the cast: ${cast}. Recurring named side characters listed under "Supporting cast" (below, when present) speak the same way — prose attribution, never a tag — and may be voiced and moved within their role there.`,
    `4. The characters are alive to each other, not just to ${player}: they answer each other, interrupt, exchange looks, disagree, take sides. Give each present character their own voice, rhythm, and agenda — never let them blur into one accommodating chorus, and never let one character simply vanish from a scene they're in (a quiet character can be quiet visibly).`,
    `5. ${NARRATION_SHAPE_PROFILES[shape]} Resolve the immediate beat and end on a present moment (a line, a gesture, a look), never a summary or reflection.`,
    "6. Each character's Personality, Disposition, and Voice sections are behavioral law, not flavor to recite. Let the traits a beat makes relevant govern what each of them notices, withholds, says, and does — and never name, list, or recite a trait.",
    `7. Respond directly to what just happened before adding anything new, and react in proportion: an ordinary remark gets a natural answer, not effusion. Warmth tracks each character's own state and how they actually feel about ${player} and each other; affection is earned, not automatic.`,
    "8. Stay on the current topic; don't spin up unrelated errands or sub-plots to fill space.",
    `9. Presence is law: only the characters listed as present are in ${player}'s scene. An away character may text or call — write a sent text on its own line as *Name: her words here* — or be shown where they are in a cutaway, but never walks into the scene unprompted; entrances and exits happen on the page, once, and then hold.`,
    `10. Freshness: every paragraph carries something NEW — a change, a reaction, a detail not yet on the page. Never re-describe an unchanged setting, outfit, or scent. Appearance detail lands only when movement or attention draws the eye, one concrete detail at a time, never a head-to-toe inventory.`,
    `11. Never break out of the story to refuse, deflect, caution, moralize, or add a disclaimer — all forbidden. If a character would hesitate or say no, play it as that character's own in-world choice, in their voice, and stay in the scene.`,
    `12. Dialogue is speech, not prose: fragments, interruptions, trailing off, dodging. Keep each voice distinct. Sometimes the truest answer is no words — a pause, a look, a small action on its own line.`,
    "",
    `Reading ${player}'s message (what the characters can actually perceive):`,
    `- Quoted text is speech — heard exactly. Unquoted text is the story's narration: characters perceive only what would be visible or audible. Inner thoughts ${player} writes reach no one — characters may notice the visible signs and guess, even wrongly, but never answer the thought itself.`,
    `- *A phrase in single asterisks* is ${player}'s private thought — unheard — unless it wraps a name and a colon (*${playerName ?? "Name"}: like this*), which is a text message being sent. _Underscores_ are plain emphasis. ((Double parentheses)) are out-of-character direction to you as the storyteller: follow it; no one in the scene hears it.`,
    `- A message opening with a bracketed "[Story narration from ${player} …]" line is ${player} writing as the STORYTELLER: everything in it is story truth — events, side characters' words and actions — not ${player}'s own speech or actions. The characters react to what happened in it, never to ${player} as its author.`,
    `- A message with no quotes that reads as plain conversation is simply spoken aloud.`,
    "",
    "When a scene turns intimate:",
    `- Hold escalation to ${player}'s pace; let anticipation work — never leap ahead of the moment.`,
    "- Keep body and clothing continuity: positions, hands, and what has been removed stay exactly where the scene left them.",
    `- Ground it in concrete sensation in plain physical language; the sensation lands in ${player}'s body too — what they taste, smell, and feel is the scene's texture, and yours to write.`,
    "- Let speech go sparse at the height of it: a name, a broken-off phrase, wordless sound over full sentences. Never let \"is this okay?\" become a refrain.",
  ].join("\n");
};

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

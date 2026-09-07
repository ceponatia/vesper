import { type AttributeValue } from "@/contracts/attributes/value";
import { type ActiveCondition } from "@/contracts/conditions/condition";
import { type HairOcclusion } from "@/contracts/items/hair-occlusion";
import { type ChatSceneMemory } from "@/contracts/turns/chat-scene-memory";
import { type SupportingCast } from "@/contracts/turns/chat-supporting-cast";
import { type SalientPlan } from "@/contracts/turns/chat-plans";
import { type SocialReactionCard } from "@/contracts/personality/cards";
import { type TraitValue } from "@/contracts/personality/traits/value";
import { type ChatDrive } from "@/contracts/personality/drives";
import { type RelationshipRecord, type RelationshipTexture } from "@/contracts/relationships/record";
import { type CharacterProfile } from "@/contracts/world/profile";
import { type VoiceExemplar } from "../../chat-voice";
import { type ChatFeelingState } from "../../chat-feeling";
import { type ChatSensoryAllowance, type SensoryFocusHint } from "../../chat-intent";
import { type NarratorInstructionSource, type NarratorPromptNode } from "@/contracts/narrator-prompts";
import { type NarrationShapeId } from "../constants";

/**
 * The character-chat system prompt (docs/character-chat/).
 *
 * A focused, single-character system prompt for the chat lane. It deliberately
 * reuses the SAME representation the in-game narrator gets — resolved attribute
 * values via the registry, plus each attribute's `promptHints` as phrasing
 * guidance (the narrator keeps hints; only the image prompt strips them,
 * images/prompts-*.ts) — and carries the chat lane's own layers: the tracked state
 * (meters/conditions/regard, enacted per docs/character-chat/prompts.md
 * §Character-chat state as a narration system), the rolling-summary recap, and
 * the RAG "Your memory"
 * block. What it still deliberately drops is the session's world machinery:
 * presence, locations, wardrobe state, the exposure mask. Pure and
 * snapshot-testable; no IO.
 */

export interface CharacterChatPromptInput {
  name: string;
  profile: CharacterProfile;
  /**
   * Running recap of the conversation OLDER than the verbatim window. Context
   * only — carries continuity past the message window. Empty/undefined ⇒ no recap
   * block (a fresh chat, or summarization off), so the prompt is unchanged from
   * before.
   */
  priorSummary?: string;
  /**
   * Retrieved long-term memory for THIS turn: cosine-RAG
   * hits over the chat's OWN facts + episodes, injected as a recall block that sits beneath the
   * rolling summary — the summary is the short-term reinforcement layer, this reaches past
   * its horizon. Absent/empty ⇒ no block, so a fresh chat's prompt is unchanged.
   */
  memory?: { facts: string[]; episodes: string[] };
  /**
   * The **persona** the user is playing as, resolved via
   * `resolveChatPersona`. Present ⇒ the character addresses the player by `name` and
   * reads their sheet; absent ⇒ the original faceless "the user" phrasing, so existing
   * snapshots are unchanged.
   *
   * `title` is deliberately not here and never will be — see `PlayerPersona`.
   */
  player?: {
    name: string;
    /** The bio (`profile.bio`) — who they are. */
    persona?: string;
    /** The resolved garment phrase for what the player has on right now. */
    wearing?: string;
    /**
     * The player's intimate regions read bare — COVERAGE-COMPUTED from their worn items,
     * never a manual flag. One of the three signals `chatSceneIsIntimate` gates on.
     */
    exposed?: boolean;
    /** How the player's voice sounds — the narrator describes it, it never writes their lines. */
    voice?: string;
    /**
     * What the player RESPONDS to (`profile.intimacy`). Note the inverted semantics vs a
     * character's `intimacy`, which is how *they* behave as a lover; this is guidance for
     * how to treat the player, so it needs its own wording, not the character block's.
     */
    intimacy?: string;
  };
  /**
   * Light chat state, surfaced as a compact
   * "Current state" section + a per-chat scenario block. Absent ⇒ the prompt is
   * byte-identical to the stateless chat (existing snapshots hold). The builder
   * owns the surfacing (it already imports the contracts), so it's snapshot-tested
   * in one place.
   */
  state?: {
    meters: Record<string, number>;
    /** The feeling axis (was `affinity`); the law block reads this scalar. */
    regard: number;
    /** The knowledge axis — consumed by the composed law block. */
    familiarity?: number;
    /** Authored relationship texture (kind/history/mask/looming) — consumed by the law block. */
    relationship?: RelationshipTexture;
    conditions: ActiveCondition[];
    mindNote?: string;
    /** The per-chat scenario framing — the strongest framing in the prompt. */
    premise?: string;
    /**
     * Meter bands surfaced as a "just shifted" beat last turn:
     * `{ meterId: band }`. The anti-repetition gate foregrounds a band only when it differs
     * from this; absent ⇒ today's behavior (every crossed band is "new").
     */
    surfacedCues?: Record<string, string>;
    /** Free-text current outfit (scenario modal) — a light scene anchor for the narrator. */
    outfit?: string;
    /** Whether the outfit reads more exposed than usual (tone hint only). */
    outfitExposed?: boolean;
    /**
     * How much of the character's hair their worn headwear hides — the
     * wardrobe seam's resolved band (`ResolvedChatWardrobe.hairOcclusion`,
     * docs/contracts/items/README.md §Hair occlusion). Carried beside `outfit`
     * so the prompt reads one answer with the wardrobe; absent means `none`.
     */
    hairOcclusion?: HairOcclusion;
    /**
     * The AUTHORITATIVE wardrobe digest (behind `CHAT_GARMENT_CUES`): who is
     * wearing what, how each piece currently sits, and
     * what is lying around the room — pre-rendered by the pipeline via
     * `renderGarmentDigest`, the same way `rhythm` and `storyMoment` are. It
     * COMPLEMENTS the `outfit` phrase rather than replacing it: the phrase is what
     * she looks like, this is what the narrator may not contradict. Absent/"" ⇒ no
     * block (the flag-off default, byte-identical to today).
     */
    garmentDigest?: string;
    /**
     * The bounded garment CUE block: ≤2 ranked, perception-safe, already
     * repeat-gated observations for this exchange. Distinct from the digest as
     * attention is from authority — a fresh cue means something actually changed.
     * Absent/empty ⇒ no block.
     */
    garmentCues?: string[];
    /**
     * The bounded AFFORDANCE cue block (behind `CHAT_AFFORDANCE_CUES`): ≤2
     * ranked, perception-safe, already repeat-gated
     * physical observations — damp hair gathering into strands, loose ends moving
     * in the wind — pre-rendered into short clauses by the pipeline.
     *
     * Attention with NO authority twin, unlike the garment pair: the state these
     * read from is already authoritative in the Attributes section and the wardrobe
     * lines, so a second guard block would only invite repetition. They describe a
     * CURRENT EFFECT by construction (every phenomenon requires a live cause), which
     * is what keeps them from restating the static appearance above. Absent/empty ⇒
     * no block (the flag-off default, byte-identical to today).
     */
    affordanceCues?: readonly string[];
    /**
     * The visual-state projection's MUST-NOT-CONTRADICT clauses (the per-chat
     * narration switch): the visible
     * mandatory facts — what is worn, what morphology this body has — as
     * contradiction prevention, not as material for a beat. Unlike every other
     * block here they are NOT change-gated: a coat worn for six exchanges is as
     * contradictable on the seventh as it was on the first. Absent/empty ⇒ no
     * block, which is the flag-off default and byte-identical to today.
     */
    visualConstraints?: readonly string[];
    /**
     * The visual-state projection's selected optional detail — at most the
     * selection's strict budget, each already change-gated, action-relevant or
     * newly revealed, and each carrying the reason it earned the slot. The
     * positive half of the pair above, and the half the paid trial measures.
     */
    visualCues?: readonly string[];
    /**
     * The character's unfinished business —
     * rendered as a standing "Unfinished business" state line (never-recite discipline),
     * so long conversations get narrative pull, not just recall. Absent/empty ⇒ no line.
     */
    openLoops?: string[];
    /**
     * The one-shot time-skip note (`pendingSkipNote`): a volatile one-turn
     * tail line ("The next morning — acknowledge the gap naturally, once"), pre-worded
     * by stage band via `chatSkipNote`. Absent/empty ⇒ no line; cleared by the finalizer.
     */
    skipNote?: string;
    /**
     * The current story moment, pre-formatted by the
     * pipeline from the clock + calendar anchor ("Friday, January 5 — 2:10pm
     * (afternoon)"). The ONE authoritative time — replaces the retired archivist
     * free-text `sceneMemory.timeOfDay`. Absent/"" ⇒ no line.
     */
    storyMoment?: string;
    /**
     * The meanwhile pass's one-shot note: what actually happened
     * off-screen while time passed — composes with the skip note, rendered once, cleared
     * by the finalizer with it. Absent/"" ⇒ no line (an ordinary skip).
     */
    meanwhileNote?: string;
    /**
     * The character's daily rhythm (formatScheduleRhythm): one
     * compact standing line grounding time-of-day texture and meanwhile beats in their
     * actual routine. Absent/"" ⇒ no line.
     */
    rhythm?: string;
    /**
     * Where this character was while away. On a
     * PRESENT character this is a one-turn "just came from" license — the finalizer
     * clears it after it renders.
     */
    whereabouts?: string;
    /** Active social cards — surfaced as soft "what you care about" framing, never severity. */
    activeSocialCards?: SocialReactionCard[];
    /**
     * Persisted narrative attribute overlays that EVOLVE over the chat:
     * resolved on top of the authored base, BENEATH the transient condition overlays. Absent ⇒
     * today's behavior (authored attributes only). A haircut/dye recorded by the archivist lands here.
     */
    attributeOverlays?: AttributeValue[];
    /**
     * Persisted narrative TRAIT overlays that evolve over the chat: resolved on
     * top of the authored traits so the character's bounded
     * personality arc (a warmth/guardedness/confidence shift) reaches the Disposition
     * bands and the slider-wired mechanics. Absent ⇒ authored traits only.
     */
    traitOverlays?: TraitValue[];
    /**
     * Voice-exemplar ring: ≤5 distinctly in-voice lines the
     * character actually said, rendered as a "How you sound" few-shot block past the
     * events-only summary horizon. Absent/empty ⇒ no block.
     */
    voiceExemplars?: VoiceExemplar[];
    /**
     * One-turn character-consistency corrective: last
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
     * Supporting cast: recurring named side characters
     * the story established — rendered as a compact volatile-tail block licensing the
     * narrator to voice and move them (prose attribution, never a tag). Absent/empty ⇒
     * no block, and rule 3's incidental-person discipline stands alone.
     */
    supportingCast?: SupportingCast;
    /**
     * Emotional weather: the persistent feeling COMPOSES with
     * the meter-derived mood descriptor (owner ruling — the descriptor is the baseline
     * weather, the feeling the front passing through), coloring the Current-state mood
     * line and the response-shape mood pin. Absent/empty ⇒ both render as before.
     */
    feeling?: ChatFeelingState;
    /**
     * Runtime drives: rendered as the "What you want"
     * tail block — open drives steer, guarded ones withhold-until-asked, secret
     * ones are protected below their reveal band (full-but-scoped lie license,
     * owner ruling 2026-07-11). Absent/empty ⇒ no block.
     */
    drives?: ChatDrive[];
    /**
     * Plans & promises: the commitments NEAR this turn —
     * due now / imminent / just-missed, plus at most a couple upcoming — already derived
     * against the story clock (`derivePlanSalience`). Rendered as the compact "Plans"
     * block with per-state directives (anticipation / the event / the fallout). Absent or
     * all-far ⇒ no block; a standing list is never dumped every turn.
     */
    plans?: readonly SalientPlan[];
  };
  /**
   * Opening beat ("Prompt Character"): the
   * player hasn't spoken yet — the character speaks first, opening the scene from
   * the scenario + state. Absent ⇒ byte-identical to a normal turn.
   */
  opening?: boolean;
  /**
   * Active narration shape profile — the dev
   * toggle still forces chat length when set. Defaults to DEFAULT_NARRATION_SHAPE; the
   * chat route passes `narrationShapeId("chat")` (resting default `aggressive_concise`).
   */
  narrationShape?: NarrationShapeId;
  /**
   * A one-turn cue invitation. It carries only the
   * "has something to say" continue-cue (an open loop the character opens about); the sensory
   * arms (proximity/touch/intimacy/attention via `chatCueInviteLine`) were superseded by the
   * deterministic `sensoryAllowance` below. Pre-rendered so this builder stays pure over a string.
   */
  cueInvite?: string;
  /**
   * The deterministic per-turn sensory allowance:
   * the ONE binding statement of what person-level sensory/appearance detail may land this turn,
   * derived by the route from the existing detectors (`deriveChatSensoryAllowance` over
   * `detectChatCue` / `detectSensoryFocus`). Replaces the four scattered "one cue, earned"
   * teachings (old rules 11–12, the cue-invite sensory arms, the Sensory-cues closing bullet) with
   * one authority the static rules defer to. Absent (opening/continue beats) ⇒ no line ⇒ rule 10's
   * conservative default. `focused_description` renders no line — the Sensory-focus block IS the grant.
   */
  sensoryAllowance?: ChatSensoryAllowance;
  /**
   * Derived-fact notation note: a volatile
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
   * A one-turn memory callback: an old shared episode the
   * cadence gate + selector offered this turn — rendered as an optional "you might find
   * yourself remembering…" tail line, WORDED BY REGARD BAND (warm nostalgia / plain /
   * pointed — owner ruling 2026-07-11). The lowest-priority tail block: the pipeline
   * only supplies it when no skip note, first-exchange directive, sensory focus, or
   * intimate beat competes. Absent ⇒ no line.
   */
  callback?: { summary: string };
  /**
   * Attached-photo vision reads: what the character SEES
   * in each photo the player's current message attached, in order — seen-channel
   * content under the perception partition, handled by rule 16. Fenced (the reads
   * derive from player-supplied images). Absent/empty ⇒ no block.
   */
  attachments?: { descriptions: string[] };
  /**
   * One-turn selfie license: "request" = the player asked
   * for a photo this turn; "offer" = the unprompted-offer gates hold (apart-only
   * comms register + warm regard + cooldown — owner ruling); "opener" = a warm
   * reopen opener may attach the "thinking of you" photo (register-conditional:
   * only if the opener lands as a text). Renders
   * as an optional tail line; the post-turn pulse decides whether one actually sent.
   */
  selfie?: "request" | "offer" | "opener";
  /**
   * The CURRENT turn's input was authored in NARRATOR mode:
   * story narration from the player as storyteller — supporting-cast dialogue, offscreen
   * developments, scene flavor — never the player's own POV. Renders a one-turn tail note
   * suspending the player-input perception rules for this message; PAST narrator lines are
   * marked in history by the pipeline's `wrapNarratorInput`.
   */
  narratorInput?: boolean;
  /**
   * The narrator PHYSICAL-GUIDANCE lines for this exchange (behind
   * `CHAT_PHYSICAL_CONSTRAINTS`):
   * the ≤2 premise corrections and ≤3 scoped consistency constraints the compiler
   * selected, already worded by `chat-physical-guidance-render.ts`.
   *
   * TOP-LEVEL rather than under `state`, which is the substantive difference from the
   * `affordanceCues` block beside it: these are turn-scoped. A correction is about the
   * message the narrator is holding, and a constraint is only selected because
   * something in this turn made it relevant — neither is standing state, and putting
   * them in the state slice would invite someone to cache them with it.
   *
   * Renders as a BINDING turn note, because a fence the narrator may weigh against a
   * sensory allowance is not a fence. Absent/empty ⇒ zero bytes.
   */
  physicalGuidance?: readonly string[];
  /**
   * Whose narrator INSTRUCTIONS this exchange follows, resolved once under the
   * exchange lock and frozen for every attempt.
   *
   * Absent — and `{ kind: "production" }` — render the production prompt, byte for
   * byte. A `test` source replaces the classified behavior/craft layer with the
   * owner's handwritten body and leaves everything else exactly where it is:
   * identity, persona, state, memory, per-turn ceilings, the perception rules, the
   * `[Name]` attribution contract.
   */
  instructionSource?: NarratorInstructionSource;
}

/**
 * The prompt split for provider prefix-caching:
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
 * The same split, one step before rendering: the CLASSIFIED node trees the prompt
 * is assembled from.
 *
 * Exposed so the take-provenance work can weigh a prompt by authority layer
 * (`narratorPromptAuthorityWeights`) without re-deriving the classification, and
 * so a test can assert which units an override keeps by id rather than by
 * grepping assembled prose. Each side is ONE group node, so rendering it is
 * `renderNarratorPrompt(nodes.prefix, mode)`.
 */
export interface CharacterChatPromptNodes {
  prefix: readonly NarratorPromptNode[];
  tail: readonly NarratorPromptNode[];
}

// ---------------------------------------------------------------------------
// Ensemble frame — roster > 1
// ---------------------------------------------------------------------------

/** One roster member's prompt inputs (the pipeline loads state/memory per member). */
export interface EnsembleMemberInput {
  name: string;
  profile: CharacterProfile;
  state?: CharacterChatPromptInput["state"];
  /** This member's OWN retrieval (tier-1 legs — each character's memory is their own). */
  memory?: CharacterChatPromptInput["memory"];
  presence: "present" | "away";
  quietExchanges: number;
}

/**
 * One directed member↔member edge for the ensemble prompt (the relationship
 * matrix): tier 1 =
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
  /**
   * Whose narrator instructions this ensemble exchange follows. Same contract as the
   * 1-on-1 lane's `CharacterChatPromptInput.instructionSource`: absent or `production`
   * ⇒ byte-identical output; a `test` source replaces only the craft layer, and the
   * roster, presence law and `[Name]` tag contract stay exactly where they are.
   *
   * On `extras` rather than `input` because the ensemble frame is assembled from the
   * extras the pipeline resolves per exchange, and `buildChatPromptPartsForRoster`
   * forwards `input` unchanged to the 1-on-1 path when the roster collapses to one.
   */
  instructionSource?: NarratorInstructionSource;
}

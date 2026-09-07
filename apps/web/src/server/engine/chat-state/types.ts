import type {
  ActiveCondition,
  AffordanceCueState,
  BodySurfaceState,
  ChatDrive,
  ChatEnvironment,
  ChatGarmentStore,
  ChatMemoryTrace,
  ChatPlan,
  ChatPlayerState,
  ChatPulseTrace,
  ChatSceneMemory,
  EmotionLabel,
  Milestone,
  RelationshipSample,
  RelationshipTexture,
  SceneState,
  SkipRecord,
  SocialReactionCard,
  SupportingCast,
  TraitValue,
} from "@/contracts";
import type { AttributeValue } from "@/contracts/attributes/value";
import type { CalendarStart } from "@/lib/clock";
import type { CallbackEntry } from "../chat-callback";
import type { ChatFeelingState } from "../chat-feeling";
import type { SelfieEntry } from "../chat-selfie";
import type { VoiceExemplar } from "../chat-voice";

/**
 * The chat-wide SCENARIO: what belongs to the conversation rather than any one
 * character — the premise, the SETTING-wide house rules (per-character
 * divergence rides character tags, never per-character rule lists), the shared
 * scene memory, ONE story clock, the one-shot skip note + skip history, and the
 * scene render prefs. Lives on the `character_chats` row; every roster member
 * reads the same scenario.
 */
export interface ChatScenario {
  premise: string;
  activeSocialCards: SocialReactionCard[];
  sceneAuto: string;
  sceneModel: string;
  sceneMemory: ChatSceneMemory;
  /**
   * Who the PLAYER is in this conversation, and what they're wearing. It lives
   * on the scenario — not on the per-character `ChatState` — because there is
   * one player and many roster characters, and because the scenario IS the
   * "another take" rollback snapshot (`pre_exchange_scenario`): riding it means
   * a discarded reply can't leave the player undressed by a beat that no longer
   * exists.
   */
  playerState: ChatPlayerState;
  /**
   * The conversation's GARMENT INSTANCES + their deduplicated blueprint
   * snapshots. Chat-wide for the same reason `playerState` is — a garment sits
   * at loci no character owns (`scene`, `wardrobe`, `gone`) and moves between
   * body, hands and room — and on the SCENARIO so it rides
   * `pre_exchange_scenario` and rolls back with everything else, instances and
   * blueprint map together, with no new snapshot machinery.
   *
   * The per-character `wornItemIds` / `playerState.wornItemIds` are now a DERIVED
   * projection of this store's worn-locus instances (the one-release compatibility
   * bridge — the equip editor, look key, snapshot and scene queue keep reading ids).
   */
  garments: ChatGarmentStore;
  /**
   * The scene's wind / precipitation / enclosure. Chat-wide for the same reason
   * `sceneMemory` is — one imagined setting for the whole roster — and on the
   * scenario, so it rides `pre_exchange_scenario`: a retake that discards the
   * beat which opened the storm discards the storm.
   */
  environment: ChatEnvironment;
  /**
   * What the affordance read has already offered the narrator, and in which
   * band (the garment `cues` precedent).
   *
   * It is on the SCENARIO rather than the state row because that is what makes
   * "another take" reproduce the identical read: the read is a pure function of
   * committed state plus this memory, so both must roll back on one anchor. The
   * turn finalizer writes it when the read reaches the prompt, and rides it
   * through untouched otherwise.
   */
  affordanceCues: AffordanceCueState;
  /**
   * WHERE THE BODIES ARE (contracts/affordances/scene) — posture, coarse facing
   * and proximity, what bears the weight, and the contact core's active-contact
   * projection housed inside it.
   *
   * Chat-wide because a scene has no owner: proximity is a fact about a PAIR and
   * a contact spans two bodies, so there is no per-character `ChatState` it could
   * sit on without being half a truth. It rides the SCENARIO for the reason
   * `environment` and `affordanceCues` do — the scenario IS the "another take"
   * anchor (`pre_exchange_scenario`), and the physical read is a pure function of
   * committed state plus this placement, so a retake that restores them together
   * reproduces the identical read rather than resolving a discarded beat's pose.
   *
   * `parseSceneState` is the boundary, and it is TOTAL: a malformed blob, a
   * contradicted key, or a version this build cannot read all degrade to
   * `emptySceneState()` with the scene module's own diagnostics — it never
   * throws. That matters more here than anywhere else, because a boundary that
   * could fail would silently kill every existing rollback anchor.
   *
   * This is the PROJECTION. The durable provenance is the `chat_contact_events`
   * ledger (`chat-contact-events.ts`), which replays back into exactly this value
   * — so the projection may always be rebuilt and is never a second truth.
   */
  scene: SceneState;
  /** Recurring named side characters — one cast for the roster. */
  supportingCast: SupportingCast;
  /** Tracked commitments that come due on the story clock. */
  plans: ChatPlan[];
  clockMinutes: number;
  /** The story-calendar anchor: minute 0 = this date+time. Author-editable. */
  calendarStart: CalendarStart;
  pendingSkipNote: string;
  /** The meanwhile pass's one-shot narrator note — composes with the skip note, cleared with it. */
  pendingMeanwhileNote: string;
  /** Clock minute the meanwhile pass last ran (the cumulative gate's origin + the job's idempotency CAS). */
  meanwhilePassAtMinutes: number;
  skipHistory: SkipRecord[];
}

/** The in-memory state for ONE roster character, drifted/seeded/pulsed and persisted as a row. */
export interface ChatState {
  meters: Record<string, number>;
  /** The feeling axis (was `affinity`) — volatile, moved by the reaction pulse. −100..100. */
  regard: number;
  /** The knowledge axis — a slow ratchet, 0..100, never down. */
  familiarity: number;
  /** Familiarity gained this scene (ratchet cap accounting); resets on a time skip. */
  familiaritySceneGain: number;
  /** Authored relationship texture (kind/history/mask/looming) — the record minus the scalar columns. */
  relationship: RelationshipTexture;
  conditions: ActiveCondition[];
  mindNote: string;
  /**
   * Where an AWAY member is, as a phrase — the presence read / meanwhile pass
   * write it; the ensemble away lines render it; a PRESENT member with one
   * pending gets a one-turn "just came from" license, then it clears. Never a
   * location entity.
   */
  whereabouts: string;
  /**
   * Structured worn item-definition ids, seeded from the active preset. When
   * non-empty this is the wardrobe truth — the narrator renders these garments and
   * exposure is COMPUTED from their coverage; empty ⇒ the free-text path applies.
   */
  wornItemIds: string[];
  /** The active outfit preset id — which named look is "on"; "" ⇒ default/none. */
  outfitPresetId: string;
  /**
   * Free-text outfit OVERLAY / fallback: narrated-but-unowned garments ("a borrowed
   * hoodie") ride alongside the worn list; legacy chats carry their whole
   * look here until re-dressed. The scene-image outfit source when no items are worn.
   */
  outfit: string;
  /** Manual intimate-reveal flag — authoritative only on the free-text path (empty worn list); computed from coverage otherwise. */
  outfitExposed: boolean;
  /**
   * Meter bands last surfaced to the narrator as a "just shifted" beat:
   * `{ meterId: band }`. The anti-repetition gate diffs current bands against
   * this so an unchanged state never re-fires a beat.
   */
  surfacedCues: Record<string, string>;
  /**
   * The archivist's memory-retrieval queries for the NEXT turn's RAG recall,
   * produced post-turn and consumed at the next prompt build.
   */
  memoryQueries: string[];
  /**
   * The character's unfinished business: ≤3 short phrases the archivist re-emits
   * in full each exchange (resolved loops fall off). Rendered as an "Unfinished
   * business" state line; read by the "has something to say" initiative check.
   */
  openLoops: string[];
  /**
   * Persisted narrative attribute overlays that evolve over the chat: `source:"narrative"`
   * values the attribute proposer merges in (inherent traits guarded), resolved on top of the
   * authored base at prompt-build time. Distinct from the transient condition overlays.
   */
  attributeOverlays: AttributeValue[];
  /**
   * Persisted narrative TRAIT overlays that evolve over the chat:
   * `source:"narrative"` values the archivist proposes only at relationship
   * milestones, clamped one band from the authored value, resolved on top of the
   * authored traits at prompt build. Parallel to `attributeOverlays`; guarded to the
   * `developable` traits. Editable/rollback-safe — evolution becomes visible, not drift.
   */
  traitOverlays: TraitValue[];
  /**
   * Voice-exemplar ring: ≤5 distinctly in-voice lines the character actually
   * said, one picked per exchange by the archivist — rendered as a
   * "How you sound" few-shot block past the events-only summary horizon. Rolls back
   * with the pre-exchange snapshot; per-character, so it composes in the ensemble.
   */
  voiceExemplars: VoiceExemplar[];
  lastPulseTrace: ChatPulseTrace;
  /** Last-turn RAG debug trace for the dev inspector. */
  lastMemoryTrace: ChatMemoryTrace;
  /** Relationship arc samples — appended when affinity/stage moved; the sparkline. */
  relationshipHistory: RelationshipSample[];
  /** Recorded milestones: first exchange, stage crossings, strong reactions, player-marked. */
  milestones: Milestone[];
  /**
   * Memory-callback ring: episode refs already offered as an unprompted
   * "remember when" cue + the chat-clock minute each fired. The anti-repeat
   * memory behind the cadence gate; rolls back with the pre-exchange snapshot.
   */
  callbackHistory: CallbackEntry[];
  /**
   * Emotional weather: the persistent feeling (label + derived intensity +
   * cause, exchange-decayed) and the bruise (damped positive regard gains after
   * a betrayal at high regard). Pulse-proposed, curve-derived.
   */
  feeling: ChatFeelingState;
  /**
   * Selfie-send ring: recorded request/offer sends + the chat-clock minute each
   * queued — the unprompted-offer cooldown's memory.
   */
  selfieHistory: SelfieEntry[];
  /**
   * Runtime drives: the authored wants + play's progress/revealed/resolved —
   * the drive prompt law and archivist updates.
   */
  drives: ChatDrive[];
  /**
   * Per-body-location surface wetness — the authoritative input the hair
   * affordance domain had no owner for. Fixed point,
   * extraction-proposed, drying lazily on the story clock. PER CHARACTER: one head
   * of hair belongs to one person, so this is a state-row field rather than a
   * scenario one. Rides `storedChatStateSchema`, so a retake restores it.
   */
  bodySurface: BodySurfaceState;
  /**
   * Narrative presence: "present" shares the player's scene; "away" is offstage
   * — meters freeze, no memory legs, only salience-gated relationship lines
   * reach the prompt. Roster panel = manual override; the archivist confirms
   * transitions.
   */
  presence: ChatPresence;
  /**
   * Consecutive exchanges without this character being mentioned, acting, or
   * being spoken to (activity recency): 0 = active this exchange; at/over the
   * quiet threshold their prompt blocks compress to tier 2.
   */
  quietExchanges: number;
}

/** Narrative presence — the only location-like state the chat lane tracks. */
export type ChatPresence = "present" | "away";

/** The strip / state-tools / premise-bar projection returned by GET …/chat/state. */
export interface ChatStateSnapshot {
  meters: Record<string, number>;
  regard: number;
  familiarity: number;
  /** The regard band (was `stage`) — the volatile axis's chip. */
  regardBand: { id: string; label: string };
  familiarityBand: { id: string; label: string };
  /** Authored relationship texture (kind/history/mask/looming). */
  relationship: RelationshipTexture;
  /** Derived discrete emotion for the chat mood chip. */
  emotion: { label: EmotionLabel; intensity: number };
  conditions: ActiveCondition[];
  mindNote: string;
  premise: string;
  /** Structured worn item-definition ids — the Character sheet's equip editor. */
  wornItemIds: string[];
  /** The active outfit preset id — the sheet's preset switcher state. */
  outfitPresetId: string;
  /** Free-text outfit overlay/fallback (ad-hoc + legacy looks) — the sheet's free-text field. */
  outfit: string;
  /**
   * The RENDERED garment phrase (worn items + overlay) for the read-only strip
   * chip. Filled by the async state routes via the wardrobe seam; the
   * sync `chatStateSnapshot` defaults it to the overlay text.
   */
  outfitLabel: string;
  /** Manual intimate-reveal flag (free-text path); computed from coverage when items are worn. */
  outfitExposed: boolean;
  /** Who the player is here + what they're wearing — chat-wide. */
  playerState: ChatPlayerState;
  /** The cards live in THIS chat (editable in the scenario modal). */
  activeSocialCards: SocialReactionCard[];
  /** Meter bands last surfaced as a "just shifted" beat — for the state-tools debug view. */
  surfacedCues: Record<string, string>;
  /** The character's unfinished business — relationship panel + "has something to say". */
  openLoops: string[];
  /** Next-turn RAG queries (the live column, not the trace) — editable in the state tools. */
  memoryQueries: string[];
  /** Persisted narrative attribute overlays — for the inspector. */
  attributeOverlays: AttributeValue[];
  /** Persisted narrative trait overlays — for the inspector/state tools. */
  traitOverlays: TraitValue[];
  /** Voice-exemplar ring — for the inspector/state tools. */
  voiceExemplars: VoiceExemplar[];
  lastPulseTrace: ChatPulseTrace;
  /** Last-turn RAG debug trace (retrieved + extracted) for the chat inspector. */
  lastMemoryTrace: ChatMemoryTrace;
  /** Read-only chat clock (the only time model) — the clock card + plan salience read it. */
  clockMinutes: number;
  /** The story-calendar anchor — the clock card formats + edits it. */
  calendarStart: CalendarStart;
  /** Auto scene-generation mode — the scenario modal's toggle. */
  sceneAuto: string;
  /** Scene-image model pick — the scene strip's save-on-select dropdown. */
  sceneModel: string;
  /** Accumulating scene memory (current place / time of day / known places) — for the state-tools/inspector view. */
  sceneMemory: ChatSceneMemory;
  /** Recurring named side characters — the Supporting Cast panel's data. */
  supportingCast: SupportingCast;
  /** Tracked plans & promises — the Plans panel's data (salience derived client-side vs clockMinutes). */
  plans: ChatPlan[];
  /** Memory-callback ring — for the state-tools/inspector view. */
  callbackHistory: CallbackEntry[];
  /** Emotional weather — the persistent feeling + bruise, for the strip/state tools. */
  feeling: ChatFeelingState;
  /** Selfie-send ring — for the state-tools/inspector view. */
  selfieHistory: SelfieEntry[];
  /** Runtime drives — panel shows open ones; tools show all. */
  drives: ChatDrive[];
  /** Narrative presence — the roster panel's toggle state. */
  presence: ChatPresence;
  /** Where an away member is, as a phrase — roster/tools view. */
  whereabouts: string;
  /** Exchanges since this character was last active (recency; for the roster/tools view). */
  quietExchanges: number;
  /**
   * False when this snapshot is a seed-on-read (no DB row yet) rather than a stored,
   * possibly-diverged chat. The UI uses it to preview the authored Starting Relationship
   * on a fresh chat without clobbering an ongoing chat's accumulated disposition.
   */
  persisted: boolean;
}

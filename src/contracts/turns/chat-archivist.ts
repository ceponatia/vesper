import { z } from "zod";
import { factDraftSchema } from "../facts/taxonomy";

/**
 * A single attribute mutation the archivist proposes. Applied through the
 * `overlaySourceMayChange(def.mutability, "narrative")` guard, so an inherent
 * trait (eye colour, species, gender) can never be rewritten. (Relocated from
 * the deleted session agent-results contract; the chat lane is its sole owner now.)
 */
export const attributeChangeSchema = z.object({
  participantName: z.string().min(1),
  attributeId: z.string().min(1),
  value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]),
  note: z.string().optional(),
});

export type AttributeChange = z.infer<typeof attributeChangeSchema>;
import { DRIVES_MAX, driveUpdateSchema } from "../personality/drives";
import { chatSceneProposalSchema } from "./chat-scene-memory";
import { chatCastProposalSchema } from "./chat-supporting-cast";
import { chatPlanProposalSchema } from "./chat-plans";
import {
  garmentMutationLaneSchema,
  garmentOperationProposalListSchema,
  garmentOperationTraceSchema,
} from "./chat-garment-ops";
import { chatEnvironmentProposalSchema, surfaceWetnessProposalListSchema } from "./chat-surface-ops";

/**
 * The character-chat extraction contract. Historically ONE "archivist-lite" agent call
 * (character-chat-primary.spec.md §2) emitting every field below; since
 * chat-agent-improvements.plan.md (slice 1b) the same shape is produced by THREE focused
 * legs run in parallel in the same post-flush slot — the memory scribe, the continuity
 * tracker, and the character tracker (`prompts/chat-extractors.ts`) — merged back into
 * this one aggregate by `mergeChatExtractions` so every downstream fold is unchanged.
 * The aggregate stays the contract; the legs are a prompt-side composition detail.
 *
 * Where the pulse tracks disposition (playerAct + mindNote), the extraction condenses the
 * exchange into long-term memory — the RAG half chat previously lacked:
 *
 * - "episodeSummary": a 1–3 sentence past-tense summary of what just happened, embedded
 *   and recalled by similarity across the summary horizon (mirrors the session archivist).
 * - "facts": durable `FactDraft[]` (declarative knowledge about the character / player /
 *   relationship), inserted through the standard `addFacts` supersedence path.
 * - "memoryQueries": 0–3 short retrieval queries anticipating what the NEXT turn should
 *   recall (mirrors the session director's `memoryQueries`); persisted on the chat state
 *   and consumed at the next prompt build.
 * - "attributeChanges": rare LASTING physical changes (a haircut, a dye job, a new tattoo)
 *   in the shared simulant shape (§3, D3), applied through the inherent-trait guard. Folded
 *   into this leg rather than a separate proposer call — attribute changes are rare and the
 *   archivist already extracts durable change (spec §2 "fewest model calls").
 *
 * Fully `.default()`/`.catch()`ed so a parsed-empty object IS the degraded fallback
 * (docs/resilience.md §3) — a failed extraction degrades to the summary+window path with
 * a diagnostic, never a failed reply.
 */

/** Cap on facts extracted per exchange (a chat turn is small; keep the write cheap). */
export const CHAT_ARCHIVIST_MAX_FACTS = 6;
/** Cap on memory queries carried to the next turn. */
export const CHAT_ARCHIVIST_MAX_QUERIES = 3;
/** Cap on open loops (character-chat-standalone.spec.md §6.2) — a short list stays a pull, not a backlog. */
export const CHAT_ARCHIVIST_MAX_OPEN_LOOPS = 3;
/** Cap on milestone-gated developable-trait nudges per exchange (character-fidelity slice 10) — rare, one or two at most. */
export const CHAT_ARCHIVIST_MAX_TRAIT_SHIFTS = 2;
/** Cap on garment-level add/remove proposals per exchange (chat-wardrobe-parity rung 2) — a beat swaps a piece or two, not a rack. */
export const CHAT_ARCHIVIST_MAX_WORN_CHANGES = 4;

/**
 * A milestone-gated developable-trait nudge (character-fidelity slice 10): the
 * archivist names a DEVELOPABLE trait that meaningfully and durably shifted this
 * exchange and its DIRECTION — never a magnitude. The deterministic fold clamps it
 * to one band step from the AUTHORED value and only applies it when a relationship
 * milestone actually landed, so change stays bounded, visible, and rollback-safe.
 */
export const traitShiftSchema = z.object({
  /** The trait id or the label the prompt listed (the fold resolves it against the registry). */
  trait: z.string().trim().min(1),
  direction: z.enum(["up", "down"]).catch("up"),
});
export type TraitShift = z.infer<typeof traitShiftSchema>;

export const chatArchivistSchema = z.object({
  episodeSummary: z.string().catch("").default(""),
  facts: z
    .array(factDraftSchema)
    .catch([])
    .default([])
    .transform((facts) => facts.slice(0, CHAT_ARCHIVIST_MAX_FACTS)),
  memoryQueries: z
    .array(z.string().trim().min(1))
    .catch([])
    .default([])
    .transform((queries) => queries.slice(0, CHAT_ARCHIVIST_MAX_QUERIES)),
  attributeChanges: z.array(attributeChangeSchema).catch([]).default([]),
  /**
   * The character's unfinished business (spec §6.2): the FULL list each exchange —
   * still-open items carried, resolved ones dropped, new ones added — so stale loops
   * fall off naturally without a separate resolution signal. Rendered as the
   * "Unfinished business" state line and read by "has something to say" (§8.4).
   */
  openLoops: z
    .array(z.string().trim().min(1))
    .catch([])
    .default([])
    .transform((loops) => loops.slice(0, CHAT_ARCHIVIST_MAX_OPEN_LOOPS)),
  /**
   * Optional scene reconciliation (chat scene memory): ONLY what the fiction actually
   * established this exchange — a current-place confirmation, a time-of-day hint, and new
   * place details/connections. Lenient (a bad proposal parses to an empty object and
   * merges as a no-op via `mergeSceneMemory`), so it never fails the turn.
   */
  scene: chatSceneProposalSchema,
  /**
   * The scene's WEATHER and enclosure (body-attribute-affordances slice 4) — the
   * chat lane's authoritative wind/precipitation owner, which the audit found
   * missing entirely ("may appear in narration … but has no normalized current-cut
   * force read"). A PARTIAL patch: absent keys mean "unchanged", so an ordinary
   * indoor exchange returns `{}` and the standing environment stands. Folded by
   * `applyEnvironmentProposal` onto `ChatScenario.environment` — chat-wide, like
   * `scene`, and rolled back with it.
   *
   * Deliberately separate from `scene`: that field records DURABLE places and
   * their fixtures, and weather is neither (its own instruction says so).
   */
  environment: chatEnvironmentProposalSchema,
  /**
   * Body-surface wetness changes (body-attribute-affordances slice 4): how much
   * wetter or drier a tracked body surface got THIS exchange, and why. The other
   * half of the input the hair domain had no owner for.
   *
   * Semantic, never numeric — a direction plus a coarse degree, mapped onto fixed
   * point by `SURFACE_WETNESS_DEGREE_DELTA`. Item-lenient, capped, and an unowned
   * location drops with `chat_surface.location_unknown` rather than minting state
   * nothing reads. `[]` is the overwhelming common case.
   */
  surfaceWetness: surfaceWetnessProposalListSchema,
  /**
   * **Grounded wardrobe operations** (clothing-state-graph.plan.md slice 5) — the
   * field that demotes `outfit` / `playerOutfit` below to a degraded legacy bridge.
   *
   * The continuity prompt enumerates the exchange's in-scope garment and part
   * HANDLES (`contracts/items/garment-handles.ts`); this field carries semantic
   * operations back over exactly those handles — "the left sleeve is rolled
   * substantially", never `roll: 0.73`, and never a garment name to fuzzy-match.
   * `applyGarmentProposals` maps them onto the typed `GarmentOperation` union in
   * fiction order, dropping any unresolvable handle with a stable
   * `garment_op.*` diagnostic (audit OQ7).
   *
   * The field only ARMS when the chat actually has modelled garments to address,
   * and it is mutually exclusive with the free-text grammar below
   * (`garmentMutationLane`) — one exchange never runs both mutation paths.
   * `[]` is the common no-clothing-change case.
   */
  garmentOperations: garmentOperationProposalListSchema,
  /**
   * Optional outfit change (chat-scene-fidelity.plan.md slice 1; structured worn state —
   * chat-wardrobe-parity.plan.md). **Demoted to the legacy bridge by
   * `garmentOperations` above** (clothing-state-graph slice 5): it still runs, and
   * runs unchanged, for a chat whose wardrobe is not modelled yet, an older cached
   * prompt, or a model that returned the old grammar — recorded with
   * `chat_garments.legacy_outfit_bridge` so its use stays observable.
   *
   * Two grammars, both optional and lenient:
   *
   * - `description` — a WHOLE-outfit swap: the complete current look (never a delta). When
   *   it names an authored outfit preset ("her work clothes" → the "Work" preset) the fold
   *   seeds the structured worn list from that preset (rung 1); otherwise it lands as the
   *   free-text overlay/replacement. `exposed` = intimate areas bared (free-text path only —
   *   the structured path computes exposure from coverage).
   * - `removed` / `added` — garment-LEVEL deltas (rung 2): individual pieces the fiction took
   *   off or put on this exchange ("she slips off her jacket" → `removed: ["her jacket"]`).
   *   Resolved against the worn items / wardrobe pool by `applyWornGarmentChanges`; an
   *   unmatched addition becomes free-text overlay, an unmatched removal skips (diagnostic).
   *
   * An empty proposal (`{}`) is the no-change no-op (the common case), so a bad value never
   * fails the turn. Consumed by `finalizeChatState`; drives the narrator's wearing-line, the
   * computed exposure, and the scene image's authoritative outfit.
   */
  outfit: z
    .object({
      // Uncapped by owner preference (2026-07-12): outfits list many garments and
      // truncation cut items off; `.catch("")` still keeps a bad value from failing the turn.
      description: z
        .string()
        .catch("")
        .default("")
        .transform((s) => s.trim()),
      exposed: z.boolean().catch(false).default(false),
      removed: z
        .array(z.string().trim().min(1))
        .catch([])
        .default([])
        .transform((g) => g.slice(0, CHAT_ARCHIVIST_MAX_WORN_CHANGES)),
      added: z
        .array(z.string().trim().min(1))
        .catch([])
        .default([])
        .transform((g) => g.slice(0, CHAT_ARCHIVIST_MAX_WORN_CHANGES)),
    })
    .catch({ description: "", exposed: false, removed: [], added: [] })
    .default({ description: "", exposed: false, removed: [], added: [] }),
  /**
   * The same, for the **PLAYER's** clothing (persona-library.plan.md slice 8).
   *
   * ONE field covers both directions, because the archivist reads the whole exchange —
   * the player's own line ("I pull my shirt off") and the reply ("she tugs your shirt
   * over your head") are the same event to it, and both must move the same state.
   *
   * Deliberately **no `exposed`**: the player's wardrobe is structured-only, so exposure
   * is always computed from worn coverage. A manual flag here would be a hole through
   * the scene-image gate that decides whether the viewer's anatomy renders.
   *
   * Resolved against the PERSONA's wardrobe by `applyWornGarmentChanges` — the same pure
   * reducer the character side uses, which is already generic over `{wornIds, worn, pool}`
   * and knows nothing about characters. `{}` is the no-change no-op (the common case).
   */
  playerOutfit: z
    .object({
      /** A WHOLE-outfit swap for the player — the complete current look, never a delta. */
      description: z
        .string()
        .catch("")
        .default("")
        .transform((s) => s.trim()),
      removed: z
        .array(z.string().trim().min(1))
        .catch([])
        .default([])
        .transform((g) => g.slice(0, CHAT_ARCHIVIST_MAX_WORN_CHANGES)),
      added: z
        .array(z.string().trim().min(1))
        .catch([])
        .default([])
        .transform((g) => g.slice(0, CHAT_ARCHIVIST_MAX_WORN_CHANGES)),
    })
    .catch({ description: "", removed: [], added: [] })
    .default({ description: "", removed: [], added: [] }),
  /**
   * Drive updates (character-drives.plan.md): progress/reveal/resolution on the
   * character's EXISTING drives (matched by `want` text — unmatched entries drop).
   * `revealed` = the character spoke a secret drive aloud to the player THIS
   * exchange (the `secret_shared` milestone source). Lenient; [] = no movement.
   */
  driveUpdates: z
    .array(driveUpdateSchema)
    .catch([])
    .default([])
    .transform((u) => u.slice(0, DRIVES_MAX)),
  /**
   * Presence transitions the fiction actually played this exchange
   * (multi-character-chat.plan.md slice 3 — the archivist's confirming half of
   * activity tracking): a roster character who ENTERED the player's scene or
   * LEFT it, by name. Only emitted for multi-character conversations (the
   * prompt instruction renders only with a roster) and only for real
   * transitions — [] is the common no-change case. Lenient; unmatched names
   * drop at the fold.
   */
  presence: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        presence: z.enum(["present", "away"]).catch("present"),
        /**
         * Where an AWAY departure went, as a phrase ("to her shift at the café") —
         * chat-offscreen-life §Whereabouts. Optional; only meaningful on "away".
         */
        where: z.string().trim().min(1).max(120).optional().catch(undefined),
      }),
    )
    .catch([])
    .default([])
    .transform((entries) => entries.slice(0, 4)),
  /**
   * Supporting-cast proposals (chat-supporting-cast.plan.md): recurring NAMED side
   * characters — not roster members, not the player — the exchange introduced or
   * established durable texture about. Merged via `mergeSupportingCast` (upsert by
   * name, details accrete, relation fills only when empty, roster/player names
   * excluded). Lenient; [] is the common no-new-people case.
   */
  cast: chatCastProposalSchema,
  /**
   * Plans & promises (chat-plans-promises.plan.md): commitments the fiction STRUCK,
   * CHANGED, or CANCELED this exchange — a concrete who + roughly-when commitment ("come
   * over Friday", "dinner at the pier tonight"). Merged via `mergeChatPlans` (upsert by
   * normalized `what`, `when` resolved against the clock, caps). The archivist may mark a
   * plan `kept`/`canceled` but NEVER `missed` (deterministic). A concrete commitment files
   * here; `openLoops` keeps only fuzzy unfinished business — never both for one beat.
   * Lenient; [] is the common no-new-commitment case.
   */
  plans: chatPlanProposalSchema,
  /**
   * Voice-exemplar pick (character-fidelity slice 8): ONE distinctly in-voice line
   * from the character's reply this exchange — verbatim — worth keeping past the
   * events-only summary horizon as a "How you sound" few-shot. "" when nothing this
   * exchange was distinctly in-voice (the common case). Length-capped at the fold.
   */
  voiceExemplar: z.string().catch("").default(""),
  /**
   * Character-consistency check (character-fidelity slice 9): a SHORT corrective note
   * when the reply broke character — voice, disposition, or age register (e.g. "spoke
   * like a therapist, not a 15-year-old — loosen the diction"). "" when the reply held
   * character (the overwhelming default). The fold stores it on the memory trace so the
   * NEXT turn renders a one-turn corrective tail note; absent/unparseable ⇒ no note.
   */
  characterSlip: z.string().catch("").default(""),
  /**
   * Developable-trait nudges (character-fidelity slice 10): rare direction-only shifts
   * on the character's DEVELOPABLE traits — applied only when a relationship milestone
   * landed this exchange, clamped one band from the authored value. [] is the norm.
   */
  traitShifts: z
    .array(traitShiftSchema)
    .catch([])
    .default([])
    .transform((s) => s.slice(0, CHAT_ARCHIVIST_MAX_TRAIT_SHIFTS)),
});

export type ChatArchivist = z.infer<typeof chatArchivistSchema>;

/** Degraded default: nothing extracted — the turn keeps its reply and the summary+window memory. */
export function degradedChatArchivist(): ChatArchivist {
  return {
    episodeSummary: "",
    facts: [],
    memoryQueries: [],
    attributeChanges: [],
    openLoops: [],
    scene: { places: [] },
    environment: {},
    surfaceWetness: [],
    garmentOperations: [],
    outfit: { description: "", exposed: false, removed: [], added: [] },
    playerOutfit: { description: "", removed: [], added: [] },
    driveUpdates: [],
    presence: [],
    cast: [],
    plans: [],
    voiceExemplar: "",
    characterSlip: "",
    traitShifts: [],
  };
}

/**
 * The extraction LEGS (chat-agent-improvements.plan.md slice 1b). One overloaded
 * 13-field extractor became three focused ones, run in parallel in the same post-flush
 * slot — so perceived latency is unchanged while each leg holds 3–5 assignments instead
 * of thirteen. Each leg's shape is a `pick` of the aggregate above, so the field
 * definitions, caps, and degraded defaults have exactly ONE source and every fold in
 * `finalizeChatState` keeps consuming the merged aggregate.
 *
 * - **memory scribe** — what happened + what to remember + what to look up next turn.
 * - **continuity tracker** — the state of the world the fiction just moved: scene,
 *   wardrobe, lasting appearance changes, who is present, recurring side characters.
 * - **character tracker** — the character's own thread: unfinished business, drives,
 *   how they sounded, whether they held character, and bounded personality movement.
 */
export const chatMemoryScribeSchema = chatArchivistSchema.pick({
  episodeSummary: true,
  facts: true,
  memoryQueries: true,
});
export type ChatMemoryScribe = z.infer<typeof chatMemoryScribeSchema>;

export const chatContinuitySchema = chatArchivistSchema.pick({
  scene: true,
  // Weather and body surfaces are scene-level state (one sky, one soaking), so
  // they ride the SHARED continuity leg for the same reason `scene` does — never
  // the per-member personal pass, where several members would each propose a
  // different sky.
  environment: true,
  surfaceWetness: true,
  // The grounded wardrobe lane (clothing-state-graph slice 5) rides the SHARED
  // continuity leg for the same reason `playerOutfit` does: the garment store is
  // chat-wide, and several members proposing operations over one store would
  // fight each other.
  garmentOperations: true,
  outfit: true,
  // The player's wardrobe is chat-wide, so it rides the SHARED continuity leg and is
  // deliberately absent from `chatPersonalNotesSchema` below — that pass runs once per
  // ensemble member, and several members proposing changes to the one player's clothes
  // would fight each other.
  playerOutfit: true,
  attributeChanges: true,
  presence: true,
  cast: true,
});
export type ChatContinuity = z.infer<typeof chatContinuitySchema>;

export const chatCharacterNotesSchema = chatArchivistSchema.pick({
  openLoops: true,
  driveUpdates: true,
  plans: true,
  voiceExemplar: true,
  characterSlip: true,
  traitShifts: true,
});
export type ChatCharacterNotes = z.infer<typeof chatCharacterNotesSchema>;

/**
 * The per-member personal pass (multi-character-chat.followups.md ruling 10): in an
 * ensemble, the shared legs keep the scene-level reads while each present member gets
 * this small focused extraction — the four PERSONAL fields folded into their own state
 * row. A `pick` of the aggregate like the legs above (it was a hand-duplicated copy of
 * the same four field definitions until chat-agent-improvements slice 1a). The classic
 * 1-on-1 never runs it (the shared legs already cover the primary).
 */
export const chatPersonalNotesSchema = chatArchivistSchema.pick({
  openLoops: true,
  attributeChanges: true,
  outfit: true,
  driveUpdates: true,
});

export type ChatPersonalNotes = z.infer<typeof chatPersonalNotesSchema>;

/** Degraded default: nothing personal extracted — the member keeps their prior fields. */
export function degradedChatPersonalNotes(): ChatPersonalNotes {
  const { openLoops, attributeChanges, outfit, driveUpdates } = degradedChatArchivist();
  return { openLoops, attributeChanges, outfit, driveUpdates };
}

/**
 * Which legs degraded this exchange. The folds distinguish "the model said nothing" from
 * "we never heard back" PER LEG: a degraded character leg keeps the standing open loops
 * rather than wiping them; a degraded scribe drops stale memory queries and flags the
 * memory trace. Travels beside the merged aggregate (`ChatExtractionResult`).
 */
export interface ChatExtractionLegs {
  memory: boolean;
  continuity: boolean;
  character: boolean;
}

/**
 * Merge the three legs' results back into the aggregate every fold consumes. A `null`
 * leg (demo / timeout / parse failure) contributes its degraded defaults — so one failed
 * leg costs only its own fields and never the others' (the whole point of the split).
 * Per-leg degradation flags travel separately (`ChatExtractionResult`) because the folds
 * distinguish "the model said nothing" from "we never heard back": open loops are kept on
 * a degraded character leg rather than wiped, memory queries are dropped on a degraded
 * scribe rather than left stale. PURE.
 */
export function mergeChatExtractions(legs: {
  memory: ChatMemoryScribe | null;
  continuity: ChatContinuity | null;
  character: ChatCharacterNotes | null;
}): ChatArchivist {
  const empty = degradedChatArchivist();
  return {
    ...empty,
    ...(legs.memory ?? {}),
    ...(legs.continuity ?? {}),
    ...(legs.character ?? {}),
  };
}

/**
 * Last-turn memory debug trace persisted beside the chat state for the dev inspector
 * (character-chat-primary.spec.md §5): what RAG retrieved this turn (facts + episodes) and
 * what the archivist extracted (episode summary, fact count, queries, attribute changes).
 * Parsed defensively from the jsonb column, `.default()`ed so an old/empty row reads clean.
 */
export const chatMemoryTraceSchema = z.object({
  /** Fact texts injected into the prompt this turn. */
  retrievedFacts: z.array(z.string()).catch([]).default([]),
  /** Episode summaries recalled this turn. */
  retrievedEpisodes: z.array(z.string()).catch([]).default([]),
  /** The episode summary the archivist wrote (""=nothing memorable / degraded). */
  episodeSummary: z.string().catch("").default(""),
  /** How many durable facts were added this turn. */
  factsAdded: z.number().int().catch(0).default(0),
  /** Queries carried to the next turn's recall. */
  memoryQueries: z.array(z.string()).catch([]).default([]),
  /** Applied attribute overlays this turn, rendered "id=value". */
  attributeChanges: z.array(z.string()).catch([]).default([]),
  /**
   * Per-hit retrieval detail (spec §6.3 #2 — per-source attribution): what each
   * retrieved fact/episode scored and WHICH queries surfaced it (RRF fusion inputs).
   * Old rows without it parse to [] (texts-only trace stays readable).
   */
  retrievedDetail: z
    .array(
      z.object({
        kind: z.enum(["fact", "episode"]).catch("fact"),
        id: z.string().catch(""),
        text: z.string().catch(""),
        score: z.number().catch(0),
        pinned: z.boolean().catch(false),
        sources: z.array(z.string()).catch([]),
      }),
    )
    .catch([])
    .default([]),
  /**
   * Per-exchange garment-operation trace (clothing-state-graph slice 5): every
   * proposal the continuity leg returned, the instance its handle resolved to, and
   * whether it applied, changed nothing, or was rejected under which
   * `garment_op.*` code. Riding the memory trace puts it in the admin inspector's
   * existing JSON view AND inside the rollback snapshot, so a retake discards the
   * record of the operations it discarded. Old rows parse to [].
   */
  garmentOperations: garmentOperationTraceSchema,
  /** Which wardrobe-mutation path ran this exchange (`operations` / `legacy` / `none`). */
  garmentLane: garmentMutationLaneSchema.catch("none").default("none"),
  /** True when the archivist leg degraded (demo / timeout / parse) — no memory written. */
  degraded: z.boolean().catch(false).default(false),
  /**
   * Character-consistency corrective (character-fidelity slice 9): the archivist's
   * one-line "the reply broke character" note for THIS exchange, rendered as a
   * one-turn corrective tail note on the NEXT turn. "" when the reply held character.
   * Lives on the trace (no new column) so it rolls back with the pre-exchange
   * snapshot and reads degradation-safe (`parseOr` at the load boundary ⇒ "").
   */
  characterSlip: z.string().catch("").default(""),
});

export type ChatMemoryTrace = z.infer<typeof chatMemoryTraceSchema>;

/** One retrieved-hit detail row (spec §6.3 #2 per-source attribution). */
export type RetrievedMemoryDetail = ChatMemoryTrace["retrievedDetail"][number];

export function emptyChatMemoryTrace(): ChatMemoryTrace {
  return chatMemoryTraceSchema.parse({});
}

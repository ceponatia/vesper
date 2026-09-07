import type { ChatState, ChatScenario } from "./types";
import type {
  CharacterProfile,
  PersonaProfile,
  RetrievedMemoryDetail,
  GarmentCueState,
  AffordanceCueState,
  EffectiveCoverageRead,
  BodyMarkProposal,
  DiagnosticSink,
} from "@/contracts";
import type { ChatSurfaceTransferInput } from "./surface-transfer";

export interface FinalizeChatStateInput {
  chatId: string;
  characterId: string;
  /** Chat owner — loads worn/pool items when the archivist proposes garment-level changes. */
  ownerId: string;
  /** The participant's memory group. */
  memoryGroupId: string;
  /** Provenance anchor: the assistant message row this exchange produced/updated. */
  assistantMessageId: string;
  /**
   * The STORED state as it stood before this exchange (null on a first exchange) —
   * persisted as the row's rollback snapshot so "another take" can undo the
   * exchange's drift + fan-out effects.
   */
  preExchangeState: ChatState | null;
  /**
   * Skip the reaction pulse (a "go on" continue beat has no player act to react
   * to); the archivist still runs — continued narrative is worth remembering.
   */
  skipPulse?: boolean;
  /**
   * Run the pulse OPENER-scoped: an initiative
   * opener with the selfie license armed needs the pulse's `sentPhoto` read (and
   * takes the mindNote refresh), but none of the curve's moves. Only meaningful
   * when `skipPulse` is false.
   */
  pulseScope?: "full" | "opener";
  promptMessageId: string;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  /**
   * The player's persona sheet — the wardrobe pool the
   * archivist's `playerOutfit` deltas resolve against. Absent when the chat resolved to
   * the bare account name (no persona), in which case the player has no clothes to move
   * and the fold is a no-op.
   */
  playerPersona?: PersonaProfile;
  driftedState: ChatState;
  now: Date;
  exchange: { player: string; assistant: string };
  /**
   * The rolling summary as it stood for this exchange: the memory scribe reads
   * its durable ledger so a pronoun-heavy beat files
   * a fact naming the person instead of a dangling referent. Scribe-only — the other legs
   * judge the exchange itself. Absent on an early chat ⇒ no block.
   */
  priorSummary?: string;
  /** What RAG retrieved for THIS turn (from the route's pre-turn recall), for the debug trace. */
  retrieved?: { facts: string[]; episodes: string[]; detail?: RetrievedMemoryDetail[] };
  /**
   * This turn's selfie arming: the player asked, and/or the
   * unprompted-offer gates held. The pulse's `sentPhoto` read only queues a render
   * when one of these armed it — a hallucinated "sending you a pic" on an unarmed
   * turn stays fiction.
   */
  selfie?: { requested: boolean; offerEligible: boolean };
  /**
   * The roster with live presence — arms the archivist's presence-transition
   * field. Absent/single ⇒ 1-on-1, unchanged.
   */
  roster?: readonly { name: string; presence: "present" | "away" }[];
  /**
   * Present ensemble members' memory scopes beyond the primary's — each
   * character's memory is their own, so the ONE extraction files to every
   * present witness's own group. Deduped against the primary's group here.
   */
  extraMemoryWrites?: readonly { groupId: string; characterId: string }[];
  /**
   * The chat-wide scenario, ALREADY ticked/movement-switched for this exchange:
   * finalize merges the archivist's scene proposal onto it, clears the one-shot
   * skip note, and persists it beside the state.
   */
  scenario: ChatScenario;
  /** The scenario as stored before this exchange — the rollback anchor's other half. */
  preExchangeScenario: ChatScenario | null;
  /**
   * The garment cue memory this exchange's prompt surfaced: repeat keys + the
   * bands they were reported in + last-changed stamps.
   * Persisted onto the store so it rides ONE rollback anchor with the garments it
   * describes — a retake restores mention history and wardrobe together or not at
   * all. Absent (the `CHAT_GARMENT_CUES` default) ⇒ the store's memory is untouched.
   */
  garmentCueState?: GarmentCueState;
  /**
   * The AFFORDANCE cue memory this exchange's prompt surfaced: repeat keys, the
   * band each was last
   * reported in, and the story time each band moved. Persisted onto the SCENARIO
   * beside `environment`, so it rides `pre_exchange_scenario` with the state the
   * read was taken from — a retake restores both or neither, which is what makes
   * the rebuilt read byte-identical. Absent (the `CHAT_AFFORDANCE_CUES` default)
   * ⇒ the stored memory rides through untouched, never cleared.
   */
  affordanceCueState?: AffordanceCueState;
  /**
   * The CAPTURED effective-coverage read this exchange derived, keyed by garment
   * actor handle (the owner ruling: "effective coverage is captured, not
   * reconstructed").
   *
   * Merged onto the garment store rather than stored beside it, so one JSONB
   * value — one rollback anchor — carries the garments AND the derived answer
   * about what they still conceal. Absent ⇒ the prior capture rides through.
   */
  affordanceCoverage?: Readonly<Record<string, EffectiveCoverageRead>>;
  /**
   * The contact-effect proposals this exchange's DURABLY committed contact
   * derived (`CHAT_CONTACT_EFFECTS`, default off).
   * The body-surface owner transaction validates and commits them into the
   * primary's surface state HERE — after the wetness fold, inside the same
   * guarded state write — so a committed mark rides one rollback anchor with
   * the surface it lives on, and a retake restores or removes it with the cut.
   * Absent (the default) ⇒ the surface fold's result persists untouched.
   */
  contactMarkProposals?: readonly BodyMarkProposal[];
  /**
   * This exchange's conserved surface transfer: the PROPOSALS, not a
   * settlement. The owner transaction runs inside finalize,
   * on the surface the surrounding folds just produced.
   *
   * That is deliberate and it is the whole reason this is a proposal input. A
   * caller cannot settle a transfer itself, because the surface it would settle
   * against does not exist outside this function: the wetness, deposit and
   * pressure-mark folds all run here, and a `source` computed before them would
   * either discard those folds when persisted or have to be merged back
   * afterwards — a merge with no correct answer, since both sides edit the same
   * deposit records. Computing the transfer here means the value that gets
   * debited is byte-for-byte the value that gets written.
   *
   * A COMMITTED transfer moves the settle's writes inside ONE database
   * transaction (`persistSurfaceTransferSettlement`), because the conservation
   * law spans two rows and cannot be proven across independent statements.
   * Absent — or present but committing nothing, which is every refusal and every
   * duplicate retry — ⇒ every write below runs exactly as it always has. That
   * is the whole of production today: transfer is fixture-only under the
   * conservation law's escape clause, so no live caller sets this and the hot
   * settle path is untouched (owner ruling 2026-08-26).
   */
  surfaceTransfer?: ChatSurfaceTransferInput;
  sink?: DiagnosticSink;
}

export interface FinalizeChatStateResult {
  /** True when this exchange landed a stage crossing or strong reaction (slice 9 "auto at big moments"). */
  bigMoment: boolean;
  /** True when the reply sent a selfie (pulse-read + gate-armed) — the route queues the render. */
  selfieSend: boolean;
  /** The archivist's confirmed presence transitions (ensemble only; [] otherwise). `where` = an away departure's destination phrase. */
  presenceChanges: readonly { name: string; presence: "present" | "away"; where?: string }[];
  /**
   * Did this exchange's folds actually rewrite the PRIMARY character's / the
   * PLAYER's worn list? Reported because only the writer knows: the store carries
   * the final clothes and nothing about when they changed, and the reply-scene
   * contact leg refuses to date a touch against a wardrobe that moved during the
   * same reply.
   *
   * The comparison is the PROJECTION's, not the proposal's — the same rule the
   * ensemble members' `memberWornChanges` uses — so the free-text outfit fold,
   * the typed garment operations, and the lazy materialization that first models
   * an actor all report alike. Materialization reporting a change is a
   * conservative false positive by design: it costs one reply's contact start on
   * the exchange that first models a wardrobe, and the alternative is a material
   * claim nobody can date.
   */
  wardrobeChanged: { character: boolean; player: boolean };
}

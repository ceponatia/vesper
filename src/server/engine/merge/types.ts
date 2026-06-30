import type { DiagnosticSink } from "@/contracts/diagnostics";
import type { MeterDefinition } from "@/contracts/meters/registry";
import type { NextTurnBrief } from "@/contracts/state/brief";
import type { CommsLink, SessionRuntime, StagedIntent, StoryThread } from "@/contracts/state/session-runtime";
import type { AgentResults, ContinuityResult, SimulantResult } from "@/contracts/turns/agent-results";
import type { IntentBrief } from "@/contracts/turns/intent-brief";
import type { TurnAuthor } from "@/contracts/turns/stream";
import type { FactDraftInput } from "../../memory";
import type { BundlePlace, SessionBundle } from "../bundle";
import type { ItemAction } from "./grounding";
import type { WorkingItem, WorkingParticipant, WorkingState } from "./working-state";

/**
 * Shared type hub for the merge reducer (merge-decomposition.spec.md §3.2): the
 * public plan/apply contracts plus the per-turn result shapes the phases produce
 * and the orchestrator threads. Kept a leaf (imports only contracts + the sibling
 * working-state/grounding) so plan.ts, apply.ts, and every phase can depend on it
 * without an import cycle.
 */

export interface MergeTurn {
  id: string;
  number: number;
  author: TurnAuthor;
  input: string;
  narration: string;
  /** Companion-authored turns: the speaking NPC (counts as a targeted interaction). */
  speakerParticipantId?: string | null;
  /**
   * The persisted intake brief. Its `socialActs` drive the deterministic
   * reaction affinity (personality-and-state.spec.md §6). Absent ⇒ no reaction.
   */
  intentBrief?: IntentBrief;
}

export type MergeMode = "post_turn" | "reconcile";

export interface GroundingDeps {
  /** Library fuzzy match for an item name (maps to instances via itemId). */
  resolveLibraryItem?: (name: string) => Promise<{ id: string } | null>;
  /** Library fuzzy match for a location name (maps via session_locations.location_id). */
  resolveLibraryLocation?: (name: string) => Promise<{ id: string } | null>;
  /**
   * Batch-embed thread texts for semantic dedup of proposals (docs/story-threads.md).
   * Injected so the planner stays testable; absent ⇒ exact-title dedup only.
   */
  embedThreadTexts?: (texts: string[]) => Promise<number[][]>;
}

export interface PlanInput {
  bundle: SessionBundle;
  turn: MergeTurn;
  results: AgentResults;
  sink: DiagnosticSink;
  mode?: MergeMode;
  deps?: GroundingDeps;
  /** When set, lore-unlock near-misses are logged as events (impure). */
  logMissesForSessionId?: string;
}

export interface MergePlan {
  /** Minutes applied by this merge (0 in reconcile mode). */
  minutes: number;
  /** Dominant time component ("travel", "shower", "scene", "reconcile") — for the clock-delta UI. */
  minutesCause: string;
  /** Final session clock. */
  clockMinutes: number;
  participants: WorkingParticipant[];
  items: WorkingItem[];
  /** Ids of items whose row changed (placement or state). */
  touchedItemIds: string[];
  factDrafts: FactDraftInput[];
  episodeSummary: string;
  syntheticEpisode: boolean;
  touchedThreadIds: string[];
  runtime: SessionRuntime;
  brief: NextTurnBrief;
  droppedEvents: string[];
  affinityUpdates: AffinityUpdate[];
  /** Time-driven affinity decay applied by this merge (post_turn only; always empty in reconcile). */
  affinityDecay: AffinityDecayEdge[];
  /**
   * Participant ids who perceived this turn (presence-spec §witness sets): the
   * placed player plus every co-located NPC whose attention let them perceive a
   * salient action this turn. One set per turn, stamped on every fact draft.
   */
  witnessedBy: string[];
  /**
   * Comms links opened/closed this turn, for the events log (post_turn only;
   * always empty in reconcile). The persisted link state already lives in
   * `runtime.commsLinks`; this is just the per-turn audit trail.
   */
  commsChanges: CommsChange[];
  /**
   * The turn's one-shot avatar reaction beat (avatar-3d), written to
   * `agentResults.reaction` by `apply.ts`; absent ⇒ no beat. Post_turn only.
   */
  reactionBeat?: ReactionBeat;
}

export interface AffinityUpdate {
  /** Edge owner — always an NPC (decision 41). */
  fromParticipantId: string;
  toParticipantId: string;
  kind: "feeling" | "perceived";
  delta: number;
  reason?: string;
}

/**
 * A one-shot **reaction beat** for the avatar (avatar-3d.plan.md §"In-session beat"): the
 * player's primary social act this turn, as the target NPC took it. Covers **both** carded
 * reactions (the curve verdict) **and** un-carded touches (synthesized from welcome-ness — the
 * romance beats the pre-narration evaluator misses). Surfaced via `turns.agentResults.reaction`
 * so the standing avatar can pulse it once; never affects state (cosmetic).
 */
export interface ReactionBeat {
  participantId: string;
  /** Interaction concept id (e.g. `flirt`, `kiss`) — refines the beat (blush vs nod). */
  concept: string;
  valence: "like" | "dislike";
  /** Evaluated magnitude (≥0): the curve's for a carded act, synthesized for a touch. */
  magnitude: number;
}

export interface ReactionAffinityResult {
  updates: AffinityUpdate[];
  /** Edge keys (from::to::kind) a reaction resolved for — suppress simulant updates here. */
  ownedEdgeKeys: Set<string>;
  /** Mood-meter nudge the reaction applies to the target NPC (spec §4); absent ⇒ none. */
  moodAdjustment?: { participantId: string; delta: number };
  /** Stress-meter nudge from an unwelcome/welcome touch (mood.spec §5); absent ⇒ none. */
  stressAdjustment?: { participantId: string; delta: number };
  /** One-shot avatar beat for the target NPC (carded or touch); absent ⇒ no beat. */
  beat?: ReactionBeat;
}

export interface CardBreachResult {
  /** Witness→player feeling deltas (the per-witness affinity fold). */
  updates: AffinityUpdate[];
  /** Edge keys these reactions own — suppress simulant updates there (like a reaction). */
  ownedEdgeKeys: Set<string>;
  /** Next-turn narrator directives, one per breach. */
  directives: string[];
}

export interface AffinityDecayEdge {
  fromParticipantId: string;
  toParticipantId: string;
  kind: "feeling" | "perceived";
  /** Value before decay. */
  previousValue: number;
  /** Value after decay — same stage by construction (decay never crosses a boundary). */
  value: number;
  /** Decay wanted to keep going but stopped at the stage's zero-side boundary. */
  clamped: boolean;
}

export interface AffinityDecayResult {
  edges: AffinityDecayEdge[];
  /** New runtime marker: seeded on first use, else advanced by the consumed whole weeks. */
  lastAffinityDecayAt: number;
}

export interface CommsChange {
  op: "open" | "close";
  kind: "call" | "text";
  withParticipantId: string;
}

export interface CommsPlanResult {
  /** The merged link list to persist to runtime.commsLinks. */
  links: CommsLink[];
  /** Per-turn opens/closes, for the events log. */
  changes: CommsChange[];
}

/**
 * The shared per-turn context threaded through every phase. Holds the read-only
 * inputs each phase needs (bundle/turn/results/sink/deps + the resolved
 * `defs`/`turnStartMinute` and the name→row resolver closures) plus the mutable
 * scratch one phase produces for a later phase to consume (clock outputs,
 * turn-start mood, the reaction/breach folds, the runtime-building pieces). The
 * *world copy* itself never lives here — it is owned by `WorkingState`, mutated
 * only through its methods. `buildMergePlan` reads `ctx` + `state` to assemble
 * the final `MergePlan`.
 */
export interface PhaseContext {
  // -- read-only inputs (set once in createPhaseContext) --
  readonly bundle: SessionBundle;
  readonly turn: MergeTurn;
  readonly results: AgentResults;
  readonly simulant: SimulantResult;
  readonly continuity: ContinuityResult;
  readonly mode: MergeMode;
  readonly reconcile: boolean;
  readonly sink: DiagnosticSink;
  readonly deps: GroundingDeps | undefined;
  readonly logMissesForSessionId: string | undefined;
  readonly defs: readonly MeterDefinition[];
  /** Turn-START minute-of-day — movement/rest resolve against the moment the player acts. */
  readonly turnStartMinute: number;
  readonly resolveLocation: (name: string) => Promise<BundlePlace | null>;
  readonly resolveItem: (
    name: string,
    action: ItemAction,
    actor: { id: string; locationId: string | null } | null,
  ) => Promise<WorkingItem | null>;

  // -- mutable scratch / outputs (filled by phases, in order) --
  playerTravelMinutes: number;
  minutes: number;
  minutesCause: string;
  clockMinutes: number;
  /** Turn-start mood per participant, captured before drift (reactions read it for μ). */
  moodAtTurnStart: Map<string, number>;
  /** Crossed-threshold hints per participant, captured before drift (brief diffs against them). */
  hintsBefore: Map<string, string[]>;
  reactionResult: ReactionAffinityResult | null;
  stagedIntents: StagedIntent[];
  factDrafts: FactDraftInput[];
  episodeSummary: string;
  syntheticEpisode: boolean;
  threads: StoryThread[];
  touchedThreadIds: string[];
  newlyUnlocked: string[];
  witnessedBy: string[];
  interacted: Set<string>;
  visitedLocationIds: string[];
  encounteredParticipantIds: string[];
  lastInteractedTurn: Record<string, number>;
  comms: CommsPlanResult;
  affinityDecay: AffinityDecayResult | null;
  thresholdHints: string[];
  breachResult: CardBreachResult;
  affinityUpdates: AffinityUpdate[];
  brief: NextTurnBrief;
}

export type Phase = (ctx: PhaseContext, state: WorkingState) => void | Promise<void>;

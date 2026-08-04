/**
 * Prompt-text tunables (docs/prompts.md §Style rules). Binding numeric engine
 * constants (history depth, fact cap, …) live in ../constants.ts; re-exported
 * here so prompt code has one import site for everything it renders.
 */
export { CHARACTER_CHAT_HISTORY_TURNS, EPISODE_WINDOW } from "../constants";

/**
 * Narration *shape profiles* (narrator-prompt-focus.plan.md §1.1) — the length /
 * focus guidance that opens the prose-style rules. A global dev/code A/B knob, not
 * a per-world field: instead of one hard-coded "3–5 paragraphs" floor (which made a
 * quiet "hi" manufacture errands and extra speakers to fill it), narration length
 * is a named profile, threaded through the builders as `narrationShape` so the eval
 * harness can sweep both in one process and both are snapshot-tested. The live
 * default is resolved by `narrationShapeId()`; authors tune richness through the
 * authored Style directives instead (decision 2).
 */
export type NarrationShapeId = "concise_immersive" | "aggressive_concise";

/** All shape ids — the validation vocabulary for the dev toggle + route. */
export const NARRATION_SHAPE_IDS = ["concise_immersive", "aggressive_concise"] as const;

/** Builder-level fallback when no `narrationShape` is threaded (tests / safety). The
 *  *runtime* per-lane resting defaults live in NARRATION_LANE_DEFAULTS below. */
export const DEFAULT_NARRATION_SHAPE: NarrationShapeId = "concise_immersive";

/**
 * Per-lane resting default shape profile (narrator-prompt-focus.plan.md decision 1,
 * re-ruled 2026-06-29). Run 2 of the behavioral eval
 * (narrator-prompt-focus.eval-results.md) found a per-model split the single global
 * default couldn't serve: the **session** narrator (Aion 2.0) prefers
 * `concise_immersive` (83% pairwise + best voice), while the **chat** default (GLM 5.2)
 * prefers `aggressive_concise` (71%). The live dev override still forces BOTH lanes when
 * set (the global A/B toggle); this is only the default the resolver falls through to.
 */
export type NarrationLane = "session" | "chat";
export const NARRATION_LANE_DEFAULTS: Record<NarrationLane, NarrationShapeId> = {
  session: "concise_immersive",
  chat: "aggressive_concise",
};

export const NARRATION_SHAPE_PROFILES: Record<NarrationShapeId, string> = {
  // Default: focus without losing the immersive register.
  concise_immersive:
    "Write one focused beat per turn. Match length to what the input calls for, never " +
    "padding to a target: a quiet or simple input gets a short reply; a normal scene beat " +
    "is usually a few rich paragraphs; expand further only when the moment earns it — a " +
    "first encounter, a room entry or scene transition, a consequence touching several " +
    "characters, or an explicit player ask. Keep the prose vivid. End on a natural " +
    "sentence; never trail off.",
  // Backup A/B variant — flip on to test a tighter feel.
  aggressive_concise:
    "Be brief and tightly scoped. Answer the player's input in as few sentences as it " +
    "honestly needs, then stop; expand into fuller description ONLY for a first encounter, " +
    "a scene transition, a multi-character consequence, or an explicit player ask. No " +
    "padding, no summary, no wrap-up. End on a natural sentence.",
};

// The live dev override (narrator-prompt-focus.plan.md §1.1 "Live dev toggle"): a
// server-side value flipped by the dev-only POST /api/dev/narration-shape route and
// read here by `narrationShapeId()`. undefined ⇒ no override (fall through to env /
// default). Dev-only and process-local — undefined in production (the route is 404
// there) and reset on a true restart, the intended experimentation surface. Kept on
// globalThis (var) so the override survives Next.js dev-server module reloads — the
// toggle exists for live prompt iteration, which is exactly what triggers HMR;
// without this, editing constants.ts / narrative.ts while A/B-ing would silently
// snap it back to the default. Same pattern as db/client.ts's pool + jobs.ts's runner.
declare global {
  // var declaration so the dev override survives Next.js dev-server module reloads
  var __vesperNarrationShape: NarrationShapeId | undefined;
}

/** Read the live dev override (null when unset). */
export function readDevNarrationShape(): NarrationShapeId | null {
  return globalThis.__vesperNarrationShape ?? null;
}

/** Set (or clear, with null) the live dev override. Dev-only caller. */
export function setDevNarrationShape(shape: NarrationShapeId | null): void {
  globalThis.__vesperNarrationShape = shape ?? undefined;
}

/**
 * The active narration shape for a lane. Resolution order: the live dev override
 * (global — forces both lanes when set) → the NARRATION_SHAPE env (headless / eval
 * default) → the per-lane resting default (NARRATION_LANE_DEFAULTS). Per-call callers
 * (tests, eval harness) pass an explicit shape to the builders and skip this.
 */
export function narrationShapeId(lane: NarrationLane): NarrationShapeId {
  const override = readDevNarrationShape() ?? process.env.NARRATION_SHAPE; // undefined in prod
  if (override === "concise_immersive" || override === "aggressive_concise") return override;
  return NARRATION_LANE_DEFAULTS[lane];
}

/**
 * The chat prompt LAYOUT switch (narrator-prompt-consolidation.plan.md slice 5) —
 * experimental, default-off. `system_tail` (today's layout): the volatile tail rides
 * the system prompt, ahead of the history in token order, so each turn's tail change
 * re-processes the whole history. `turn_context`: the session lane's shape — system =
 * stable prefix only; the tail + fenced current input ride a final user message
 * (`buildChatTurnMessage`), making system + history an append-only cached prefix.
 * Env-only (no dev route yet); flip the default only after the eval A/B.
 */
export type ChatPromptLayout = "system_tail" | "turn_context";
export function chatPromptLayout(): ChatPromptLayout {
  return process.env.CHAT_PROMPT_LAYOUT === "turn_context" ? "turn_context" : "system_tail";
}

/**
 * The GARMENT NARRATION switch (clothing-state-graph.plan.md slice 6) —
 * experimental, default-off, exactly like `CHAT_PROMPT_LAYOUT` above and for the
 * same reason: the slice carries a live-model tuning gate ("tune contradiction,
 * repetition, concrete-detail, and extraction accuracy before enabling by
 * default") and that eval spend is owner-gated.
 *
 * OFF (the default, and anything other than `on`) is today's behavior to the
 * byte: no authoritative wardrobe digest, no garment cue block, no garment notes
 * on the scene-image prompt. ON adds all three. Env-only, no dev route.
 *
 * Note what is NOT behind it: OQ8's pre/post look-key comparison ships either
 * way. That is a correctness fix — the enqueue was proposal-triggered, so a
 * structural wardrobe change could leave the `chat_look` anchor silently stale
 * (audit wrong-assumption 4) — not a prompt experiment.
 */
export function chatGarmentCuesEnabled(): boolean {
  return process.env.CHAT_GARMENT_CUES === "on";
}

/**
 * The AFFORDANCE NARRATION switch (body-attribute-affordances.plan.md slice 5) —
 * **default-off permanently: the trial closed 2026-07-29 and the flag PARKED OFF.**
 *
 * Slice 5 was explicitly a *trial* ("compare contradiction rate, repetition,
 * specificity, and prose naturalness with the current appearance path"). It ran:
 * one live round with no contradiction headroom, then a three-round rematch
 * campaign under a frozen protocol whose terminal state is two consecutive rounds
 * with a VALID induction gate in which the cue arm fails the decision rule. Both
 * valid rounds failed (the cue arm never reduced contradictions), so per the
 * pre-committed rule this flag parks OFF — see
 * `docs/developer-notes/body-attribute-affordances.trial.md` §Rematch log. This is
 * not "off until we get around to it": turning it on is a decision the campaign
 * already made, against.
 *
 * The narrator-facing policy is replaced, not retried, by
 * `docs/developer-notes/narrator-physical-guidance.plan.md` — constraints,
 * premise corrections and resolved action outcomes, with positive detail gated on
 * a committed state change behind its own separately-measured flag. The cue
 * renderer stays as a closed-experiment reference and as the eval harness's cue
 * arm (`src/server/engine/chat-affordance-cues.ts`).
 *
 * OFF (the default, and anything other than `on`) is today's behavior to the
 * byte: no affordance read is taken at all — no adapter call, no cue rendering,
 * no cue block on the narrator prompt — and `character_chats.affordance_cues`
 * rides through untouched rather than being cleared. ON adds exactly one block:
 * the ≤2 ranked, perception-safe, repeat-gated physical cues for this exchange,
 * plus the cue-memory write that makes the repeat gate work. Env-only, no dev route.
 *
 * Note what is NOT behind it: the slice-4 owners themselves. The environment and
 * body-surface extraction, their folds, and the rollback anchors all ship
 * unconditionally — they are authoritative state, not a prompt experiment, and the
 * cue memory has to roll back with them whether or not anything reads it.
 */
export function chatAffordanceCuesEnabled(): boolean {
  return process.env.CHAT_AFFORDANCE_CUES === "on";
}

/**
 * The CONSTRAINT-FIRST NARRATOR GUIDANCE switch
 * (narrator-physical-guidance.plan.md slice 2) — experimental, default off, and the
 * REPLACEMENT for `CHAT_AFFORDANCE_CUES` above rather than a second version of it.
 *
 * Where the closed cue experiment volunteered a physical detail on every eligible
 * turn, this projects committed truth mostly as prohibitions: what the narrator must
 * not claim about this body (a braid is not streaming loose) plus the high-confidence
 * false premises in the player's own framing that it must not adopt. There is no
 * positive detail in it at all — that is slice 4's separately-flagged, change-gated
 * experiment (`CHAT_PHYSICAL_TRANSITIONS`), and the two get independent measured
 * ship/park decisions.
 *
 * OFF (the default, and anything other than `on`) is today's behavior to the byte: no
 * premise detection, no guidance compile, no block on the narrator prompt, and — since
 * the flag also decides whether the affordance read is taken at all — no adapter call
 * either unless another flag wants one. ON adds exactly one binding-tier block: at
 * most two premise corrections and three scoped consistency constraints for this
 * exchange. Env-only, no dev route.
 *
 * Note what is NOT behind it, and why that matters for interpreting a trial: the cue
 * flag still owns cue rendering AND the `character_chats.affordance_cues` write. This
 * flag never spends or persists cue memory, so running one experiment cannot move the
 * other's state.
 */
export function chatPhysicalConstraintsEnabled(): boolean {
  return process.env.CHAT_PHYSICAL_CONSTRAINTS === "on";
}

/**
 * The AFFECTIONATE CONTACT switch (romantic-contact-affordances.plan.md
 * §"Continuation order" 1) — experimental, default-off, the same shape as every
 * flag above.
 *
 * OFF (the default, and anything other than `on`) is today's behavior to the
 * byte: no scene seeding, no movement or touch detection, no contact
 * resolution, no lifecycle commit, no ledger row, and no action outcome on the
 * narrator prompt — `ChatScenario.scene` rides through exactly as it was
 * loaded. ON adds the deterministic contact leg: the player's own line is read
 * for a movement toward a present roster member and for a plainly affectionate
 * hand-to-shoulder/arm/back/hand/head touch, the attempt is resolved against
 * the scene owner's reach and support reads, and a committable attempt is
 * committed, written to the durable ledger, and reported to the narrator as one
 * action outcome. Env-only, no dev route.
 *
 * ## How it composes with `CHAT_PHYSICAL_CONSTRAINTS`, and why that is not one flag
 *
 * Detection, resolution, the lifecycle commit, the ledger write, and the scene
 * projection are gated on THIS flag ALONE — they are authoritative state, not a
 * prompt experiment, and they must roll back with the exchange whether or not
 * anything reads them. The compiled outcome only reaches the PROMPT when
 * `CHAT_PHYSICAL_CONSTRAINTS` is also on, because the guidance block is the only
 * door onto the prompt and that flag owns it.
 *
 * Neither flag ever writes the other's state: this one never touches the cue
 * memory or the premise corrections, and the constraints flag never commits a
 * contact. Running one experiment therefore cannot move the other's numbers.
 * The one SHARED value is the effective-coverage capture
 * (`ChatGarmentStore.coverage`): the contact leg derives it from the current
 * exchange's resolved wardrobe pre-prompt (the settle-race fix) and settlement
 * persists the exact object the leg consumed — reusing the affordance read's
 * own capture verbatim whenever the other flag took one, so the two can never
 * disagree about what a body has on.
 */
export function chatContactActionsEnabled(): boolean {
  return process.env.CHAT_CONTACT_ACTIONS === "on";
}

/**
 * The NPC REPLY-SCENE DECISION SHADOW switch
 * (romantic-contact-affordances.spec.actor-control.md §"Execution, flags, and
 * cost gate"; delivery-order step 3) — experimental, default-off, the same
 * literal-`on` shape as every flag above.
 *
 * OFF (the default, and anything other than `on`) is today's behavior to the
 * byte: no trigger, no digest, no classifier call, no decision envelope — the
 * legacy reply-side ending block runs exactly as it ships under
 * `CHAT_CONTACT_ACTIONS`. ON runs the one reply-scene classifier call per
 * persisted nonempty assistant reply and records a durable decision envelope
 * (`chat_npc_scene_decisions`), but grants NO new scene/contact authority:
 * tier-2 proposals are evaluated DRY and recorded, and only the frozen
 * deterministic ending floor — which ships today under `CHAT_CONTACT_ACTIONS`
 * — still changes the scene. Shadow exists to measure trigger rates, candidate
 * quality, latency, and cost before any authority increment is enabled.
 * Env-only, no dev route.
 */
export function chatNpcSceneDecisionShadowEnabled(): boolean {
  return process.env.CHAT_NPC_SCENE_DECISION_SHADOW === "on";
}

/**
 * The NPC REPLY-SCENE DECISION AUTHORITY switch (same spec §) — default-off,
 * and effective ONLY with `CHAT_CONTACT_ACTIONS=on`: the decisions this flag
 * would let commit are contact-lane authority, and granting them while the
 * contact lane itself is off would be a flag that quietly re-enables another
 * flag's feature. Authority WINS over shadow when both flags are on (the mode
 * resolution lives in `chat-npc-scene-decision.ts`).
 *
 * WHICH kinds it may commit is a separate, finer dial —
 * `chatNpcSceneAuthorityKinds()` below — because the spec stages authority in
 * three increments (movement, then starts, then updates) while one branch
 * builds them all. This flag says "authority is live"; that one says how much
 * of it. An out-of-scope kind is still admitted, ordered, and recorded — it
 * simply commits nothing, with the reason in its payload entry.
 */
export function chatNpcSceneDecisionsEnabled(): boolean {
  return process.env.CHAT_NPC_SCENE_DECISIONS === "on" && chatContactActionsEnabled();
}

/**
 * The three authority KINDS the reply-scene leg can execute, in the spec's own
 * delivery order (movement → starts → updates; spec §"Delivery order and
 * gates" 4–6).
 */
export const NPC_SCENE_AUTHORITY_KINDS = ["movement", "start", "update"] as const;
export type NpcSceneAuthorityKind = (typeof NPC_SCENE_AUTHORITY_KINDS)[number];

/**
 * The AUTHORITY SCOPE knob — which kinds `CHAT_NPC_SCENE_DECISIONS=on` may
 * actually execute, read from `CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS` as a
 * comma-separated subset of `movement,start,update`.
 *
 * **Why a scope list instead of three more flags.** The spec stages authority in
 * three increments, but one branch builds them all: a second and third boolean
 * would multiply the flag matrix (and every combination of it that a test must
 * pin) for what is really one ordered rollout dial. Unset or blank ⇒ all three
 * (the fully-enabled end state), so nothing has to be set to run the finished
 * feature; unknown tokens are ignored rather than failing the leg, because a
 * typo in an env var must never cost a settled reply (docs/resilience.md §2).
 * A NONBLANK value naming no known kind therefore grants nothing — the owner
 * asked for a scope, and "none of the kinds I recognize" is the conservative
 * reading of an unrecognized one.
 *
 * It gates EXECUTION ONLY, and only in authority mode. Classification, the four
 * admission gates, presence precedence, chronology planning, and the envelope's
 * recorded `mode` are all untouched by it: an out-of-scope candidate is admitted
 * and recorded exactly like an in-scope one, with its resolution naming the
 * scope as the reason nothing was committed. That is what makes the measurement
 * continuous across a rollout step — the same envelopes, with more of them
 * committing.
 */
export function chatNpcSceneAuthorityKinds(): ReadonlySet<NpcSceneAuthorityKind> {
  const raw = (process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS ?? "").trim();
  if (raw.length === 0) return new Set(NPC_SCENE_AUTHORITY_KINDS);
  const selected = new Set<NpcSceneAuthorityKind>();
  for (const token of raw.split(",")) {
    const normalized = token.trim().toLowerCase();
    const known = NPC_SCENE_AUTHORITY_KINDS.find((kind) => kind === normalized);
    if (known !== undefined) selected.add(known);
  }
  return selected;
}

/**
 * The RECOGNIZABLE-FEATURES switch (body-attribute-affordances.plan.md slice 7) —
 * experimental, default-off, the third of the same shape as `CHAT_GARMENT_CUES`
 * and `CHAT_AFFORDANCE_CUES` above, and for the same reason: slice 7 is a trial,
 * and the live-model comparison it exists to run is owner-gated.
 *
 * OFF (the default, and anything other than `on`) is today's behavior to the
 * byte: no recognition read is taken — no truth projection, no observer
 * candidates, no mention policy — no memory is loaded, and `chat_visual_memory`
 * is never written, so a conversation that has run with the flag on keeps
 * whatever it noticed rather than having it cleared. ON adds exactly two things:
 * at most ONE recognition cue line appended to the affordance cue block, and the
 * observer memory commit that makes its cooldown work (notice history advances
 * even on the turns nothing is said — noticing and mentioning are separate
 * events by ruling). Env-only, no dev route.
 *
 * Note the one seam it shares with `CHAT_AFFORDANCE_CUES`: recognition needs a
 * perception view, which only the affordance adapter builds. With the cue flag
 * off, the pipeline still builds that read as a PERCEPTION SOURCE and discards
 * its cue memory and coverage capture — one flag never writes the other's state.
 */
export function chatRecognitionCuesEnabled(): boolean {
  return process.env.CHAT_RECOGNITION_CUES === "on";
}

/** Max characters of player input echoed inside agent prompts. */
export const AGENT_INPUT_CAP = 2000;
/** Max characters of narration echoed inside agent prompts. */
export const AGENT_NARRATION_CAP = 8000;

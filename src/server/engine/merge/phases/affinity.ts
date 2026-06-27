import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { crossedThresholdHints, NEUTRAL_MOOD_METER } from "@/contracts/meters/registry";
import { findCardById, resolveCardForTags, type SocialReactionCard } from "@/contracts/personality/cards";
import { affinityDecayRetention, scaleAffinityGain, socialTraitScale } from "@/contracts/personality/modulation";
import { evaluateSocialReaction, moodMeterToFactor, type SocialReaction } from "@/contracts/personality/reactions";
import type { TraitValue } from "@/contracts/personality/traits/value";
import { stageForValue } from "@/contracts/relationships/stages";
import type { ContinuityResult, SimulantResult } from "@/contracts/turns/agent-results";
import { AFFINITY_DECAY_WEEK_MINUTES, AFFINITY_DELTA_CLAMP } from "../../constants";
import type { BundleRelationship } from "../../bundle";
import { findParticipant } from "../grounding";
import type { AffinityDecayEdge, AffinityDecayResult, AffinityUpdate, CardBreachResult, PhaseContext } from "../types";
import type { WorkingParticipant, WorkingState } from "../working-state";
import { MAX_AFFINITY_ADJUSTMENTS } from "./caps";

/**
 * Resolve simulant affinityAdjustments to relationship-edge updates
 * (cast-tiers-and-affinity-spec). fromName is whose feeling moved; when that
 * is the player, the evidence becomes the NPC's *perceived* affinity from the
 * player (decision 41 — the player's actual feelings are the player's own).
 * The summed raw delta is **scaled by the edge owner's traits** (personality §4
 * gain/loss asymmetry: warmth/agreeableness amplify gains, guardedness damps them,
 * composure damps losses) before the ±AFFINITY_DELTA_CLAMP clamp. Empty traits ⇒
 * the delta unchanged ⇒ exactly today's behavior. (Recognized social acts are
 * scaled inside the curve instead and never reach this path — they own their edge.)
 */
export function planAffinityUpdates(
  adjustments: SimulantResult["affinityAdjustments"],
  parts: readonly WorkingParticipant[],
  sink?: DiagnosticSink,
): AffinityUpdate[] {
  const byEdge = new Map<string, AffinityUpdate>();
  for (const adj of adjustments) {
    const from = findParticipant(adj.fromName, parts);
    const toward = findParticipant(adj.towardName, parts);
    if (!from || !toward || from.id === toward.id) {
      sink?.push(
        diag("warn", "merge.affinity.unresolved_pair", `affinity adjustment "${adj.fromName}" → "${adj.towardName}" dropped`, {
          context: { fromName: adj.fromName, towardName: adj.towardName },
        }),
      );
      continue;
    }
    if (from.isUser && toward.isUser) continue;
    const update: Omit<AffinityUpdate, "delta"> = from.isUser
      ? { fromParticipantId: toward.id, toParticipantId: from.id, kind: "perceived", reason: adj.reason }
      : { fromParticipantId: from.id, toParticipantId: toward.id, kind: "feeling", reason: adj.reason };
    const key = `${update.fromParticipantId}::${update.toParticipantId}::${update.kind}`;
    const existing = byEdge.get(key);
    const rawDelta = Number.isFinite(adj.delta) ? adj.delta : 0;
    const summed = (existing?.delta ?? 0) + rawDelta;
    byEdge.set(key, { ...update, delta: summed, reason: adj.reason ?? existing?.reason });
  }
  const updates: AffinityUpdate[] = [];
  for (const update of byEdge.values()) {
    const owner = parts.find((p) => p.id === update.fromParticipantId);
    const scaled = scaleAffinityGain(update.delta, owner?.snapshot.traits ?? []);
    const clamped = Math.max(-AFFINITY_DELTA_CLAMP, Math.min(AFFINITY_DELTA_CLAMP, Math.round(scaled)));
    if (clamped === 0) continue;
    updates.push({ ...update, delta: clamped });
  }
  return updates;
}

/**
 * Witnessed-breach reactions (social-reaction-cards.plan.md §Resolution #2). For each
 * breach the continuity agent flagged, emit a next-turn directive, and — when the breacher
 * is the **player** — fold a per-witness affinity delta into each witness→player edge: each
 * witness resolves the breached card against **their own** tags (the foot-fetish flip applies
 * per witness) and rides the same §6 curve as any other reaction (their affinity + mood +
 * trait scale). A witness who genuinely doesn't mind (an `indifferent` resolution) nets no
 * change. Unknown card ids degrade to a directive-only breach.
 */
export function planCardBreachReactions(
  cardBreaches: ContinuityResult["cardBreaches"],
  parts: readonly WorkingParticipant[],
  relationships: readonly BundleRelationship[],
  worldCards: readonly SocialReactionCard[],
  moodByParticipant?: ReadonlyMap<string, number>,
  sink?: DiagnosticSink,
): CardBreachResult {
  const updates: AffinityUpdate[] = [];
  const ownedEdgeKeys = new Set<string>();
  const directives: string[] = [];
  const player = parts.find((p) => p.isUser);

  for (const breach of cardBreaches) {
    const card = findCardById(breach.cardId, worldCards);
    if (!card) {
      sink?.push(diag("info", "merge.breach.unknown_card", `card breach references unknown card "${breach.cardId}"`, { context: { cardId: breach.cardId } }));
      continue;
    }
    const breacher = findParticipant(breach.byName, parts);
    const witnesses = breach.witnessNames
      .map((n) => findParticipant(n, parts))
      .filter((p): p is WorkingParticipant => !!p && !p.isUser && p.id !== breacher?.id);
    const witnessLabel = witnesses.length > 0 ? ` (seen by ${witnesses.map((w) => w.displayName).join(", ")})` : "";
    directives.push(`Correction: ${breach.byName} breached "${card.label}"${witnessLabel} — next turn: present witnesses react in character.`);

    // Affinity fold only when the player is the breacher (witness→player edge).
    if (!player || !breacher || breacher.id !== player.id) continue;
    const conceptId = breach.concept || card.triggers[0] || "";
    for (const witness of witnesses) {
      const resolved = resolveCardForTags(card, conceptId, witness.snapshot.tags);
      if (!resolved) continue; // indifferent ⇒ no change
      const reaction: SocialReaction = { conceptId: resolved.conceptId, valence: resolved.valence, intensity: resolved.intensity, hint: resolved.hint, source: "card" };
      const feeling = relationships.find(
        (r) => r.kind === "feeling" && r.fromParticipantId === witness.id && r.toParticipantId === player.id,
      );
      const mood = moodByParticipant?.get(witness.id) ?? witness.state.meters.mood ?? NEUTRAL_MOOD_METER;
      const evaluated = evaluateSocialReaction(reaction, feeling?.value ?? 0, moodMeterToFactor(mood), socialTraitScale(reaction, witness.snapshot.traits));
      const signed = evaluated.valence === "dislike" ? -evaluated.magnitude : evaluated.magnitude;
      const delta = Math.max(-AFFINITY_DELTA_CLAMP, Math.min(AFFINITY_DELTA_CLAMP, Math.round(signed)));
      ownedEdgeKeys.add(`${witness.id}::${player.id}::feeling`);
      if (delta !== 0) {
        updates.push({ fromParticipantId: witness.id, toParticipantId: player.id, kind: "feeling", delta, reason: `breach:${card.id}` });
      }
    }
  }
  return { updates, ownedEdgeKeys, directives };
}

/**
 * One edge's decay: `points` toward 0, stopped at a **floor** that sits between the
 * stage's zero-side boundary and the current value. `retention` (0..1, personality §4)
 * lifts that floor toward the current value, so a warm, even-keeled (constant) character
 * resists decay — its regard ebbs only a fraction of the way to the boundary each pass.
 * `retention = 0` ⇒ the floor *is* the stage boundary ⇒ exactly today's behavior. The
 * floor is always ≥ the boundary, so decay never crosses a stage boundary regardless of
 * traits (stages stay sticky; only events demote).
 */
export function decayAffinityValue(value: number, points: number, retention = 0): { value: number; clamped: boolean } {
  if (points <= 0 || value === 0) return { value, clamped: false };
  const stage = stageForValue(value);
  if (value > 0) {
    // E.g. friendly (33..49): decay stops at 33; stranger (−14..14) decays through to 0.
    const boundary = Math.max(0, stage.min);
    const floor = Math.round(boundary + retention * (value - boundary));
    const target = value - points;
    return target < floor ? { value: floor, clamped: floor > 0 } : { value: target, clamped: false };
  }
  const boundary = Math.min(0, stage.max);
  const floor = Math.round(boundary + retention * (value - boundary));
  const target = value + points;
  return target > floor ? { value: floor, clamped: floor < 0 } : { value: target, clamped: false };
}

/**
 * Affinity decay (defaults doc §Affinity stages): 1 point per whole elapsed
 * in-game week toward 0 on every relationship edge — but decay alone never
 * crosses a stage boundary; it stops at a trait-derived floor at or above the
 * stage's zero-side edge (stages are sticky; only events demote). The floor is
 * lifted toward the current value by the owner's **decay retention** (personality
 * §4: warmth + composure ⇒ a constant character holds its regard, ebbing more
 * slowly than a fickle one); absent traits ⇒ retention 0 ⇒ the floor is the stage
 * boundary, exactly today's behavior. Edges parked at their floor still plan a
 * `clamped` edge each decay pass — that drives the `affinity_decay_clamped` events
 * row, the tuning evidence for the "relationships fossilizing" revisit trigger.
 * The marker advances by whole weeks only, so the remainder keeps accumulating.
 */
export function planAffinityDecay(
  input: {
    relationships: readonly BundleRelationship[];
    /** Post-turn session clock. */
    clockMinutes: number;
    lastAffinityDecayAt: number | undefined;
    /** Owner participant id → resolved traits, for per-character decay retention. Absent ⇒ baseline decay. */
    traitsByParticipant?: ReadonlyMap<string, readonly TraitValue[]>;
  },
  sink?: DiagnosticSink,
): AffinityDecayResult {
  const last = input.lastAffinityDecayAt;
  if (last === undefined) return { edges: [], lastAffinityDecayAt: input.clockMinutes }; // seed on first use
  if (last > input.clockMinutes) {
    sink?.push(
      diag("warn", "merge.affinity.decay_marker_reset", `lastAffinityDecayAt ${last} is ahead of the clock ${input.clockMinutes} — reseeded`),
    );
    return { edges: [], lastAffinityDecayAt: input.clockMinutes };
  }
  const weeks = Math.floor((input.clockMinutes - last) / AFFINITY_DECAY_WEEK_MINUTES);
  if (weeks < 1) return { edges: [], lastAffinityDecayAt: last };
  const edges: AffinityDecayEdge[] = [];
  for (const rel of input.relationships) {
    const retention = affinityDecayRetention(input.traitsByParticipant?.get(rel.fromParticipantId) ?? []);
    const decayed = decayAffinityValue(rel.value, weeks, retention);
    if (decayed.value === rel.value && !decayed.clamped) continue;
    edges.push({
      fromParticipantId: rel.fromParticipantId,
      toParticipantId: rel.toParticipantId,
      kind: rel.kind,
      previousValue: rel.value,
      value: decayed.value,
      clamped: decayed.clamped,
    });
  }
  return { edges, lastAffinityDecayAt: last + weeks * AFFINITY_DECAY_WEEK_MINUTES };
}

// Affinity decay (defaults doc §Affinity stages): time-driven, so it only
// runs when the clock advances — reconcile leaves edges and marker alone.
export function phaseAffinityDecay(ctx: PhaseContext, state: WorkingState): void {
  const { reconcile, bundle, clockMinutes, sink } = ctx;
  ctx.affinityDecay = reconcile
    ? null
    : planAffinityDecay(
        {
          relationships: bundle.relationships,
          clockMinutes,
          lastAffinityDecayAt: bundle.runtime.lastAffinityDecayAt,
          traitsByParticipant: new Map(state.participants.map((p) => [p.id, p.snapshot.traits])),
        },
        sink,
      );
}

// Newly crossed meter-threshold hints (diffed against the pre-drift snapshot).
export function phaseThresholdHints(ctx: PhaseContext, state: WorkingState): void {
  const { defs } = ctx;
  const thresholdHints: string[] = [];
  for (const participant of state.participants) {
    if (participant.isUser) continue;
    const before = ctx.hintsBefore.get(participant.id) ?? [];
    const after = crossedThresholdHints(participant.state.meters, defs);
    for (const hint of after) {
      if (!before.includes(hint)) thresholdHints.push(`${participant.displayName}: ${hint}`);
    }
  }
  ctx.thresholdHints = thresholdHints;
}

// Affinity = the player→target reaction + the witnessed-breach folds + the
// simulant's remaining adjustments (dropped on any edge a reaction or breach owns).
export function phaseAffinity(ctx: PhaseContext, state: WorkingState): void {
  const { reconcile, continuity, bundle, sink, simulant } = ctx;
  // Witnessed-breach reactions (social-reaction-cards.plan.md §Resolution #2): the
  // continuity agent flagged card breaches; resolve each witness's reaction (their tags +
  // the §6 curve) into witness→player affinity, and a directive per breach into the brief.
  ctx.breachResult = reconcile
    ? { updates: [] as AffinityUpdate[], ownedEdgeKeys: new Set<string>(), directives: [] as string[] }
    : planCardBreachReactions(continuity.cardBreaches, state.participants, bundle.relationships, bundle.style.socialCards, ctx.moodAtTurnStart, sink);
  for (const directive of ctx.breachResult.directives) state.stageDirective(directive);

  ctx.affinityUpdates = reconcile
    ? []
    : (() => {
        const simulantUpdates = planAffinityUpdates(simulant.affinityAdjustments.slice(0, MAX_AFFINITY_ADJUSTMENTS), state.participants, sink);
        const owned = new Set<string>([...(ctx.reactionResult?.ownedEdgeKeys ?? []), ...ctx.breachResult.ownedEdgeKeys]);
        const kept = simulantUpdates.filter((u) => !owned.has(`${u.fromParticipantId}::${u.toParticipantId}::${u.kind}`));
        return [...(ctx.reactionResult?.updates ?? []), ...ctx.breachResult.updates, ...kept];
      })();
}

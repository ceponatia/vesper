import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { NEUTRAL_MOOD_METER } from "@/contracts/meters/registry";
import { evaluateActReaction } from "@/contracts/personality/act-reaction";
import type { SocialReactionCard } from "@/contracts/personality/cards";
import type { IntentBrief } from "@/contracts/turns/intent-brief";
import { AFFINITY_DELTA_CLAMP } from "../../constants";
import type { BundleRelationship } from "../../bundle";
import { findParticipant } from "../grounding";
import type { AffinityUpdate, PhaseContext, ReactionAffinityResult } from "../types";
import type { WorkingParticipant, WorkingState } from "../working-state";

/**
 * Deterministic affinity from the player's classified social acts
 * (personality-and-state.spec.md §6). v1 plays the **primary** act: resolve it
 * against the target NPC's disposition, run the affinity-aware curve over the
 * NPC's turn-start *feeling* edge **and turn-start mood** (μ from the mood meter),
 * and emit a feeling delta plus a mood nudge. The reaction **owns** that edge — its
 * key is returned so the simulant's update on the same edge is dropped (the authored
 * verdict wins for recognized acts), even when the delta rounds to 0 ("lets it
 * slide"). No match ⇒ the simulant handles the edge as usual. `moodByParticipant`
 * supplies turn-start mood (so the narrated hint and the applied number agree); absent
 * ⇒ read the current meter (neutral in tests).
 */
export function planReactionAffinity(
  socialActs: IntentBrief["socialActs"],
  parts: readonly WorkingParticipant[],
  relationships: readonly BundleRelationship[],
  sink?: DiagnosticSink,
  moodByParticipant?: ReadonlyMap<string, number>,
  worldCards: readonly SocialReactionCard[] = [],
): ReactionAffinityResult {
  const empty: ReactionAffinityResult = { updates: [], ownedEdgeKeys: new Set() };
  const primary = socialActs[0]; // v1: primary act only (multi-act deferred)
  if (!primary) return empty;
  const player = parts.find((p) => p.isUser);
  if (!player) return empty;
  const target = findParticipant(primary.target, parts);
  if (!target || target.isUser) {
    sink?.push(
      diag("warn", "merge.reaction.unresolved_target", `social act target "${primary.target}" (${primary.concept}) unresolved`, {
        context: { target: primary.target, concept: primary.concept },
      }),
    );
    return empty;
  }

  const feeling = relationships.find(
    (r) => r.kind === "feeling" && r.fromParticipantId === target.id && r.toParticipantId === player.id,
  );

  // The shared §6 sequence (contracts/personality/act-reaction.ts): preference/card
  // match → curve; unmatched touch → welcome-ness fallback (mood.spec §5); else none.
  // The NPC's own cards win over the world's (personal line beats society's).
  const outcome = evaluateActReaction({
    act: { concept: primary.concept, target: primary.target },
    disposition: { tags: target.snapshot.tags, preferences: target.snapshot.preferences, cards: [...target.snapshot.socialCards, ...worldCards] },
    affinity: feeling?.value ?? 0,
    moodMeter: moodByParticipant?.get(target.id) ?? target.state.meters.mood ?? NEUTRAL_MOOD_METER,
    traits: target.snapshot.traits,
    deltaClamp: AFFINITY_DELTA_CLAMP,
  });

  if (outcome.kind === "none") return empty;
  if (outcome.kind === "touch") {
    return {
      updates: [],
      ownedEdgeKeys: new Set(),
      moodAdjustment: Math.abs(outcome.moodDelta) >= 0.005 ? { participantId: target.id, delta: outcome.moodDelta } : undefined,
      stressAdjustment: Math.abs(outcome.stressDelta) >= 0.005 ? { participantId: target.id, delta: outcome.stressDelta } : undefined,
    };
  }

  const ownedEdgeKeys = new Set([`${target.id}::${player.id}::feeling`]);
  // The reaction also nudges the target's mood (a like lifts, a dislike lowers).
  const moodAdjustment =
    Math.abs(outcome.moodDelta) >= 0.005 ? { participantId: target.id, delta: outcome.moodDelta } : undefined;
  const updates =
    outcome.affinityDelta === 0
      ? []
      : [
          {
            fromParticipantId: target.id,
            toParticipantId: player.id,
            kind: "feeling" as const,
            delta: outcome.affinityDelta,
            reason: `reaction:${outcome.conceptId}`,
          },
        ];
  return { updates, ownedEdgeKeys, moodAdjustment };
}

/** Reaction updates win their edge; simulant updates on an owned edge are dropped. */
export function combineAffinityUpdates(reaction: ReactionAffinityResult, simulant: AffinityUpdate[]): AffinityUpdate[] {
  const kept = simulant.filter(
    (u) => !reaction.ownedEdgeKeys.has(`${u.fromParticipantId}::${u.toParticipantId}::${u.kind}`),
  );
  return [...reaction.updates, ...kept];
}

// Social-reaction affinity + mood (personality §6/§4): resolve the player's primary
// social act against the target's disposition over turn-start feeling + mood, then nudge
// the target's mood (post-drift — the event moved it this turn). Affinity is applied via
// the return's affinityUpdates; the mood nudge is a direct meter write here.
export function phaseReactions(ctx: PhaseContext, state: WorkingState): void {
  const { reconcile, turn, bundle, sink } = ctx;
  const reactionResult = reconcile
    ? null
    : planReactionAffinity(turn.intentBrief?.socialActs ?? [], state.participants, bundle.relationships, sink, ctx.moodAtTurnStart, bundle.style.socialCards);
  ctx.reactionResult = reactionResult;
  if (reactionResult?.moodAdjustment) {
    const t = state.participants.find((p) => p.id === reactionResult.moodAdjustment?.participantId);
    if (t) {
      const next = Math.min(1, Math.max(0, (t.state.meters.mood ?? NEUTRAL_MOOD_METER) + reactionResult.moodAdjustment.delta));
      state.setMeters(t, { ...t.state.meters, mood: next });
    }
  }
  if (reactionResult?.stressAdjustment) {
    const t = state.participants.find((p) => p.id === reactionResult.stressAdjustment?.participantId);
    if (t) {
      const next = Math.min(1, Math.max(0, (t.state.meters.stress ?? 0) + reactionResult.stressAdjustment.delta));
      state.setMeters(t, { ...t.state.meters, stress: next });
    }
  }
}

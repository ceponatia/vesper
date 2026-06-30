import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { NEUTRAL_MOOD_METER } from "@/contracts/meters/registry";
import { isTouchConcept, resolveTouchWelcomeness, touchMoodDeltas } from "@/contracts/mood";
import { interactionConceptById } from "@/contracts/personality/interactions";
import { socialTraitScale } from "@/contracts/personality/modulation";
import { evaluateSocialReaction, moodMeterToFactor, moodNudge, resolveSocialReaction } from "@/contracts/personality/reactions";
import type { SocialReactionCard } from "@/contracts/personality/cards";
import { stageForValue } from "@/contracts/relationships/stages";
import type { IntentBrief } from "@/contracts/turns/intent-brief";
import { AFFINITY_DELTA_CLAMP } from "../../constants";
import type { BundleRelationship } from "../../bundle";
import { findParticipant } from "../grounding";
import type { AffinityUpdate, PhaseContext, ReactionAffinityResult, ReactionBeat } from "../types";
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

  const reaction = resolveSocialReaction(
    { concept: primary.concept, target: primary.target },
    // The NPC's own cards win over the world's (personal line beats society's).
    { tags: target.snapshot.tags, preferences: target.snapshot.preferences, cards: [...target.snapshot.socialCards, ...worldCards] },
  );

  const feeling = relationships.find(
    (r) => r.kind === "feeling" && r.fromParticipantId === target.id && r.toParticipantId === player.id,
  );

  if (!reaction) {
    // Welcome/unwelcome touch (mood.spec §5): a touch concept with no matching
    // preference swings mood (+ stress) by affinity-stage welcome-ness — the no-
    // authoring, auto-scaling fallback. A preference-matched touch instead flows
    // through the reaction curve below (the authored verdict is the override).
    if (isTouchConcept(primary.concept)) {
      const stageId = stageForValue(feeling?.value ?? 0).id;
      const welcomeness = resolveTouchWelcomeness({ affinityStage: stageId });
      const intimate = interactionConceptById(primary.concept)?.intimate ?? false;
      const d = touchMoodDeltas(welcomeness, { intimate, traits: target.snapshot.traits });
      // Avatar beat for an un-carded touch (avatar-3d): the romance beats the pre-narration
      // evaluator misses. A `neutral` touch is too faint to pulse; an intimate touch lands at
      // the strong tier. Cosmetic — it never touches affinity (touches own no edge here).
      const touchBeat: ReactionBeat | undefined =
        welcomeness === "neutral"
          ? undefined
          : {
              participantId: target.id,
              concept: primary.concept,
              valence: welcomeness === "welcome" ? "like" : "dislike",
              magnitude: intimate ? 2 : 1,
            };
      return {
        updates: [],
        ownedEdgeKeys: new Set(),
        moodAdjustment: Math.abs(d.mood) >= 0.005 ? { participantId: target.id, delta: d.mood } : undefined,
        stressAdjustment: Math.abs(d.stress) >= 0.005 ? { participantId: target.id, delta: d.stress } : undefined,
        ...(touchBeat ? { beat: touchBeat } : {}),
      };
    }
    return empty;
  }

  const mood = moodByParticipant?.get(target.id) ?? target.state.meters.mood ?? NEUTRAL_MOOD_METER;
  const evaluated = evaluateSocialReaction(
    reaction,
    feeling?.value ?? 0,
    moodMeterToFactor(mood),
    socialTraitScale(reaction, target.snapshot.traits),
  );
  const ownedEdgeKeys = new Set([`${target.id}::${player.id}::feeling`]);

  // The reaction also nudges the target's mood (a like lifts, a dislike lowers).
  const md = moodNudge(evaluated);
  const moodAdjustment = Math.abs(md) >= 0.005 ? { participantId: target.id, delta: md } : undefined;

  const signed = evaluated.valence === "dislike" ? -evaluated.magnitude : evaluated.magnitude;
  const delta = Math.max(-AFFINITY_DELTA_CLAMP, Math.min(AFFINITY_DELTA_CLAMP, Math.round(signed)));
  const updates =
    delta === 0
      ? []
      : [{ fromParticipantId: target.id, toParticipantId: player.id, kind: "feeling" as const, delta, reason: `reaction:${reaction.conceptId}` }];
  // The avatar beat for a carded reaction: the curve verdict the narrator's `## Reaction`
  // line also restates (a single evaluation), so the pulse agrees with the prose.
  const beat: ReactionBeat = {
    participantId: target.id,
    concept: reaction.conceptId,
    valence: evaluated.valence,
    magnitude: evaluated.magnitude,
  };
  return { updates, ownedEdgeKeys, moodAdjustment, beat };
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

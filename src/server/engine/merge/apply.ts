import { and, eq, sql } from "drizzle-orm";
import type { Diagnostic, DiagnosticSink } from "@/contracts/diagnostics";
import { clampAffinity, stageForValue } from "@/contracts/relationships/stages";
import type { AgentResults, TurnProviders } from "@/contracts/turns/agent-results";
import { embedTexts } from "../../ai";
import { db, events, itemInstances, participantRelationships, sessionParticipants, sessions, turns } from "../../db";
import { addFacts, appendEpisode, deleteEpisodeForTurn, fuzzyResolve, sessionScope } from "../../memory";
import type { SessionBundle } from "../bundle";
import { planTurnEffects } from "./plan";
import type { GroundingDeps, MergeMode, MergePlan, MergeTurn } from "./types";

// ---------------------------------------------------------------------------
// Application (one transaction for all world-state writes)
// ---------------------------------------------------------------------------

export interface ApplyTurnInput {
  bundle: SessionBundle;
  turn: MergeTurn;
  results: AgentResults;
  /** Per-agent provider attribution from the fan-out; concatenated onto the
   * narrator leg the pipeline seeded (jsonb `||`). Empty/absent in demo mode. */
  providers?: TurnProviders;
  sink: DiagnosticSink;
  mode?: MergeMode;
  deps?: GroundingDeps;
}

export async function applyTurnResults(input: ApplyTurnInput): Promise<MergePlan> {
  const { bundle, turn, results } = input;
  const mode: MergeMode = input.mode ?? "post_turn";
  const ownerId = bundle.world.ownerId;

  // Tee diagnostics: the caller keeps its sink, and everything recorded during
  // this merge is also persisted onto the turn row.
  const recorded: Diagnostic[] = [];
  const sink: DiagnosticSink = {
    push(d) {
      recorded.push(d);
      input.sink.push(d);
    },
  };

  const deps: GroundingDeps = input.deps ?? {
    resolveLibraryItem: (name) => fuzzyResolve("item", ownerId, name, { sink }),
    resolveLibraryLocation: (name) => fuzzyResolve("location", ownerId, name, { sink }),
    embedThreadTexts: async (texts) => (await embedTexts(texts)).map((e) => e.vector),
  };

  const plan = await planTurnEffects({
    bundle,
    turn,
    results,
    sink,
    mode,
    deps,
    logMissesForSessionId: bundle.session.id,
  });

  // Facts and the episode are written through the memory module (each
  // internally transactional; embeddings degrade per docs/memory.md). The
  // world-state merge below is the single atomic transaction.
  const scope = sessionScope(bundle.session.id);
  await addFacts(scope, plan.factDrafts, turn.id, sink);
  if (mode === "reconcile") {
    await deleteEpisodeForTurn(scope, turn.number);
  }
  await appendEpisode(scope, turn.number, plan.episodeSummary, plan.touchedThreadIds, sink, plan.witnessedBy);

  const touchedItems = new Set(plan.touchedItemIds);
  const diagnosticsJson = JSON.stringify(recorded);
  // Concatenated onto the providers map (the pipeline already wrote `narrator`),
  // so the agent legs merge in without clobbering it.
  const providersJson = JSON.stringify(input.providers ?? {});

  await db().transaction(async (tx) => {
    for (const participant of plan.participants) {
      await tx
        .update(sessionParticipants)
        .set({ locationId: participant.locationId, state: participant.state })
        .where(eq(sessionParticipants.id, participant.id));
    }

    // Affinity decay first (1 pt per whole in-game week toward 0, stopped at
    // the stage's zero-side boundary), so this turn's adjustments land on
    // decayed values. A boundary stop logs an `affinity_decay_clamped` events
    // row — the "relationships fossilizing" tuning evidence. Stage is
    // recomputed but never changes from decay (boundary stop is within-stage).
    for (const edge of plan.affinityDecay) {
      if (edge.value !== edge.previousValue) {
        await tx
          .update(participantRelationships)
          .set({ value: edge.value, stage: stageForValue(edge.value).id })
          .where(
            and(
              eq(participantRelationships.sessionId, bundle.session.id),
              eq(participantRelationships.fromParticipantId, edge.fromParticipantId),
              eq(participantRelationships.toParticipantId, edge.toParticipantId),
              eq(participantRelationships.kind, edge.kind),
            ),
          );
      }
      if (edge.clamped) {
        await tx.insert(events).values({
          sessionId: bundle.session.id,
          type: "affinity_decay_clamped",
          payload: {
            fromParticipantId: edge.fromParticipantId,
            toParticipantId: edge.toParticipantId,
            kind: edge.kind,
            value: edge.value,
            previousValue: edge.previousValue,
            stage: stageForValue(edge.value).id,
            turnId: turn.id,
          },
        });
      }
    }

    // Affinity edges: read-modify-write per update (tiny volume), logging
    // stage transitions as events — the tuning evidence the spec requires.
    for (const update of plan.affinityUpdates) {
      const [existing] = await tx
        .select()
        .from(participantRelationships)
        .where(
          and(
            eq(participantRelationships.sessionId, bundle.session.id),
            eq(participantRelationships.fromParticipantId, update.fromParticipantId),
            eq(participantRelationships.toParticipantId, update.toParticipantId),
            eq(participantRelationships.kind, update.kind),
          ),
        )
        .limit(1);
      const previousValue = existing?.value ?? 0;
      const previousStage = existing?.stage ?? stageForValue(previousValue).id;
      const value = clampAffinity(previousValue + update.delta);
      const stage = stageForValue(value).id;
      if (existing) {
        await tx.update(participantRelationships).set({ value, stage }).where(eq(participantRelationships.id, existing.id));
      } else {
        await tx.insert(participantRelationships).values({
          sessionId: bundle.session.id,
          fromParticipantId: update.fromParticipantId,
          toParticipantId: update.toParticipantId,
          kind: update.kind,
          value,
          stage,
        });
      }
      if (stage !== previousStage) {
        await tx.insert(events).values({
          sessionId: bundle.session.id,
          type: "affinity_stage",
          payload: {
            fromParticipantId: update.fromParticipantId,
            toParticipantId: update.toParticipantId,
            kind: update.kind,
            from: previousStage,
            to: stage,
            value,
            reason: update.reason ?? null,
            turnId: turn.id,
          },
        });
      }
    }

    // Comms link opens/closes (presence-spec §comms): the link state itself is
    // already in plan.runtime.commsLinks; these rows are the per-turn audit log.
    for (const change of plan.commsChanges) {
      await tx.insert(events).values({
        sessionId: bundle.session.id,
        type: change.op === "open" ? "comms_link_opened" : "comms_link_closed",
        payload: { withParticipantId: change.withParticipantId, kind: change.kind, turnId: turn.id },
      });
    }

    for (const item of plan.items) {
      if (!touchedItems.has(item.id)) continue;
      await tx
        .update(itemInstances)
        .set({
          holderParticipantId: item.holderParticipantId,
          worn: item.worn,
          locationId: item.locationId,
          containerInstanceId: item.containerInstanceId,
          positionNote: item.positionNote,
          state: item.state,
        })
        .where(eq(itemInstances.id, item.id));
    }

    if (mode === "reconcile") {
      // Clock stays put, but the brief carries any reconcile-dropped events
      // and threshold crossings forward (see reconcileBrief).
      await tx.update(sessions).set({ runtime: plan.runtime, brief: plan.brief }).where(eq(sessions.id, bundle.session.id));
      await tx
        .update(turns)
        .set({
          agentResults: sql`${turns.agentResults} || ${JSON.stringify({ simulant: results.simulant, archivist: results.archivist })}::jsonb`,
          diagnostics: sql`${turns.diagnostics} || ${diagnosticsJson}::jsonb`,
          providers: sql`${turns.providers} || ${providersJson}::jsonb`,
          heartbeatAt: new Date(),
        })
        .where(eq(turns.id, turn.id));
    } else {
      await tx
        .update(sessions)
        .set({ clockMinutes: plan.clockMinutes, runtime: plan.runtime, brief: plan.brief })
        .where(eq(sessions.id, bundle.session.id));
      await tx
        .update(turns)
        .set({
          status: "ready",
          minutes: plan.minutes,
          agentResults: {
            simulant: results.simulant,
            archivist: results.archivist,
            continuity: results.continuity,
            director: results.director,
            clock: { minutes: plan.minutes, cause: plan.minutesCause },
          },
          diagnostics: sql`${turns.diagnostics} || ${diagnosticsJson}::jsonb`,
          providers: sql`${turns.providers} || ${providersJson}::jsonb`,
          heartbeatAt: new Date(),
        })
        .where(and(eq(turns.id, turn.id), eq(turns.status, "processing")));
    }
  });

  return plan;
}

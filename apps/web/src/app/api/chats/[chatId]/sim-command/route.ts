import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { composeSimulationId } from "@/contracts/simulation/identity";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { simulationHash } from "@/lib/simulation";
import { simulationActionDefinitionSchema } from "@/contracts/simulation/activities";
import { deriveActivityId } from "@/lib/simulation/activities";
import { actionChipLabel } from "@/lib/simulation/world-read";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { log } from "@/server/log";
import {
  db,
  simActionDefinitions,
  simBranches,
  simCharacters,
  simCommandRequests,
  simItemHoldings,
  simItems,
} from "@/server/db";
import {
  CHAT_LOCK_LABEL_WORLD,
  CompositionFallbackCollector,
  drainBranchTo,
  hasActiveTimeJob,
  noteDrainDiagnostics,
  settleStrandedInTransit,
  findStandingEngagement,
  moveArrivalTarget,
  readDurableActivities,
  readDurableSpaceBranch,
  runAccompanyTogether,
  runDueTimeJobs,
  runSkipWithEscalation,
  submitDurableEndEngagement,
  submitDurableMoveActor,
  submitDurableStartActivity,
  submitDurableTransferItem,
  tryKeyedLock,
  writeWorldBeat,
  zoneLabelFromKind,
} from "@/server/engine";
import { chatBusyBounce, chatExchangeLockKey, requireSimChat, simPlayerEnvelope, type SimChatContext } from "../sim-shared";

type Params = { chatId: string };

/**
 * R3 slice 2 (engine.rollout.plan.md) — typed player commands into the
 * successor: move, end the scene, hand an item over, start an activity. Every
 * admission is the ordinary durable command under the player principal; a
 * refusal returns the §14.4 PUBLIC face — code, public reason, and legal
 * alternatives — never a private cause.
 *
 * command-integrity A1: every command runs UNDER the shared per-chat
 * `chat_exchange` lock (slice 1) so a skip/travel/activity can't interleave with
 * a live reply or another command (contention bounces `chat_busy`, ruling A1-1),
 * and behind a `(chatId, requestId)` idempotency record (slice 4) so a retry
 * replays the recorded response verbatim — one drain, one beat, one outcome —
 * instead of advancing the world twice. Step commands and the world beat carry
 * deterministic ids derived from the client request key, so even a crash between
 * execute and the `completed` record dedupes on re-execution.
 */

/**
 * The client mints a stable requestId per tap (`parseOr`-bound as a whitespace-free
 * token; a missing / malformed one degrades to a server-minted id, i.e. no
 * cross-request dedupe for that call). Bounded, but not whitespace-checked here —
 * the route re-validates it before deriving deterministic step ids.
 */
const requestIdBodySchema = z.string().max(512).optional();
// Capped well under `commandIdSchema`'s 256 so the composed per-step command id
// (`sim-command:<chat>:<request>:<step>`) can never overflow it; an over-long or
// whitespace-bearing token fails here and degrades to a server-minted id.
const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/\s/u.test(value), "requestId cannot contain whitespace");

const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), toZoneId: z.string().min(1).max(256), requestId: requestIdBodySchema }).strict(),
  z.object({ kind: z.literal("end_scene"), requestId: requestIdBodySchema }).strict(),
  z.object({ kind: z.literal("give_item"), itemId: z.string().min(1).max(256), requestId: requestIdBodySchema }).strict(),
  z
    .object({
      kind: z.literal("start_activity"),
      actionDefinitionId: z.string().min(1).max(256),
      targetActorId: z.string().min(1).max(256).optional(),
      requestId: requestIdBodySchema,
    })
    .strict(),
  // R3 slice 4 (ruling 17): the player's time skip — bounded minutes, capped at
  // the storyteller advance's 30 days.
  z
    .object({ kind: z.literal("advance_time"), minutes: z.number().int().min(1).max(30 * 24 * 60), requestId: requestIdBodySchema })
    .strict(),
  // world-ui.plan.md slice 1 (ruling 20): server-composed skip-style travel —
  // move + a bounded advance to the journey's earliest arrival, atomically.
  z.object({ kind: z.literal("travel"), toZoneId: z.string().min(1).max(256), requestId: requestIdBodySchema }).strict(),
  // command-integrity A4: walk-with-me — invite the co-present primary to travel
  // together. ONE atomic `move_together` command (scene-end + one shared journey +
  // one arrival) can no longer strand the pair mid-move; NPC agency (the
  // deterministic acceptance policy) re-runs inside the locked authority view.
  z.object({ kind: z.literal("move_together"), toZoneId: z.string().min(1).max(256), requestId: requestIdBodySchema }).strict(),
  // world-ui.plan.md slice 3 (ruling 20 spirit): server-composed skip-style
  // activity — start_activity + a bounded drain through its duration, atomically.
  z.object({ kind: z.literal("do_activity"), actionDefinitionId: z.string().min(1).max(256), requestId: requestIdBodySchema }).strict(),
]);

type SimCommandBody = z.infer<typeof bodySchema>;

interface CommandOutcome {
  status: string;
  code?: string;
  publicReason?: string;
  legalAlternativeCommandTypes?: readonly string[];
}

/** The HTTP result a command resolves to — recorded verbatim for idempotent replay. */
interface CommandHttpResult {
  status: number;
  body: unknown;
}

const httpOk = (body: unknown, status = 200): CommandHttpResult => ({ status, body });
const httpError = (code: string, message: string, status: number): CommandHttpResult => ({
  status,
  body: { error: { code, message } },
});

/**
 * The §14.4 PUBLIC refusal in the `ok` channel (HTTP 200), so the card reads
 * `publicReason` + `legalAlternatives` instead of a flattened HTTP-error body.
 * Shared by every card-facing composite (travel / give_item / do_activity) —
 * the card is the first real refusal consumer and needs the structured shape.
 */
function publicRefusal(outcome: CommandOutcome): CommandHttpResult {
  return httpOk({
    status: "rejected",
    code: outcome.code,
    publicReason: outcome.publicReason,
    legalAlternatives: [...(outcome.legalAlternativeCommandTypes ?? [])],
  });
}

function respond(outcome: CommandOutcome): CommandHttpResult {
  if (outcome.status === "accepted") return httpOk({ status: "accepted" });
  if (outcome.status === "rejected") {
    return httpOk(
      {
        status: "rejected",
        code: outcome.code,
        publicReason: outcome.publicReason,
        legalAlternatives: outcome.legalAlternativeCommandTypes ?? [],
      },
      409,
    );
  }
  return httpError("sim_conflict", "the world moved; try again", 409);
}

interface CommandContext {
  sim: SimChatContext;
  chatId: string;
  userId: string;
  command: SimCommandBody;
  requestId: string;
  /**
   * The branch clock captured when this request FIRST started — a relative command
   * anchors its absolute target to this so a crash-remnant re-execution lands the
   * same clock (never advancing twice).
   */
  startedStorySecond: number;
}

/**
 * Resolve one command to its HTTP result. Every mutating step derives its
 * envelope id from the client request key (`sim-command:<chat>:<request>:<step>`)
 * so the command-runner replays a duplicate instead of minting a fresh id, and the
 * one world beat it may write carries the same request-derived id so a retry
 * dedupes it at the insert. Runs under the chat_exchange lock (see {@link POST}).
 */
async function resolveCommand(ctx: CommandContext): Promise<CommandHttpResult> {
  const { sim, chatId, userId, command, requestId, startedStorySecond } = ctx;
  const stepEnvelope = (step: string) =>
    simPlayerEnvelope(sim, userId, composeSimulationId("sim-command", [chatId, requestId, step]));
  // One beat per command; keyed on the request so a re-execution writes exactly one.
  const beatDedupeId = composeSimulationId("world-beat", [chatId, requestId]);

  switch (command.kind) {
    case "move": {
      const outcome = await submitDurableMoveActor(
        {
          ...stepEnvelope("move"),
          type: "move_actor",
          payload: { actorId: sim.playerActorId, destinationZoneId: command.toZoneId, travelMode: "walk" },
        },
        { admitAtLockedVersion: true },
      );
      return respond(outcome);
    }
    case "end_scene": {
      // Engagement identity belongs to the actor pair, not the chat: end the
      // scene they are ACTUALLY in (whichever chat or tool opened it).
      const standing = await findStandingEngagement(sim.branchId, sim.playerActorId, sim.primaryActorId);
      if (standing.engagementId === null) {
        return httpOk(
          { status: "rejected", code: "no_open_scene", publicReason: "There is no open scene to end.", legalAlternatives: [] },
          409,
        );
      }
      const outcome = await submitDurableEndEngagement(
        {
          ...stepEnvelope("end"),
          type: "end_engagement",
          payload: { engagementId: standing.engagementId, reason: "participant_choice" },
        },
        { admitAtLockedVersion: true },
      );
      // Slice 2: an explicitly-ended scene leaves a durable transcript beat (a
      // skip folds its own scene close into the time-passes beat instead).
      if (outcome.status === "accepted") {
        await writeWorldBeat({ chatId, branchId: sim.branchId, kind: "scene_ended", dedupeId: beatDedupeId });
      }
      return respond(outcome);
    }
    case "give_item": {
      const [holding] = await db()
        .select({ locusKind: simItemHoldings.locusKind, actorId: simItemHoldings.actorId, name: simItems.name })
        .from(simItemHoldings)
        .innerJoin(
          simItems,
          and(eq(simItems.branchId, simItemHoldings.branchId), eq(simItems.itemId, simItemHoldings.itemId)),
        )
        .where(and(eq(simItemHoldings.branchId, sim.branchId), eq(simItemHoldings.itemId, command.itemId)))
        .limit(1);
      if (!holding || holding.locusKind !== "held" || holding.actorId !== sim.playerActorId) {
        // The §14.4 public face at 200 (matching travel) so the card renders it.
        return httpOk({ status: "rejected", code: "not_held", publicReason: "You are not holding that.", legalAlternatives: [] });
      }
      // The transfer resolver enforces giver/receiver co-location itself (§26.4
      // step 7: the destination's root zone — the primary's zone — must equal
      // the player's), so an absent primary yields `root_not_colocated` "That
      // destination is not within reach." — no route-level co-location precheck
      // needed. The card also disables the affordance when the primary is away.
      const outcome = await submitDurableTransferItem(
        {
          ...stepEnvelope("give"),
          type: "transfer_item",
          schemaVersion: 2,
          payload: {
            actorId: sim.playerActorId,
            itemId: command.itemId,
            fromLocus: { kind: "held", actorId: sim.playerActorId },
            toLocus: { kind: "held", actorId: sim.primaryActorId },
          },
        },
        { admitAtLockedVersion: true },
      );
      if (outcome.status === "rejected") return publicRefusal(outcome);
      if (outcome.status !== "accepted") return httpError("sim_conflict", "the world moved; try again", 409);
      // Slice 3: the handoff leaves a durable "You hand … " beat, named through
      // the primary + the item's own display name (never a raw id).
      const [primary] = await db()
        .select({ name: simCharacters.name })
        .from(simCharacters)
        .where(and(eq(simCharacters.branchId, sim.branchId), eq(simCharacters.characterId, sim.primaryActorId)))
        .limit(1);
      await writeWorldBeat({
        chatId,
        branchId: sim.branchId,
        kind: "gave_item",
        ...(primary ? { recipientName: primary.name } : {}),
        itemName: holding.name,
        dedupeId: beatDedupeId,
      });
      return httpOk({ status: "gave" });
    }
    case "start_activity": {
      const outcome = await submitDurableStartActivity(
        {
          ...stepEnvelope("start"),
          type: "start_activity",
          payload: {
            actorId: sim.playerActorId,
            actionDefinitionId: command.actionDefinitionId,
            ...(command.targetActorId === undefined ? {} : { targetActorId: command.targetActorId }),
          },
        },
        { admitAtLockedVersion: true },
      );
      return respond(outcome);
    }
    case "advance_time": {
      // A skip wraps the standing scene first (the legacy "Later →" semantics:
      // the conversation ends, the player picks up after the gap), then drains
      // the bounded advance the storyteller `advance` already uses.
      const standing = await findStandingEngagement(sim.branchId, sim.playerActorId, sim.primaryActorId);
      if (standing.engagementId !== null) {
        const ended = await submitDurableEndEngagement(
          {
            ...stepEnvelope("advance-end"),
            type: "end_engagement",
            payload: { engagementId: standing.engagementId, reason: "participant_choice" },
          },
          { admitAtLockedVersion: true },
        );
        // The error envelope (not respond's refusal shape) so the skip toast can
        // show the public reason through the ordinary client error path.
        if (ended.status === "rejected") return httpError(ended.code, ended.publicReason, 409);
        if (ended.status !== "accepted") return httpError("sim_conflict", "the world moved; try again", 409);
      }
      const [branch] = await db()
        .select({ worldId: simBranches.worldId })
        .from(simBranches)
        .where(eq(simBranches.id, sim.branchId))
        .limit(1);
      if (!branch) return httpError("not_found", "world branch not found", 404);
      // Anchor the target to the clock at request START, not the live clock — a
      // crash-remnant re-execution then lands the SAME absolute target instead of
      // advancing a second time (`advance_time` is the one relative-target command).
      const target = startedStorySecond + command.minutes * 60;
      // A5 slice 4: NEVER a 500 after the clock committed, and no dead request grinding a 30-day
      // drain. A bounded fast path finishes short skips in-request; a long skip hands its remainder
      // to a durable, server-owned job (which writes the landing beat on completion) and returns
      // `catchingUp` so the client shows staged progress until the world settles (ruling 1–2).
      const skip = await runSkipWithEscalation({
        worldId: branch.worldId,
        branchId: sim.branchId,
        chatId,
        targetStorySecond: target,
      });
      const skipFallbacks = new CompositionFallbackCollector(chatId);
      if (skip.terminalFailures > 0) {
        skipFallbacks.note({
          site: "advance_time",
          code: "trigger_failed",
          detail: `${skip.terminalFailures} poison trigger(s) in the fast path`,
        });
      }
      if (skip.status === "completed") {
        // The skip finished in-request: land the "Time passes — it's now …" beat now (the wrapped
        // standing scene folds into this one beat, never a second).
        await writeWorldBeat({ chatId, branchId: sim.branchId, kind: "time_skipped", fallbacks: skipFallbacks.codes(), dedupeId: beatDedupeId });
        return httpOk({ status: "advanced", toStorySecond: skip.reachedStorySecond, drainShort: false, catchingUp: false });
      }
      // Catching up: the durable job owns the landing beat; the client polls the world/job status.
      return httpOk({ status: "advanced", toStorySecond: skip.reachedStorySecond, drainShort: true, catchingUp: true });
    }
    case "travel": {
      // Skip-style travel (ruling 20) + graceful departure (slice 4): if a scene
      // stands, END it as a CHOICE first (participant_choice — the lawful two-step
      // advance_time performs), so the move that follows fires no hard interrupt
      // (spec §18.2: an ended scene holds no claim). Then submit the move and — on
      // acceptance — drain the clock to the journey's earliest arrival (the §17
      // arrival trigger fires inside the drain).
      const standing = await findStandingEngagement(sim.branchId, sim.playerActorId, sim.primaryActorId);
      let parted = false;
      if (standing.engagementId !== null) {
        const ended = await submitDurableEndEngagement(
          {
            ...stepEnvelope("travel-end"),
            type: "end_engagement",
            payload: { engagementId: standing.engagementId, reason: "participant_choice" },
          },
          { admitAtLockedVersion: true },
        );
        // Degrade to today's behavior on an unexpected end failure: the accepted
        // move still lawfully interrupts the standing scene — never block travel.
        if (ended.status === "accepted") parted = true;
        else log.warn("engine.sim.departure", "travel end-engagement not accepted; interrupt fallback", { chatId, status: ended.status });
      }
      const moveOutcome = await submitDurableMoveActor(
        {
          ...stepEnvelope("travel-move"),
          type: "move_actor",
          payload: { actorId: sim.playerActorId, destinationZoneId: command.toZoneId, travelMode: "walk" },
        },
        { admitAtLockedVersion: true },
      );
      if (moveOutcome.status === "rejected") return publicRefusal(moveOutcome);
      if (moveOutcome.status !== "accepted") {
        return httpError("sim_conflict", "the world moved; try again", 409);
      }
      const target = await moveArrivalTarget(sim.branchId, sim.playerActorId);
      const drain = await drainBranchTo(sim.branchId, target);
      // A5: a short travel drain is honest, never a 500 — the move committed. `arrived` reads the
      // ACTUAL settled loci, so a short drain that left the traveller in transit reports
      // `arrived: false` and the arrival settles on a later beat (see also A7's arrival check).
      const travelFallbacks = new CompositionFallbackCollector(chatId);
      noteDrainDiagnostics(travelFallbacks, "travel", drain);
      const settled = await readDurableSpaceBranch(sim.branchId);
      // A7 arrival check: reuse the settled read; a still-in-transit player is recorded and a
      // durable job is escalated to finish reaching the arrival (never a stuck character).
      await settleStrandedInTransit({
        fallbacks: travelFallbacks,
        site: "travel",
        space: settled,
        actorIds: [sim.playerActorId],
        chatId,
      });
      const arrived = settled.loci.some(
        (locus) => locus.actorId === sim.playerActorId && locus.kind === "at" && locus.zoneId === command.toZoneId,
      );
      // Slice 2/4: the landing leaves ONE durable "You walk to …" beat in the
      // transcript (replacing slice 1's toast), phrased with the parting when a
      // scene was ended. The destination label resolves through the SAME kind→noun
      // seam the world card uses — never a raw id.
      const destKind = settled.zones.find((zone) => zone.id === command.toZoneId)?.kind ?? "";
      await writeWorldBeat({
        chatId,
        branchId: sim.branchId,
        kind: "traveled",
        destinationLabel: zoneLabelFromKind(command.toZoneId, destKind),
        parted,
        fallbacks: travelFallbacks.codes(),
        dedupeId: beatDedupeId,
      });
      return httpOk({ status: "traveled", toStorySecond: drain.reachedStorySecond, arrived, drainShort: !drain.converged });
    }
    case "move_together": {
      // Walk-with-me (command-integrity A4): ONE atomic `move_together` command
      // (decide inside the locked view + scene-end grace + one shared journey +
      // one arrival) — the pair can no longer be stranded mid-move. A decline /
      // refusal returns the §14.4 face at 200 so the card reads it; a landing
      // refreshes the world + transcript. The command id + world beat carry
      // request-derived deterministic ids so a retry replays instead of moving twice.
      const [primary] = await db()
        .select({ name: simCharacters.name })
        .from(simCharacters)
        .where(and(eq(simCharacters.branchId, sim.branchId), eq(simCharacters.characterId, sim.primaryActorId)))
        .limit(1);
      const outcome = await runAccompanyTogether({
        chatId,
        userId,
        branchId: sim.branchId,
        playerActorId: sim.playerActorId,
        primaryActorId: sim.primaryActorId,
        primaryName: primary?.name ?? "They",
        toZoneId: command.toZoneId,
        // C15: the chip path has no reply to attach codes to; the collector stamps them on the
        // beat runAccompanyTogether writes, and records the durable events rows.
        fallbacks: new CompositionFallbackCollector(chatId),
        commandId: stepEnvelope("move-together").id,
        beatDedupeId,
      });
      if (outcome.status === "declined") {
        return httpOk({ status: "rejected", code: "accompany_declined", publicReason: outcome.publicReason, legalAlternatives: outcome.legalAlternatives });
      }
      if (outcome.status === "rejected") {
        return httpOk({ status: "rejected", code: outcome.code, publicReason: outcome.publicReason, legalAlternatives: outcome.legalAlternatives });
      }
      if (outcome.status === "not_copresent") {
        return httpOk({
          status: "rejected",
          code: "not_copresent",
          publicReason: `${primary?.name ?? "They"} isn't here to walk with you.`,
          legalAlternatives: [],
        });
      }
      return httpOk({ status: outcome.status, toStorySecond: outcome.toStorySecond, arrived: outcome.arrived });
    }
    case "do_activity": {
      // Skip-style activity (ruling 20 spirit): submit the player's
      // start_activity, then — on acceptance — drain the clock through the
      // activity's duration. Completion is trigger-scheduled AT start
      // (activity-store schedules the completion trigger at expectedCompleteAt),
      // so the drain fires it; the route never submits complete_activity itself.
      const activityEnvelope = stepEnvelope("activity-start");
      const outcome = await submitDurableStartActivity(
        {
          ...activityEnvelope,
          type: "start_activity",
          payload: { actorId: sim.playerActorId, actionDefinitionId: command.actionDefinitionId },
        },
        { admitAtLockedVersion: true },
      );
      // A claim conflict (e.g. resting mid-scene) surfaces here as the §14.4
      // public face at 200 — the card renders it via the slice-1 refusal surface.
      if (outcome.status === "rejected") return publicRefusal(outcome);
      if (outcome.status !== "accepted") return httpError("sim_conflict", "the world moved; try again", 409);
      // The started activity's id is deterministic from this command; read its
      // expectedCompleteAt to know how far to drain (mirrors travel reading the
      // journey's earliestArrivalAt).
      const activityId = deriveActivityId(sim.branchId, activityEnvelope.id);
      const activities = await readDurableActivities(sim.branchId);
      const started = activities.activities.find((activity) => activity.id === activityId);
      const target = started?.expectedCompleteAt ?? activities.storySecond;
      const drain = await drainBranchTo(sim.branchId, target);
      // A5: a short activity drain is honest, never a 500 — the activity started and its
      // completion trigger is durable, so it settles on a later beat if the drain stops short.
      const activityFallbacks = new CompositionFallbackCollector(chatId);
      noteDrainDiagnostics(activityFallbacks, "do_activity", drain);
      // Slice 3: the settled activity leaves a durable "You rest a while." beat,
      // phrased generically from the action's display label (never a raw id).
      const [definitionRow] = await db()
        .select({ payload: simActionDefinitions.payload })
        .from(simActionDefinitions)
        .where(
          and(
            eq(simActionDefinitions.branchId, sim.branchId),
            eq(simActionDefinitions.actionDefinitionId, command.actionDefinitionId),
          ),
        )
        .limit(1);
      const definition = definitionRow
        ? parseOr(simulationActionDefinitionSchema.nullable(), definitionRow.payload, null, undefined, "sim_action_definitions.payload")
        : null;
      await writeWorldBeat({
        chatId,
        branchId: sim.branchId,
        kind: "rested",
        activityLabel: actionChipLabel(command.actionDefinitionId, definition?.label),
        fallbacks: activityFallbacks.codes(),
        dedupeId: beatDedupeId,
      });
      return httpOk({ status: "performed", toStorySecond: drain.reachedStorySecond, drainShort: !drain.converged });
    }
  }
}

/** The branch's current story-clock (0 if the branch has vanished — the command fails downstream). */
async function readBranchStorySecond(branchId: string): Promise<number> {
  const [row] = await db()
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  return row?.storySecond ?? 0;
}

/** Best-effort: mark a crashed request `failed` (diagnostic only — a retry re-executes regardless). */
async function markRequestFailed(chatId: string, requestId: string): Promise<void> {
  try {
    await db()
      .update(simCommandRequests)
      .set({ state: "failed" })
      .where(and(eq(simCommandRequests.chatId, chatId), eq(simCommandRequests.requestId, requestId)));
  } catch (error) {
    log.warn("engine.sim.command_request", "failed to record command failure state", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The idempotency shell (slice 4), run under the chat_exchange lock so it is the
 * single writer for this chat: look up `(chatId, requestId)`; a completed hit with
 * a matching payload replays verbatim; a hit with a DIFFERENT payload is an
 * `idempotency_mismatch`; a miss records `started` then executes and records
 * `completed`; a crash-remnant `started`/`failed` re-executes idempotently.
 */
async function runIdempotent(ctx: Omit<CommandContext, "startedStorySecond">): Promise<CommandHttpResult> {
  const { sim, chatId, requestId, command } = ctx;
  const { requestId: omittedRequestId, ...payload } = command;
  void omittedRequestId;
  const payloadHash = simulationHash(payload);

  const [existing] = await db()
    .select({
      payloadHash: simCommandRequests.payloadHash,
      preClockStorySecond: simCommandRequests.preClockStorySecond,
      state: simCommandRequests.state,
      resultStatus: simCommandRequests.resultStatus,
      resultBody: simCommandRequests.resultBody,
    })
    .from(simCommandRequests)
    .where(and(eq(simCommandRequests.chatId, chatId), eq(simCommandRequests.requestId, requestId)))
    .limit(1);

  let startedStorySecond: number;
  if (existing) {
    // A reused requestId carrying a DIFFERENT action is a client bug — never
    // replay an unrelated response.
    if (existing.payloadHash !== payloadHash) {
      return httpError("idempotency_mismatch", "this request id was already used for a different command", 409);
    }
    // A recorded response replays verbatim: no second drain, no second beat.
    if (existing.state === "completed" && existing.resultStatus !== null) {
      return { status: existing.resultStatus, body: existing.resultBody };
    }
    // `started` / `failed` with a matching payload is a crash remnant (the in-process
    // lock is single-holder, so no live peer holds this record): re-execute against
    // the ANCHORED clock — the request-derived step ids + beat id + anchored target
    // make it idempotent.
    startedStorySecond = existing.preClockStorySecond ?? (await readBranchStorySecond(sim.branchId));
  } else {
    startedStorySecond = await readBranchStorySecond(sim.branchId);
    await db()
      .insert(simCommandRequests)
      .values({ chatId, requestId, kind: command.kind, payloadHash, preClockStorySecond: startedStorySecond, state: "started" })
      .onConflictDoNothing();
  }

  let result: CommandHttpResult;
  try {
    result = await resolveCommand({ ...ctx, startedStorySecond });
  } catch (error) {
    await markRequestFailed(chatId, requestId);
    throw error;
  }

  await db()
    .update(simCommandRequests)
    .set({
      state: "completed",
      resultStatus: result.status,
      resultBody: result.body,
      schemaTag: command.kind,
      completedAt: new Date(),
    })
    .where(and(eq(simCommandRequests.chatId, chatId), eq(simCommandRequests.requestId, requestId)));

  return result;
}

export const POST = withUser<Params>(async (user, req, ctx) => {
  const { chatId } = await ctx.params;
  const gate = await requireSimChat(chatId, user.id);
  if (!gate.ok) return gate.response;
  const { sim } = gate;
  // A5 slice 4: while a durable time job is catching this branch's world up, turn every mutation
  // away — the in-process lock does not outlive the request that started the job, so the durable
  // job state IS the guard. Re-drive a crashed/backed-off job with a detached sweep on the way out.
  if (await hasActiveTimeJob(sim.branchId)) {
    void runDueTimeJobs(`guard-sweep-${newId()}`).catch(() => undefined);
    return jsonError("world_catching_up", "the world is still catching up on this chat; try again in a moment", 409);
  }
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  const command = body.value;
  // The stable idempotency token — degrade a missing / malformed one to a fresh
  // server id (no cross-request dedupe for that call) rather than fail the turn
  // (docs/resilience.md: degraded default over failed request). A supplied-but-
  // malformed token is a client bug worth a diagnostic; an absent one is normal.
  const requestId = parseOr(requestIdSchema, command.requestId, newId(), undefined, "sim-command.requestId");
  if (command.requestId !== undefined && command.requestId !== requestId) {
    log.warn("engine.sim.command_request", "malformed requestId; degraded to a server-minted id", { chatId });
  }

  // Slice 1 (A1-2): serialize per chat under the SAME lock the reply lanes hold;
  // a miss bounces `chat_busy` (A1-1), phrased by the current holder (slice 3).
  const held = tryKeyedLock(
    chatExchangeLockKey(chatId),
    () => runIdempotent({ sim, chatId, userId: user.id, command, requestId }),
    CHAT_LOCK_LABEL_WORLD,
  );
  if (held === null) return chatBusyBounce(chatId);
  const result = await held;
  return jsonOk(result.body, result.status);
});

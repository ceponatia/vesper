import { computeMoveArrivalTarget, planStrandedSettlement } from "@vesper/simulation-core/travel-settle";
import { newId } from "@/lib/ids";
import { readChatEngineAuthority } from "../chat-authority";
import { readBranchClock, type SimChatClock } from "../sim-beats";
import type { CompositionFallbackCode, CompositionFallbackSite } from "@/contracts/turns/composition-fallback";
import type { SpaceProjection } from "@vesper/simulation-core/contracts/space";
import type { CompositionFallbackCollector } from "../composition-diagnostics";
import { escalateToTimeJob } from "../sim-time-jobs";
import { log } from "../../log";
import { advanceBranchStoryTime, readDurableSpaceBranch } from "../simulation";

/**
 * R3 slice 4 + R5 time domain (ruling 17) — the routed chat's world clock:
 * the linked branch's `storySecond` plus the world's calendar anchor, or null
 * for a legacy chat. The chat UI shows THIS clock for sim-routed chats
 * (parity throughout the system), never the legacy scenario clock; the client
 * derives the legible label via the shared story-clock seam. `readBranchClock`
 * (the underlying branch read) lives in `sim-beats` alongside the beat writer
 * that stamps against it.
 */
export async function readSimChatClock(chatId: string): Promise<SimChatClock | null> {
  const authority = await readChatEngineAuthority(chatId);
  if (
    !authority ||
    authority.authority === "legacy_chat" ||
    authority.authority === "successor_shadow" ||
    !authority.simBranchId
  ) {
    return null;
  }
  return readBranchClock(authority.simBranchId);
}

/** Why a drain stopped short of its target (A5 honesty; A6 adds the trigger reasons). */
export type DrainShortReason = "diverged" | "trigger_backoff" | "trigger_failed";

/** The honest result of a drain — how far time ACTUALLY moved, and why it stopped short. */
export interface DrainResult {
  /** True when the drain reached `target`; false when it stopped short. */
  converged: boolean;
  /** The story second the branch clock actually reached (the honest "how far time moved"). */
  reachedStorySecond: number;
  /** The requested target second. */
  target: number;
  /** Triggers resolved across the whole drain. */
  drained: number;
  /** Why it stopped short — absent on a clean converge. */
  shortReason?: DrainShortReason;
  /**
   * Triggers that went terminally `failed` during the drain (A6 poison sibling). A `converged`
   * drain can still carry these — a poison trigger does not stop the clock. A caller with chat
   * context records a `trigger_failed` diagnostic so the failure is never hidden.
   */
  terminalFailures: number;
}

/** Map a short-drain reason to its C15 fallback code (A5 honesty + A6 trigger reasons). */
export function drainShortCode(reason: DrainShortReason | undefined): CompositionFallbackCode {
  switch (reason) {
    case "diverged":
      return "drain_diverged";
    case "trigger_backoff":
      return "drain_backoff";
    case "trigger_failed":
      return "trigger_failed";
    case undefined:
      return "drain_short";
  }
}

/**
 * Record every C15 diagnostic a drain result implies, through a collector (A5 + A6): a
 * short-drain code when it fell short, and a `trigger_failed` code when a poison trigger
 * failed terminally during it (which can happen even on a converged drain). One shared seam so
 * the five drain sites don't each re-derive this.
 */
export function noteDrainDiagnostics(
  fallbacks: CompositionFallbackCollector | undefined,
  site: CompositionFallbackSite,
  drain: DrainResult,
): void {
  if (!drain.converged) {
    fallbacks?.note({
      site,
      code: drainShortCode(drain.shortReason),
      detail: `reached ${drain.reachedStorySecond}/${drain.target}`,
    });
  }
  if (drain.terminalFailures > 0) {
    fallbacks?.note({ site, code: "trigger_failed", detail: `${drain.terminalFailures} trigger(s) failed terminally` });
  }
}

/**
 * Drain the branch clock to `target` through the SAME bounded advance loop the
 * sim-command route uses (`catch_up_required` just means keep draining). Shared
 * by the route's skip-style composites and the departure choreography so
 * the two settle time identically — never duplicated.
 *
 * Returns an HONEST result (A5): the clock second actually reached and whether it fell short —
 * never a thrown error, so a caller can report "how far time moved" instead of a 500 after the
 * world already committed (docs/resilience.md).
 */
export async function drainBranchTo(branchId: string, target: number): Promise<DrainResult> {
  let drained = 0;
  let terminalFailures = 0;
  for (let calls = 0; ; calls += 1) {
    if (calls > 1_000) {
      // The runaway backstop: the clock advanced as far as it got (every advance persists it),
      // so read the real reached second rather than pretending we hit the target.
      const reached = (await readBranchClock(branchId))?.storySecond ?? target;
      return { converged: false, reachedStorySecond: reached, target, drained, shortReason: "diverged", terminalFailures };
    }
    const outcome = await advanceBranchStoryTime(branchId, target, { workerId: `sim-skip-${newId()}` });
    drained += outcome.drained;
    terminalFailures += outcome.terminalFailures ?? 0;
    if (outcome.status === "advanced") {
      return { converged: true, reachedStorySecond: outcome.storySecond, target, drained, terminalFailures };
    }
    // A6: a backed-off trigger parks the clock at its due second. STOP here (an honest short
    // drain) rather than re-looping — the next pass cannot see the trigger and would jump the
    // clock past it, mis-stamping its event. The clock stays parked, so when the backoff
    // elapses the trigger resolves at exactly the second it was due.
    if (outcome.reason === "trigger_backoff") {
      return {
        converged: false,
        reachedStorySecond: outcome.storySecond,
        target,
        drained,
        shortReason: "trigger_backoff",
        terminalFailures,
      };
    }
    // trigger_budget / time_budget: more visible work remains — keep draining.
  }
}

/**
 * How far to drain after a committed move: the resulting journey's EXPECTED
 * arrival, or the current clock when the move produced no journey. Shared
 * by the travel chip and the NL departure choreography (skip-style).
 *
 * A7: the drain target MUST equal the arrival trigger's due second, which is scheduled at
 * `expectedArrivalAt`. Draining only to `earliestArrivalAt` (equal today, since uncertainty is
 * hardcoded 0) would, the moment travel uncertainty or a `journey_delayed` becomes nonzero,
 * stop the clock BEFORE the arrival trigger fires — leaving the traveller stranded in transit.
 * The two must be the same second; that second is `expectedArrivalAt`, whatever authored route
 * durations later write. (The post-drain check below is the net if they ever diverge.)
 */
export async function moveArrivalTarget(branchId: string, actorId: string): Promise<number> {
  const after = await readDurableSpaceBranch(branchId);
  return computeMoveArrivalTarget(after, actorId);
}

/**
 * A7 safety net, with the review's recovery upgrade: after a travel drain, verify each
 * traveller actually left transit. If one is still `in_transit`, record the `still_in_transit`
 * C15 diagnostic, warn, and — the recovery, not just observability — **escalate a durable time
 * job** targeting the latest stranded arrival, so the runner drains the branch there and fires
 * the arrival OFFLINE, never a stuck character or a dead turn (docs/resilience.md). When the clock
 * has already reached those arrivals (a poison arrival trigger that can never fire), no job is
 * enqueued — the C15 record is what surfaces that for repair.
 */
export async function settleStrandedInTransit(input: {
  fallbacks?: CompositionFallbackCollector;
  site: CompositionFallbackSite;
  space: SpaceProjection;
  actorIds: readonly string[];
  chatId: string;
}): Promise<void> {
  const { space, chatId } = input;
  const settlement = planStrandedSettlement(space, input.actorIds);
  if (settlement.stranded.length === 0) return;
  log.warn("engine.sim.arrival", "actor still in transit after arrival drain; escalating to a durable job", {
    chatId,
    stranded: settlement.stranded,
  });
  input.fallbacks?.note({
    site: input.site,
    code: "still_in_transit",
    detail: `stranded: ${settlement.stranded.join(",")}`,
  });
  // Already at/past the arrivals ⇒ the trigger itself failed (poison); a job can't re-fire it, so
  // the C15 record above is the surfacing — don't enqueue a no-op job.
  if (!settlement.escalate) return;
  await escalateToTimeJob({
    worldId: space.worldId,
    branchId: space.branchId,
    chatId,
    targetStorySecond: settlement.target,
    reachedStorySecond: space.storySecond,
  });
}

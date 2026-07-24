import type { SpaceProjection } from "@/contracts/simulation/space";

/**
 * Post-move travel settling (world-ui.plan.md slice 4, engine.spec §17 / A7) —
 * PURE. Once a move has committed and its journey exists, two small decisions
 * follow: how far to drain the clock so the arrival trigger fires, and — after
 * the drain — whether anyone is still stranded in transit and where the branch
 * clock would have to reach to finish them offline. Both are read-only functions
 * of the SETTLED space projection, so the composed departure/accompany loop and
 * the travel-chip route load the projection ONCE and thread it here rather than
 * re-materializing it per query (sim-read-seam-guards.plan.md slice 3).
 *
 * No IO, no env, no db (src/lib purity): the caller loads the projection, logs
 * the diagnostic, and escalates the durable job; this only decides the numbers.
 */

/** The projection slice these planners read — loci + journeys + the branch clock. */
type SettledSpace = Pick<SpaceProjection, "loci" | "journeys" | "storySecond">;

/**
 * How far to drain after a committed move: the actor's resulting journey's
 * EXPECTED arrival (§17), or the current clock when the move produced no journey
 * (already at the destination, or a refused/undone move). A7: the drain target
 * MUST equal the arrival trigger's due second, which §17 schedules at
 * `expectedArrivalAt` — never `earliestArrivalAt`, which diverges the moment
 * travel uncertainty or a `journey_delayed` becomes nonzero and would stop the
 * clock before the arrival fires, stranding the traveller.
 */
export function computeMoveArrivalTarget(space: SettledSpace, actorId: string): number {
  const movedLocus = space.loci.find((locus) => locus.actorId === actorId);
  const journey =
    movedLocus?.kind === "in_transit"
      ? space.journeys.find((candidate) => candidate.id === movedLocus.journeyId)
      : undefined;
  return journey?.expectedArrivalAt ?? space.storySecond;
}

/** The stranded-in-transit verdict for a settled projection (A7 recovery). */
export interface StrandedSettlement {
  /**
   * The subset of `actorIds` still `in_transit` after the drain — a non-empty
   * list is the trigger for the `still_in_transit` diagnostic (recorded whether
   * or not a job is worth escalating).
   */
  stranded: string[];
  /**
   * The latest expected arrival among the stranded — the second the branch clock
   * must reach for every arrival trigger to have fired. Falls back to the current
   * clock when nobody is stranded or no journey backs the transit locus.
   */
  target: number;
  /**
   * True when a durable time job should finish the arrival offline: someone is
   * stranded, a journey dates their arrival, and that arrival is still AHEAD of
   * the clock. When the clock has already reached it (a poison arrival trigger
   * that can never fire), a job would be a no-op — the diagnostic is the surface.
   */
  escalate: boolean;
}

/**
 * Decide whether a post-drain projection has left anyone stranded in transit and,
 * if so, the second a durable job must drain the branch to. Kept separate from
 * the log/diagnostic/escalate IO so the numbers are unit-testable without a db.
 */
export function planStrandedSettlement(space: SettledSpace, actorIds: readonly string[]): StrandedSettlement {
  const stranded = actorIds.filter((actorId) =>
    space.loci.some((locus) => locus.actorId === actorId && locus.kind === "in_transit"),
  );
  if (stranded.length === 0) return { stranded: [], target: space.storySecond, escalate: false };

  const targets = stranded.flatMap((actorId) => {
    const locus = space.loci.find((l) => l.actorId === actorId && l.kind === "in_transit");
    const journeyId = locus?.kind === "in_transit" ? locus.journeyId : undefined;
    const journey = journeyId ? space.journeys.find((j) => j.id === journeyId) : undefined;
    return journey ? [journey.expectedArrivalAt] : [];
  });
  if (targets.length === 0) return { stranded, target: space.storySecond, escalate: false };

  const target = Math.max(...targets);
  return { stranded, target, escalate: target > space.storySecond };
}

import { describe, expect, it } from "vitest";
import type { Journey, PhysicalLocus, SpaceProjection } from "../contracts/space";
import {
  atLocus,
  journeyTo,
  transitLocus,
  SPACE_HOME_ZONE,
  SPACE_NOW,
  SPACE_PLAYER,
  SPACE_PRIMARY,
  SPACE_SQUARE_ZONE,
} from "../test-support/sim-space-fixtures";
import { computeMoveArrivalTarget, planStrandedSettlement } from "./travel-settle";

/**
 * Pure travel-settling tests. No IO — every projection piece is a fixture
 * (@/test/sim-space-fixtures), so the drain-target and stranded-in-transit
 * DECISIONS are asserted directly, happy path AND the degraded fallbacks the
 * composed loop relies on (a move that produced no journey; a poison arrival
 * the clock already passed; a transit locus with no backing journey). The
 * log/note/escalate IO those numbers drive is covered in
 * space-store.int.test.ts.
 */

const PLAYER = SPACE_PLAYER;
const PRIMARY = SPACE_PRIMARY;
const HOME = SPACE_HOME_ZONE;
const SQUARE = SPACE_SQUARE_ZONE;
const NOW = SPACE_NOW;

/** The projection slice the planners read — the same three fields the full space carries. */
function space(loci: PhysicalLocus[], journeys: Journey[], storySecond = NOW): Pick<SpaceProjection, "loci" | "journeys" | "storySecond"> {
  return { loci, journeys, storySecond };
}

describe("computeMoveArrivalTarget", () => {
  it("follows the resulting journey's EXPECTED arrival (A7 — never earliest)", () => {
    const earliest = NOW + 300;
    const expected = NOW + 500; // a delay slipped expected past earliest
    const projection = space(
      [transitLocus(PLAYER, "jrn-1")],
      [journeyTo("jrn-1", { earliestArrivalAt: earliest, expectedArrivalAt: expected })],
    );
    expect(computeMoveArrivalTarget(projection, PLAYER)).toBe(expected);
  });

  it("falls back to the current clock when the actor is not in transit (no journey)", () => {
    const projection = space([atLocus(PLAYER, HOME)], []);
    expect(computeMoveArrivalTarget(projection, PLAYER)).toBe(NOW);
  });

  it("falls back to the current clock when the actor has no locus at all", () => {
    const projection = space([atLocus(PRIMARY, SQUARE)], []);
    expect(computeMoveArrivalTarget(projection, PLAYER)).toBe(NOW);
  });

  it("falls back to the current clock when the transit locus references a missing journey", () => {
    const projection = space(
      [transitLocus(PLAYER, "jrn-gone")],
      [journeyTo("jrn-other", { earliestArrivalAt: NOW + 100, expectedArrivalAt: NOW + 100 })],
    );
    expect(computeMoveArrivalTarget(projection, PLAYER)).toBe(NOW);
  });
});

describe("planStrandedSettlement", () => {
  it("reports nobody stranded when every named actor has arrived", () => {
    const projection = space([atLocus(PLAYER, SQUARE), atLocus(PRIMARY, SQUARE)], []);
    expect(planStrandedSettlement(projection, [PLAYER, PRIMARY])).toEqual({
      stranded: [],
      target: NOW,
      escalate: false,
    });
  });

  it("escalates to the latest expected arrival when a traveller is still in transit ahead of the clock", () => {
    const projection = space(
      [transitLocus(PLAYER, "jrn-p"), transitLocus(PRIMARY, "jrn-q")],
      [
        journeyTo("jrn-p", { earliestArrivalAt: NOW + 300, expectedArrivalAt: NOW + 300 }),
        journeyTo("jrn-q", { earliestArrivalAt: NOW + 600, expectedArrivalAt: NOW + 900 }),
      ],
    );
    expect(planStrandedSettlement(projection, [PLAYER, PRIMARY])).toEqual({
      stranded: [PLAYER, PRIMARY],
      target: NOW + 900, // the LATER of the two expected arrivals
      escalate: true,
    });
  });

  it("flags the stranded actor but does NOT escalate when the arrival is already at/past the clock (poison trigger)", () => {
    // A journey whose expected arrival the clock already reached — a job can't re-fire it, so the
    // diagnostic (stranded is non-empty) is the surface, not a no-op job.
    const projection = space(
      [transitLocus(PLAYER, "jrn-p")],
      [journeyTo("jrn-p", { earliestArrivalAt: NOW - 100, expectedArrivalAt: NOW - 100 })],
      NOW,
    );
    expect(planStrandedSettlement(projection, [PLAYER])).toEqual({
      stranded: [PLAYER],
      target: NOW - 100,
      escalate: false,
    });
  });

  it("flags the stranded actor but does NOT escalate when no journey backs the transit locus", () => {
    const projection = space([transitLocus(PLAYER, "jrn-missing")], []);
    expect(planStrandedSettlement(projection, [PLAYER])).toEqual({
      stranded: [PLAYER],
      target: NOW,
      escalate: false,
    });
  });

  it("only considers the named actors — a stranded bystander is ignored", () => {
    const projection = space(
      [atLocus(PLAYER, SQUARE), transitLocus(PRIMARY, "jrn-q")],
      [journeyTo("jrn-q", { earliestArrivalAt: NOW + 600, expectedArrivalAt: NOW + 600 })],
    );
    expect(planStrandedSettlement(projection, [PLAYER])).toEqual({ stranded: [], target: NOW, escalate: false });
  });
});

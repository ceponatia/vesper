import type { AdmittedCommand } from "./input-admission";
import { placeAtPhrase } from "./solo-cut";
import { placeGoPhrase } from "./world-read";

/**
 * Graceful-departure choreography (ruling 20) — PURE. A player-chosen departure
 * (the travel chip, or an admitted natural-language "I walk to the town square")
 * should END the standing scene as a CHOICE and narrate the parting, rather than
 * lean on the move's hard `engagement_interrupted`. This module holds the small
 * decision the exchange and the route both consult — scene-stands ×
 * admitted-command-kind → what the choreography does — and the pure
 * departure-context line the solo prompt uses.
 *
 * No IO, no env, no db (src/lib purity): the caller loads the world and resolves
 * every label; this only decides shape and phrases the arc.
 */

export interface DepartureChoreography {
  /**
   * True when an admitted MOVE turns this turn into a chosen departure — the
   * player leaves, so the render routes to the solo cut at the destination.
   */
  choreograph: boolean;
  /**
   * End the standing scene as `participant_choice` BEFORE the move (the lawful
   * two-step `advance_time` performs), so the move fires no hard interrupt
   * (an ended scene holds no claim to interrupt). Only when a scene actually
   * stands.
   */
  endSceneFirst: boolean;
  /** The traveled world-beat carries the "took their leave" parting phrasing. */
  parted: boolean;
  /** The solo prompt gets farewell framing (whom the player just left, and where). */
  farewell: boolean;
}

/**
 * The choreography for one turn, from whether a co-present scene stands and what
 * (if anything) input admission matched. A MOVE is the only trigger: leaving a
 * standing scene ends it as a choice and frames a farewell; leaving when already
 * solo (the primary is elsewhere) still walks the player there but skips the
 * goodbye. Every non-move admission (give / rest / none) keeps today's flow.
 */
export function planDepartureChoreography(input: {
  admittedKind: AdmittedCommand["kind"] | null;
  sceneStands: boolean;
}): DepartureChoreography {
  const isMove = input.admittedKind === "move";
  const withScene = isMove && input.sceneStands;
  return { choreograph: isMove, endSceneFirst: withScene, parted: withScene, farewell: withScene };
}

/**
 * The departure ARC the player just lived this turn: whom they parted from (only
 * on a farewell — a scene was ended), the zone they left, and the zone they
 * travelled to and now occupy. Every field is a resolved display label (charter
 * law — never a raw id).
 */
export interface SoloDeparture {
  /** Whom the player just parted from — set only on a farewell (a scene was ended). */
  farewellFrom?: string;
  /** The zone the player set out FROM (display noun). */
  fromLabel: string;
  /** The zone the player travelled TO and now occupies (display noun). */
  toLabel: string;
}

/**
 * The one-line departure directive the solo prompt prepends to block (a): this
 * turn is a chosen departure, so block (a) narrates the goodbye (when a scene was
 * ended), the walk, and the arrival as ONE continuous beat — never a jump-cut.
 * Pure; reuses the `at the {place}` / `the {place}` idioms the rest of the world
 * surface already speaks in.
 */
export function buildSoloDepartureLine(input: { departure: SoloDeparture; playerName: string }): string {
  const { departure, playerName } = input;
  const to = placeGoPhrase(departure.toLabel);
  if (departure.farewellFrom) {
    return (
      `This turn began with ${playerName} taking their leave of ${departure.farewellFrom} ` +
      `${placeAtPhrase(departure.fromLabel)} and setting out for ${to}, where they now are. ` +
      "Narrate the goodbye, the walk, and the arrival as one continuous moment — not a jump-cut."
    );
  }
  return (
    `This turn, ${playerName} set out from ${placeGoPhrase(departure.fromLabel)} for ${to}, ` +
    "where they now are. Narrate the walk and the arrival as one continuous moment."
  );
}

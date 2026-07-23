import { formatSimLanding, type SimCalendarStart } from "./clock";
import { placeGoPhrase } from "./world-read";

/**
 * World-beat phrasing (world-ui.plan.md slice 2) — PURE. A world beat is the
 * durable transcript trace of a world event the player caused or witnessed
 * (travel, a time skip, a scene ending), replacing slice 1's toast-only feedback.
 * This module turns the event kind + the post-command story clock into the exact
 * line the transcript renders; the server phrases it once at write time and stores
 * the text on an ordinary message row (`meta.worldBeat`).
 *
 * The story-time stamp is ALWAYS the shared `formatSimLanding` (the one time
 * surface the skip/travel toasts already name their landing through) — this module
 * never invents a parallel clock formatter. No IO, no env, no db (src/lib purity).
 */

/** The world events that leave a durable transcript beat. */
export const WORLD_BEAT_KINDS = ["traveled", "time_skipped", "scene_ended"] as const;
export type WorldBeatKind = (typeof WORLD_BEAT_KINDS)[number];

export interface WorldBeatInput {
  kind: WorldBeatKind;
  /** The post-command branch clock the beat is stamped at. */
  storySecond: number;
  /** The world's calendar anchor (null ⇒ the anchorless "Day N" landing). */
  anchor: SimCalendarStart | null;
  /** Destination display noun for a `traveled` beat ("town square", "home"); ignored otherwise. */
  destinationLabel?: string;
}

/**
 * The single rendered line for one world beat. `traveled` composes the same
 * `placeGoPhrase` the travel chip/toast use ("home" bare, every other place
 * article-prefixed) with the landing stamp; the skip beat folds a closed scene
 * into "Time passes" rather than emitting a second beat (ruling: one beat per
 * event). Exhaustive over `WorldBeatKind`.
 */
export function worldBeatText(input: WorldBeatInput): string {
  const landing = formatSimLanding(input.storySecond, input.anchor);
  switch (input.kind) {
    case "traveled": {
      const label = input.destinationLabel ?? "";
      // "home" reads bare ("You walk home"); every other place takes the article
      // via `placeGoPhrase` ("the town square") — the goChipLabel idiom, in prose.
      const phrase = label === "home" ? "You walk home." : `You walk to ${placeGoPhrase(label)}.`;
      return `${phrase} · ${landing}`;
    }
    case "time_skipped":
      return `Time passes — it's now ${landing}.`;
    case "scene_ended":
      return `The scene ends. · ${landing}`;
  }
}

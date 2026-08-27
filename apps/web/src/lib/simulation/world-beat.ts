import { formatSimLanding, type SimCalendarStart } from "./clock";
import { placeGoPhrase } from "@vesper/simulation-core/world-read";

/**
 * World-beat phrasing — PURE. A world beat is the
 * durable transcript trace of a world event the player caused or witnessed
 * (travel, a time skip, a scene ending), replacing the earlier toast-only feedback.
 * This module turns the event kind + the post-command story clock into the exact
 * line the transcript renders; the server phrases it once at write time and stores
 * the text on an ordinary message row (`meta.worldBeat`).
 *
 * The story-time stamp is ALWAYS the shared `formatSimLanding` (the one time
 * surface the skip/travel toasts already name their landing through) — this module
 * never invents a parallel clock formatter. No IO, no env, no db (src/lib purity).
 */

/**
 * The world events that leave a durable transcript beat. `gave_item` is a held
 * handoff to the primary; `rested` is a performed skip-style activity.
 */
export const WORLD_BEAT_KINDS = ["traveled", "time_skipped", "scene_ended", "gave_item", "rested"] as const;
export type WorldBeatKind = (typeof WORLD_BEAT_KINDS)[number];

export interface WorldBeatInput {
  kind: WorldBeatKind;
  /** The post-command branch clock the beat is stamped at. */
  storySecond: number;
  /** The world's calendar anchor (null ⇒ the anchorless "Day N" landing). */
  anchor: SimCalendarStart | null;
  /** Destination display noun for a `traveled` beat ("town square", "home"); ignored otherwise. */
  destinationLabel?: string;
  /**
   * The traveled departure ended a standing scene as a CHOICE — the
   * beat acknowledges the parting ("You take your leave and walk to…"). Ignored
   * for a plain travel or any non-`traveled` beat.
   */
  parted?: boolean;
  /**
   * The traveled departure was a WALK-WITH-ME — the primary accepted
   * the invite and came along ("You walk to … together."). Supersedes `parted`
   * (you don't take your leave of someone you're walking with). Ignored for a
   * solo travel or any non-`traveled` beat.
   */
  together?: boolean;
  /** The recipient's display name for a `gave_item` beat; ignored otherwise. */
  recipientName?: string;
  /** The handed item's display name for a `gave_item` beat (carries its own article); ignored otherwise. */
  itemName?: string;
  /** The performed action's display label for a `rested` beat (phrased generically); ignored otherwise. */
  activityLabel?: string;
}

/**
 * The single rendered line for one world beat. `traveled` composes the same
 * `placeGoPhrase` the travel chip/toast use ("home" bare, every other place
 * article-prefixed) with the landing stamp; the skip beat folds a closed scene
 * into "Time passes" rather than emitting a second beat (ruling: one beat per
 * event). `gave_item` names the recipient + the item's own name; `rested`
 * phrases generically from the action's display label (never hardcoded to
 * "rest"), so a future "Nap"/"Meditate" action reads right for free. Exhaustive
 * over `WorldBeatKind`.
 */
export function worldBeatText(input: WorldBeatInput): string {
  const landing = formatSimLanding(input.storySecond, input.anchor);
  switch (input.kind) {
    case "traveled": {
      const label = input.destinationLabel ?? "";
      // "home" reads bare ("You walk home"); every other place takes the article
      // via `placeGoPhrase` ("the town square") — the goChipLabel idiom, in prose.
      // A WALK-WITH-ME supersedes the parting: you walk there together.
      // Else a `parted` departure ended a standing scene as a choice, so
      // the beat acknowledges the leave-taking first.
      if (input.together) {
        const phrase = label === "home" ? "You walk home together." : `You walk to ${placeGoPhrase(label)} together.`;
        return `${phrase} · ${landing}`;
      }
      const lead = input.parted ? "You take your leave and walk" : "You walk";
      const phrase = label === "home" ? `${lead} home.` : `${lead} to ${placeGoPhrase(label)}.`;
      return `${phrase} · ${landing}`;
    }
    case "time_skipped":
      return `Time passes — it's now ${landing}.`;
    case "scene_ended":
      return `The scene ends. · ${landing}`;
    case "gave_item": {
      const recipient = input.recipientName?.trim() || "them";
      const item = input.itemName?.trim() || "it";
      return `You hand ${recipient} ${item}. · ${landing}`;
    }
    case "rested": {
      // Generic from the label: "Rest" → "You rest a while.", "Nap" → "You nap a while."
      const verb = input.activityLabel?.trim().toLowerCase() || "rest";
      return `You ${verb} a while. · ${landing}`;
    }
  }
}

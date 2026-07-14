import type { ChatDrive } from "@/contracts/personality/drives";
import { traitPole } from "@/contracts/personality/traits";

/**
 * Chat initiative (chat-initiative.plan.md): the reopen opener's cue — the
 * character reaches out FIRST, with her own material. Grows §8.4 v1 (the
 * loops-keyed "has something to say" continue) into real initiative while
 * staying inside the standing rulings: **D8** (no wall clock in the fiction)
 * and **D3** (wall-clock absence is never a trigger) — the opener fires only
 * when the player taps it, and what the gap meant in-fiction comes from the
 * pending skip note, never real time.
 *
 * The life-event beat is folded into the license itself (build decision,
 * recorded in the plan): rather than a separate minting agent, the cue invites
 * the narrator to weave in ONE small thing from her life since — grounded in
 * scenario, personality, and drives — which costs nothing and stays exactly as
 * consistent as the narrator already is.
 */

export interface InitiativeCueInput {
  characterName: string;
  playerName: string;
  /** The standing open loops (§6.2) — the opener's strongest material. */
  openLoops: readonly string[];
  /** Runtime drives — open/guarded wants give her something to pursue; withheld secrets are NOT listed here (the tail law owns them). */
  drives: readonly ChatDrive[];
  /** True when a time skip is pending (its note already rides the tail) — the gap is real in-fiction. */
  skipPending: boolean;
  /**
   * The newest milestone the player hasn't seen (§8.4 v2 seen-cursor) — what
   * shifted between them since the chat was last opened. Extra material only;
   * absent ⇒ the pre-slice-2 cue byte-identical.
   */
  recentShift?: string | null;
  /**
   * The authored daily rhythm (profile.schedule — chat-initiative.plan.md
   * slice 4), pre-rendered as a compact line ("mornings: waiting tables at the
   * Dockside Café; evenings: sketching at the pier"). Grounds the "a life
   * meanwhile" license; empty ⇒ no rhythm line.
   */
  rhythm?: string;
  /**
   * The character's `social.extraversion` (character-fidelity slice 5) — colors the
   * initiative CADENCE: an extravert opens readily and warmly, an introvert reaches
   * out on quieter, more reticent terms (still reaching, just not gushing). Mid /
   * absent (0) ⇒ no cadence line, so the cue is byte-identical to before.
   */
  extraversion?: number;
}

/**
 * The one-turn initiative cue for a reopen opener (a `continue` exchange).
 * PURE. Composition: reach out first → her material (loops + unresolved
 * non-secret wants) → the "a life meanwhile" license (skip-aware) → the
 * register rule (a text when apart, in-scene when together) → restraint.
 */
export function buildInitiativeCue(input: InitiativeCueInput): string {
  const loops = input.openLoops.map((l) => l.trim()).filter(Boolean).slice(0, 2);
  const wants = input.drives
    .filter((d) => !d.resolved && (d.secrecy === "open" || d.secrecy === "guarded" || d.revealed))
    .map((d) => d.want.trim())
    .filter(Boolean)
    .slice(0, 2);
  const shift = input.recentShift?.trim() ?? "";
  const material = [
    ...loops.map((l) => `unfinished business: "${l}"`),
    ...wants.map((w) => `something you want: "${w}"`),
    ...(shift ? [`what just shifted between you: "${shift}" — still fresh for you`] : []),
  ];
  const rhythm = input.rhythm?.trim() ?? "";
  const pole = traitPole(input.extraversion ?? 0);
  const cadence =
    pole === "high"
      ? "Reaching out first comes easily to you — open readily and warmly, like someone glad of the company."
      : pole === "low"
        ? "Reaching out first doesn't come naturally to you — let the opener carry that: a shorter reach, a beat of reticence, the contact real but on your own quieter terms. You still reach out; you just don't gush."
        : "";
  const lines = [
    `${input.playerName} has come back to you — reach out FIRST, in character: you have the opening move, and you have your own reasons to take it.`,
    ...(cadence ? [cadence] : []),
    material.length
      ? `Your material (pick what genuinely pulls at you — never list it): ${material.join("; ")}.`
      : `Nothing specific is pending between you — open with what YOU are doing, thinking, or wanting right now.`,
    input.skipPending
      ? `Time has passed (the note below says how it feels): you may weave in ONE small, concrete thing from your life meanwhile — something that happened, changed, or nagged at you — consistent with the scenario, your personality, and what you want. One thing, lightly; never a report.`
      : `You may weave in ONE small, concrete thing from your own day — consistent with the scenario and your personality — if it gives the opening life.`,
    ...(rhythm ? [`Your usual rhythm, to ground what your life meanwhile actually looks like: ${rhythm}.`] : []),
    `Register: if you and ${input.playerName} are apart in the fiction, open as a text on its own line — *${input.characterName}: your words* — the way you'd actually reach out; if you are together in a scene, open in the scene.`,
    `One opening beat: land it and end on something ${input.playerName} can answer. Do not narrate ${input.playerName}, and do not resolve what you raise.`,
  ];
  return lines.join(" ");
}

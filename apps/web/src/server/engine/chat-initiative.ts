import type { ChatDrive } from "@/contracts/personality/drives";
import { traitPole } from "@/contracts/personality/traits";
import type { SalientPlan } from "@/contracts/turns/chat-plans";

/**
 * Chat initiative: the reopen opener's cue — the character reaches out FIRST,
 * with her own material. Grows the loops-keyed "has something to say" continue
 * into real initiative while
 * staying inside the standing rulings: no wall clock in the fiction, and
 * wall-clock absence is never a trigger — the opener fires only
 * when the player taps it, and what the gap meant in-fiction comes from the
 * pending skip note, never real time.
 *
 * The life-event beat is folded into the license itself: rather than a separate
 * minting agent, the cue invites
 * the narrator to weave in ONE small thing from her life since — grounded in
 * scenario, personality, and drives — which costs nothing and stays exactly as
 * consistent as the narrator already is.
 */

export interface InitiativeCueInput {
  characterName: string;
  playerName: string;
  /** The standing open loops — the opener's strongest material. */
  openLoops: readonly string[];
  /**
   * Plans near this turn, already derived against the story clock:
   * an imminent commitment ("is tonight still on?") or a just-missed one (the cold open
   * after being stood up) is first-class opener material — it LEADS the list. Absent/empty
   * ⇒ the pre-plans cue byte-identical.
   */
  openPlans?: readonly SalientPlan[];
  /** Runtime drives — open/guarded wants give her something to pursue; withheld secrets are NOT listed here (the tail law owns them). */
  drives: readonly ChatDrive[];
  /** True when a time skip is pending (its note already rides the tail) — the gap is real in-fiction. */
  skipPending: boolean;
  /**
   * The newest milestone the player hasn't seen (the seen-cursor) — what
   * shifted between them since the chat was last opened. Extra material only;
   * absent ⇒ no shift line.
   */
  recentShift?: string | null;
  /**
   * The authored daily rhythm (profile.schedule), pre-rendered as a compact
   * line ("mornings: waiting tables at the
   * Dockside Café; evenings: sketching at the pier"). Grounds the "a life
   * meanwhile" license; empty ⇒ no rhythm line.
   */
  rhythm?: string;
  /**
   * The character's `social.extraversion` — colors the
   * initiative CADENCE: an extravert opens readily and warmly, an introvert reaches
   * out on quieter, more reticent terms (still reaching, just not gushing). Mid /
   * absent (0) ⇒ no cadence line, so the cue is byte-identical to before.
   */
  extraversion?: number;
  /**
   * The supporting cast, pre-rendered compact ("Mira (her sister — just started a new
   * job)"): the sister is who she'd have seen, so improvised
   * life beats attach to established people instead of minting strangers. "" ⇒ no line.
   */
  cast?: string;
  /**
   * The meanwhile pass's note: what ACTUALLY
   * happened off-screen this gap. When present, the life-meanwhile license draws
   * from it instead of free invention — same-beat dedupe by construction.
   */
  meanwhile?: string;
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
  // Plans lead: a commitment coming due — or just missed — is the
  // strongest reason to reach out first. Only the near ones (never a far-off upcoming).
  const planMaterial = (input.openPlans ?? [])
    .filter((s) => s.salience !== "upcoming")
    .slice(0, 2)
    .map((s) => {
      const what = s.plan.what.trim();
      const when = s.whenLabel;
      if (s.salience === "justMissed") return `a plan you two missed: "${what}" — it was ${when} and it didn't happen`;
      if (s.salience === "dueNow") return `a plan for right now: "${what}"`;
      return `a plan coming up: "${what}" (${when}) — is it still on?`;
    });
  const meanwhile = input.meanwhile?.trim() ?? "";
  const cast = input.cast?.trim() ?? "";
  const material = [
    // What actually happened off-screen LEADS (dedupe rule F): improvisation yields to canon.
    ...(meanwhile ? [`what actually happened while you were apart (true — draw from this, don't invent a different beat): "${meanwhile}"`] : []),
    ...planMaterial,
    ...loops.map((l) => `unfinished business: "${l}"`),
    ...wants.map((w) => `something you want: "${w}"`),
    ...(shift ? [`what just shifted between you: "${shift}" — still fresh for you`] : []),
    ...(cast ? [`people in your life (they're who your days actually contain): ${cast}`] : []),
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
      ? meanwhile
        ? `Time has passed, and your material above names what actually happened meanwhile — pick your ONE meanwhile beat from it, lightly; never a report, and never invent a different meanwhile.`
        : `Time has passed (the note below says how it feels): you may weave in ONE small, concrete thing from your life meanwhile — something that happened, changed, or nagged at you — grounded in your rhythm, your wants, and the people in your life. One thing, lightly; never a report.`
      : `You may weave in ONE small, concrete thing from your own day — consistent with the scenario and your personality — if it gives the opening life.`,
    ...(rhythm ? [`Your usual rhythm, to ground what your life meanwhile actually looks like: ${rhythm}.`] : []),
    `Register: if you and ${input.playerName} are apart in the fiction, open as a text on its own line — *${input.characterName}: your words* — the way you'd actually reach out; if you are together in a scene, open in the scene.`,
    `One opening beat: land it and end on something ${input.playerName} can answer. Do not narrate ${input.playerName}, and do not resolve what you raise.`,
  ];
  return lines.join(" ");
}

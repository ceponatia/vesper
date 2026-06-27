import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { concealedSalience, darknessVerdict, defaultSalience, deriveAttention, hasStealthMarker, perceives, senseModsFromConditions, type Salience } from "@/contracts/perception";
import type { SimulantResult } from "@/contracts/turns/agent-results";
import { daylightBand, resolveGameTime, type DaylightBand } from "@/lib/clock";
import { activeLocationId } from "../../bundle";
import { findParticipant } from "../grounding";
import { detectIntent } from "../../intent";
import type { MergeTurn, PhaseContext } from "../types";
import type { WorkingParticipant, WorkingState } from "../working-state";

/** Does the text mention the participant's first name or an alias (whole-word, ci)? */
export function mentionsParticipant(text: string, participant: WorkingParticipant): boolean {
  const lower = text.toLowerCase();
  const names = [participant.displayName.split(/\s+/)[0] ?? participant.displayName, ...participant.snapshot.aliases];
  return names.some((name) => {
    const n = name.trim().toLowerCase();
    if (!n) return false;
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return re.test(lower);
  });
}

/**
 * The set of saliences the player's actions carried this turn (presence-spec
 * §witness sets). The baseline is `obvious/quiet` — a plainly visible turn —
 * unless the player declared stealth AND there is someone present to hide from
 * (a co-located non-user participant not named/targeted in the input), in which
 * case the baseline is concealed. Each player-actor item/activity event that
 * tagged its own salience joins the set; untagged events fall back to the
 * baseline. Returns at least the baseline.
 */
export function turnSalienceSet(input: {
  inputText: string;
  /** Saliences explicitly tagged on the player's own item/activity events. */
  explicit: readonly Salience[];
  /** A co-located non-user participant is present who is NOT named/targeted in the input. */
  hasConcealmentTarget: boolean;
}): Salience[] {
  const baseline =
    hasStealthMarker(input.inputText) && input.hasConcealmentTarget ? concealedSalience() : defaultSalience();
  const set: Salience[] = [baseline];
  const seen = new Set<string>([`${baseline.visual}::${baseline.audible}`]);
  for (const s of input.explicit) {
    const key = `${s.visual}::${s.audible}`;
    if (seen.has(key)) continue;
    seen.add(key);
    set.push(s);
  }
  return set;
}

// Witness set (presence-and-perception-spec §witness sets) + the camera-following
// runtime pieces (visited locations, encountered participants, last-interacted).
export function phaseWitness(ctx: PhaseContext, state: WorkingState): void {
  const { reconcile, bundle, turn, simulant, sink } = ctx;
  const player = state.player;
  const witnessLoc = player?.locationId ?? activeLocationId({ participants: state.participants, locations: bundle.locations });
  const coLocatedNpcs = state.participants.filter((p) => !p.isUser && p.locationId !== null && p.locationId === witnessLoc);

  // Targeted interactions (decision: co-presence alone never counts):
  // intent-detected targets, the speaking NPC on companion turns, and
  // co-located NPCs addressed by name in the player's input. Computed here so
  // both the witness perception read (engagedWithActor) and the
  // lastInteractedTurn follow-score recency can reuse it.
  const interacted = new Set<string>();
  if (!reconcile) {
    if (turn.author === "player") {
      const intent = detectIntent(turn.input, coLocatedNpcs.map((p) => p.displayName), []);
      for (const name of [intent.lookTarget, intent.touchTarget, intent.smellTarget, intent.tasteTarget]) {
        if (!name) continue;
        const target = findParticipant(name, state.participants);
        if (target && !target.isUser) interacted.add(target.id);
      }
      for (const npc of coLocatedNpcs) {
        if (mentionsParticipant(turn.input, npc)) interacted.add(npc.id);
      }
    }
    if (turn.author === "companion" && turn.speakerParticipantId) interacted.add(turn.speakerParticipantId);
  }
  ctx.interacted = interacted;

  // Witness set: the placed player plus every co-located NPC who perceived a
  // salient action this turn. Falls back to interim co-location semantics when
  // there is no placed player to anchor the turn's salience on. One set per
  // turn, stamped on every draft.
  ctx.witnessedBy = computeWitnessSet({
    player,
    coLocatedNpcs,
    witnessLoc,
    parts: state.participants,
    simulant,
    turn,
    interacted,
    witnessLight: witnessLoc ? bundle.locations.find((l) => l.id === witnessLoc)?.ambient?.light : undefined,
    // Turn-START clock for darkness, matching the pre-turn awareness blocks.
    band: daylightBand(resolveGameTime(bundle.clockMinutes, bundle.style.calendarStart)),
    sink,
  });
  for (const draft of ctx.factDrafts) draft.witnessedBy = ctx.witnessedBy;

  // Runtime: visited locations + encountered participants follow the camera.
  const finalActiveLoc = player?.locationId ?? activeLocationId({ participants: state.participants, locations: bundle.locations });
  const visited = new Set(bundle.runtime.visitedLocationIds);
  if (finalActiveLoc) visited.add(finalActiveLoc);
  const encountered = new Set(bundle.runtime.encounteredParticipantIds);
  for (const p of state.participants) {
    if (!p.isUser && p.locationId !== null && p.locationId === finalActiveLoc) encountered.add(p.id);
  }
  ctx.visitedLocationIds = [...visited];
  ctx.encounteredParticipantIds = [...encountered];

  const lastInteractedTurn = { ...bundle.runtime.lastInteractedTurn };
  for (const id of interacted) lastInteractedTurn[id] = turn.number;
  ctx.lastInteractedTurn = lastInteractedTurn;
}

/**
 * Compute this turn's witness set (presence-and-perception-spec §witness sets).
 * Gathers the saliences the player's salient actions carried, then asks
 * `perceives` per co-located NPC whether any of them got through their
 * attention/conditions/darkness. Result = the placed player + every NPC who
 * perceived. Degrades to interim co-location semantics when no placed player
 * anchors the turn (a companion/director turn with no embodied player). Pushes
 * `merge.perception.darkness_miss` (info) for ambiguous ambient light; never throws.
 */
function computeWitnessSet(input: {
  player: WorkingParticipant | null;
  coLocatedNpcs: readonly WorkingParticipant[];
  witnessLoc: string | null;
  parts: readonly WorkingParticipant[];
  simulant: SimulantResult;
  turn: MergeTurn;
  interacted: ReadonlySet<string>;
  witnessLight: string | undefined;
  band: DaylightBand;
  sink: DiagnosticSink;
}): string[] {
  const { player, coLocatedNpcs, witnessLoc, parts, simulant, turn, interacted, witnessLight, band, sink } = input;

  // No placed player to anchor the turn's salience on: fall back to the interim
  // co-location stamp (everyone at the witness location perceives).
  if (!player || player.locationId === null) {
    return parts.filter((p) => p.locationId !== null && p.locationId === witnessLoc).map((p) => p.id);
  }

  // Saliences explicitly tagged on the player's own item/activity events.
  const explicit: Salience[] = [];
  for (const e of simulant.itemEvents) {
    if (!e.salience) continue;
    const actor = e.byName ? findParticipant(e.byName, parts) : player;
    if (actor?.id === player.id) explicit.push(e.salience);
  }
  for (const u of simulant.activityUpdates) {
    if (!u.salience) continue;
    if (findParticipant(u.participantName, parts)?.id === player.id) explicit.push(u.salience);
  }

  // Concealment target: a co-located NPC NOT named/targeted in the input — so a
  // stealth marker actually has someone to hide from (intimate "quietly" to the
  // only person present is tone, not a sneak).
  const hasConcealmentTarget = coLocatedNpcs.some(
    (npc) => !interacted.has(npc.id) && !mentionsParticipant(turn.input, npc),
  );
  const salienceSet = turnSalienceSet({ inputText: turn.input, explicit, hasConcealmentTarget });

  const darkness = darknessVerdict(band, witnessLight);
  if (darkness.miss) {
    sink.push(
      diag("info", "merge.perception.darkness_miss", `ambient light "${witnessLight ?? ""}" matched no keyword — defaulting dark`, {
        context: { locationId: witnessLoc, light: witnessLight ?? null },
      }),
    );
  }

  const witnessIds: string[] = [player.id];
  for (const npc of coLocatedNpcs) {
    const attention = deriveAttention({ activity: npc.state.activity, posture: npc.state.posture });
    const engagedWithActor =
      attention.state === "engaged_with" &&
      (interacted.has(npc.id) || mentionsActorFirstName(npc.state.activity, player));
    const observer = { attention: attention.state, facesAway: attention.facesAway, engagedWithActor };
    const mods = { dark: darkness.dark, ...senseModsFromConditions(npc.state.conditions) };
    if (salienceSet.some((s) => perceives(observer, s, mods))) witnessIds.push(npc.id);
  }
  return witnessIds;
}

/** Does the NPC's activity text mention the player's first name (whole-word, ci)? */
function mentionsActorFirstName(activity: string, player: WorkingParticipant): boolean {
  const first = (player.displayName.split(/\s+/)[0] ?? player.displayName).trim().toLowerCase();
  if (!first) return false;
  const re = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(activity.toLowerCase());
}

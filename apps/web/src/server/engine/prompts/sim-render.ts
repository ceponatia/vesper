import { formatStoryMoment } from "@/contracts/turns/chat-clock";
import { dispositionBands, effectiveTraitValue, traitRegistry } from "@/contracts/personality/traits";
import { regardBandForValue, familiarityBandForValue } from "@/contracts/relationships/bands";
import {
  formatStoryClock,
  storyCalendarParams,
  storyClockAt,
  type SimCalendarStart,
} from "@/lib/simulation/clock";
import { humanizeActivity, humanizeId } from "@vesper/simulation-core/humanize";
import { lifeStageForAge } from "@/contracts/world/life-stage";
import { formatAge, type CharacterProfile } from "@/contracts/world/profile";
import { speciesLorePhrase } from "@/contracts/species";
import type { NarrativeCut } from "@vesper/simulation-core/contracts/narrative";
import {
  renderNarratorPrompt,
  type NarratorInstructionSource,
  type NarratorPromptGroup,
  type NarratorPromptNode,
} from "@/contracts/narrator-prompts";
import { DEFAULT_NARRATION_SHAPE, type NarrationShapeId } from "./constants";
import { fenceUntrusted } from "./untrusted";
import {
  attributionTagNode,
  buildLifeStageSection,
  cameraViewpointNode,
  contentFramingNode,
  intimateCraftNode,
  messageNotationNode,
  narratorBehaviorSlot,
  narratorCameraNode,
  narratorRenderMode,
  naturalDialogueNode,
  noRefusalNode,
  promptLiteral,
  promptUnit,
  proportionalityNode,
  readingPlayerMessageNode,
  shapingNode,
  topicDisciplineNode,
  untrustedDataNoticeNode,
} from "./charter";
import {
  buildBioSection,
  buildMicroExemplarsSection,
  buildPreferencesSection,
  buildVoiceAnchorsSection,
} from "./profile-sections";

/**
 * The successor (simulated-world) narrator's prompt builder
 * (presentation-charter.plan.md slice 2). It replaces `buildCutRenderPrompt` in
 * `lib/simulation/presentation.ts`: a committed cut plus the successor
 * presentation context (authored profile, persona, projections, conversation)
 * assembled into the SAME craft law the legacy chat narrator obeys — via the
 * shared charter — rather than a bare serialization of the cut (the R2
 * prototype's flaw the plan repairs).
 *
 * Pure and snapshot-testable, like `character-chat.ts`; no IO. Two viewpoints
 * are kept explicitly distinct: the EPISTEMIC viewpoint (whose knowledge
 * partitions the cut — the player actor, unchanged) and the PROSE CAMERA (the
 * charter's law: third person for the primary character, second person "you" for
 * the player). Every raw id is kept out of the prose surface: mustEnact beats and
 * armed effects become opaque handles (B1…, E1…) that `parseNarratorResult` maps
 * back to real ids at the §23.1 trust boundary, so no id ever needs to appear in
 * the reply and a leak is auditable.
 */

/** The banded relationship read the exchange layer supplies (mirrors `SimChatRelationship`). */
export interface SimRenderRelationship {
  /** −100..100, derived from the §21 ledger (never shown as a number). */
  regard: number;
  /** 0..100 — authored-prior floor + accumulated dyad evidence (never shown as a number). */
  familiarity: number;
}

/**
 * Everything one successor render may present. A superset of the legacy
 * `CutRenderConversation`: every field the exchange layer passes today
 * (playerUtterance … memory) keeps its name and type, and the added authored /
 * projection fields are all OPTIONAL with degraded defaults (docs/resilience.md)
 * so an unwired caller still builds a valid — if thinner — prompt.
 */
export interface SimRenderContext {
  /** The viewpoint (player) actor's words/intent THIS turn — presentation input only. */
  playerUtterance?: string;
  /**
   * The composer's Narrator input mode (`meta.inputMode === "narrator"`): the
   * player's line is STORY NARRATION written as the storyteller, not the
   * player-character speaking or acting. Reframes THE PLAYER'S TURN block as
   * steering the scene rather than a first-person act.
   */
  narratorInput?: boolean;
  /** Recent dialogue, oldest first, for conversational continuity. */
  dialogueTail?: readonly { speaker: string; text: string }[];
  /**
   * True when the viewpoint actor is PLAYER-CONTROLLED: the narrator never
   * authors their dialogue/decisions/feelings, and their self bodily reads are
   * withheld — the player's inner life belongs to the player.
   */
  viewpointIsPlayer?: boolean;
  /** Display names by actor id — ids never read well in prose. */
  actorNames?: Record<string, string>;
  /** The world's calendar anchor (R5 time domain, ruling 17); null ⇒ "Day N" display. */
  calendarStart?: SimCalendarStart | null;
  /** A command the player's own words already executed in world truth this turn. */
  admittedAction?: string;
  /** The rolling conversation summary (the chat-lane fold) — context, never new facts. */
  conversationSummary?: string;
  /** §24 viewpoint-scoped recall lines, already perception-partitioned and epistemic-labeled. */
  memory?: readonly string[];
  /** The primary character's authored profile — the source of the AUTHORED CANON block. */
  primary?: { name: string; profile: CharacterProfile };
  /** The resolved persona the player is playing as (no wardrobe/exposure in v1). */
  player?: { name: string; persona?: string; voice?: string; intimacy?: string };
  /** The R5 sim wardrobe projection (`readSimChatOutfit`), pre-formatted; "" ⇒ no line. */
  outfitLine?: string;
  /** The §21 ledger read (`readSimChatRelationship`) — rendered as prose framing, never numbers. */
  relationship?: SimRenderRelationship;
  /** Zone display names by zone id; a missing id is humanized from the id itself. */
  zoneNames?: Record<string, string>;
  /** Active narration shape; defaults to DEFAULT_NARRATION_SHAPE. */
  narrationShape?: NarrationShapeId;
  /**
   * Whose narrator instructions this render follows (narrator-prompt-lab.plan.md
   * §Narrator instruction source). Inherited by `SimSoloRenderContext`, so leaving the
   * primary's physical scene cannot silently switch the conversation back to production
   * instructions.
   *
   * Absent or `production` ⇒ byte-identical to today. A `test` source replaces the
   * craft layer only: the committed cut, the deterministic handles, the strict JSON
   * schema and the correction block are untouchable by construction.
   */
  instructionSource?: NarratorInstructionSource;
}

/** A per-attempt correction (attempt ≥2), naming exactly what the previous audit rejected. */
export interface SimRenderCorrection {
  /** Required beats the previous prose did not enact, as their handles + summaries. */
  missingBeats?: readonly { handle: string; summary: string }[];
  /** The previous prose leaked a handle or id into the story surface. */
  leaked?: boolean;
  /** The previous prose was a placeholder, JSON, or contract-field echo. */
  contractEcho?: boolean;
  /** The previous prose was empty. */
  emptyProse?: boolean;
}

/** handle → real event/effect id, deterministic per cut (the §23.1 mapping vocabulary). */
export type SimHandleMap = Record<string, string>;

interface BeatHandle {
  handle: string;
  eventId: string;
  summary: string;
}
interface EffectHandle {
  handle: string;
  id: string;
  effectType: string;
  actorId: string;
  targetActorIds: readonly string[];
  detail: string;
}

/**
 * Deterministic handle assignment: B-handles over mustEnact (in order) then
 * allowedTransitions (continuing the sequence), E-handles over armedEffects (in
 * order). Same cut ⇒ same handles, so `sim-narrator` can rebuild the map to
 * translate the model's declared handles back to real ids.
 */
function buildSimHandles(cut: NarrativeCut): { beats: BeatHandle[]; effects: EffectHandle[] } {
  const beats: BeatHandle[] = [];
  let n = 0;
  for (const beat of cut.mustEnact) {
    n += 1;
    beats.push({ handle: `B${n}`, eventId: beat.eventId, summary: beat.summary });
  }
  for (const beat of cut.allowedTransitions) {
    n += 1;
    beats.push({ handle: `B${n}`, eventId: beat.eventId, summary: beat.summary });
  }
  const effects = cut.armedEffects.map((effect, index) => ({
    handle: `E${index + 1}`,
    id: effect.id,
    effectType: effect.effectType,
    actorId: effect.actorId,
    targetActorIds: effect.targetActorIds,
    detail: effect.detail,
  }));
  return { beats, effects };
}

/** The handle → real-id map for one cut (B-handles then E-handles). */
export function buildSimHandleMap(cut: NarrativeCut): SimHandleMap {
  const { beats, effects } = buildSimHandles(cut);
  const map: SimHandleMap = {};
  for (const beat of beats) map[beat.handle] = beat.eventId;
  for (const effect of effects) map[effect.handle] = effect.id;
  return map;
}

/** The beat handles (mustEnact then allowedTransitions) — the render loop maps a missing event id to its handle for the correction. */
export function beatHandlesForCut(cut: NarrativeCut): { handle: string; eventId: string; summary: string }[] {
  return buildSimHandles(cut).beats;
}

/** A zone's display name: the supplied map, else the humanized id (never the raw id). */
function zoneLabel(zoneId: string, zoneNames: Record<string, string> | undefined): string {
  const named = zoneNames?.[zoneId]?.trim();
  return named && named.length > 0 ? named : humanizeId(zoneId);
}

/** A belief's claimed value as readable text (a bare string as-is, else JSON). */
function renderClaimedValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A pressure's deadline as legible relative story time, never "act by second N". */
function relativePressureTime(deltaSeconds: number): string {
  if (deltaSeconds <= 0) return "now — it is already due";
  if (deltaSeconds < 20 * 60) return "within about ten minutes";
  if (deltaSeconds < 90 * 60) return "within about an hour";
  if (deltaSeconds < 6 * 3_600) return "within a few hours";
  if (deltaSeconds < 24 * 3_600) return "later today";
  if (deltaSeconds < 48 * 3_600) return "by tomorrow";
  return "in the next few days";
}

/** The legible world-clock label (calendar anchor when present, else "Day N"). */
export function worldClockLabel(fromStorySecond: number, calendarStart: SimCalendarStart | null): string {
  if (calendarStart === null) return formatStoryClock(storyClockAt(fromStorySecond));
  const params = storyCalendarParams(fromStorySecond, calendarStart);
  return formatStoryMoment(params.clockMinutes, params.calendarStart);
}

/** Block 1 — ROLE & SAFETY (content framing, camera law, no-refusal, perception). */
function buildRoleNode(args: {
  primaryName: string;
  playerName: string;
  minor: boolean;
}): NarratorPromptGroup {
  const { primaryName, playerName, minor } = args;
  return simBlock("sim_role_block", [
    promptLiteral("ROLE & SAFETY"),
    contentFramingNode(minor),
    untrustedDataNoticeNode(),
    noRefusalNode({ characterName: primaryName }),
    // Epistemic viewpoint (what may be known) is the player actor and stays that way;
    // the PROSE CAMERA is the charter's — third person for the character, second for the player.
    // The partition is an EPISTEMIC law, not a camera preference, so it never moves.
    promptUnit(
      "knowledge_partition",
      "runtime_invariant",
      `The scene's knowledge is partitioned to ${playerName} (the player's character): only what ${playerName} could perceive or already knows is on the page. But the prose CAMERA is fixed by the rules below — the story is told about ${primaryName} in the third person and to ${playerName} in the second person.`,
    ),
    cameraViewpointNode({ characterName: primaryName, playerName }),
    narratorCameraNode({ characterName: primaryName, player: playerName }),
    readingPlayerMessageNode({ characterName: primaryName, player: playerName }),
  ]);
}

/**
 * The successor lane's block join: `"\n\n"` with empties dropped, exactly the
 * `.filter(Boolean).join("\n\n")` every block already used.
 */
export function simBlock(id: string, children: readonly NarratorPromptNode[]): NarratorPromptGroup {
  return { kind: "group", id, separator: "\n\n", dropEmpty: true, children };
}

/** Block 2 — AUTHORED CANON (the primary's profile + the player persona). Shared with the solo cut. */
export function buildCanonBlock(args: {
  primaryName: string;
  playerName: string;
  profile: CharacterProfile | undefined;
  player: SimRenderContext["player"];
  minor: boolean;
}): string {
  const { primaryName, playerName, profile, player, minor } = args;
  const sections: string[] = ["AUTHORED CANON"];

  if (profile) {
    const age = formatAge(profile.age);
    const lifeStage = lifeStageForAge(profile.age);
    const species = speciesLorePhrase(profile.speciesId, profile.heritageId);
    const identity = [
      `The character in this scene is ${primaryName}.`,
      age ? `${primaryName} is ${age}${lifeStage?.promptHint ? ` — ${lifeStage.promptHint}` : ""}.` : "",
      species ? `Species: ${species}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    sections.push(identity);
    sections.push(buildBioSection(profile.bio));

    // Disposition bands (the shared `dispositionBands` renderer, third-person heading
    // like the ensemble sheet). Intimate bands are minor-fenced.
    const everyday = dispositionBands(traitRegistry, profile.traits, { intimateOnly: false });
    const intimate = minor ? [] : dispositionBands(traitRegistry, profile.traits, { intimateOnly: true });
    if (everyday.length) {
      sections.push(
        [
          `Disposition (how ${primaryName} actually behaves — let it pull on what ${primaryName} says and does, never recite it):`,
          ...everyday.map((band) => `- ${band}`),
          ...(intimate.length
            ? [`When the moment turns intimate, these also drive ${primaryName}:`, ...intimate.map((band) => `- ${band}`)]
            : []),
        ].join("\n"),
      );
    }
    sections.push(buildVoiceAnchorsSection(profile.voiceAnchors));
    sections.push(buildMicroExemplarsSection(profile.microExemplars));
    sections.push(buildPreferencesSection(profile.preferences, playerName, minor));
    sections.push(buildLifeStageSection(lifeStage));
  }

  // The player persona (mirrors the legacy `buildPlayerSections` wording). Fenced —
  // author-written, therefore untrusted. Intimacy is minor-fenced.
  const persona = player?.persona?.trim();
  if (persona) {
    sections.push(`About ${playerName} (the person the scene is with):\n${fenceUntrusted("the person you're speaking with", persona)}`);
  }
  const voice = player?.voice?.trim();
  if (voice) {
    sections.push(`How ${playerName}'s voice sounds (you describe it; you never write their lines):\n${fenceUntrusted("player voice", voice)}`);
  }
  const intimacy = player?.intimacy?.trim();
  if (intimacy && !minor) {
    sections.push(`What ${playerName} responds to — play toward it when a scene turns intimate:\n${fenceUntrusted("player intimate preferences", intimacy)}`);
  }

  return sections.filter(Boolean).join("\n\n");
}

/** Block 3 — COMMITTED TRUTH (the cut, id-free: display names, handles, English claims). */
function buildTruthBlock(args: {
  cut: NarrativeCut;
  context: SimRenderContext;
  beats: readonly BeatHandle[];
  effects: readonly EffectHandle[];
  nameOf: (actorId: string) => string;
}): string {
  const { cut, context, beats, effects, nameOf } = args;
  const zoneNames = context.zoneNames;
  const lines: string[] = ["COMMITTED TRUTH — everything below already happened; render it, never change it."];

  lines.push(
    `WORLD CLOCK: ${worldClockLabel(cut.fromStorySecond, context.calendarStart ?? null)} — world truth. Light, meals, fatigue, and`,
    "all time-of-day color follow this clock. If earlier prose implies a different",
    "time of day, the clock wins — shift naturally, never remark on the correction.",
  );

  if (cut.currentLoci.length > 0) {
    lines.push(
      "SCENE — who is physically here:",
      ...cut.currentLoci.map((locus) => {
        const where = locus.kind === "in_transit" ? "in transit" : locus.zoneId ? `at the ${zoneLabel(locus.zoneId, zoneNames)}` : "here";
        return `- ${nameOf(locus.actorId)}: ${where}`;
      }),
    );
  }

  if (cut.currentActivities.length > 0) {
    lines.push(
      "VISIBLE ACTIVITIES:",
      ...cut.currentActivities.map(
        (activity) => `- ${activity.actorIds.map(nameOf).join(", ")}: ${humanizeActivity(activity.actionDefinitionId)} (${activity.phase})`,
      ),
    );
  }

  lines.push(
    "MUST ENACT — enact each of these beats exactly once, in meaning, and list its handle in `enactedBeatEventIds`:",
    ...(beats.length > 0 && cut.mustEnact.length > 0
      ? beats.slice(0, cut.mustEnact.length).map((beat) => `- ${beat.handle}: ${beat.summary}`)
      : ["- (none this turn)"]),
  );

  const transitions = beats.slice(cut.mustEnact.length);
  if (transitions.length > 0) {
    lines.push(
      "MAY PORTRAY — already-resolved; never invent new outcomes. If your prose portrays one, list its handle in `enactedBeatEventIds` too:",
      ...transitions.map((beat) => `- ${beat.handle}: ${beat.summary}`),
    );
  }

  lines.push(
    "FORBIDDEN — never state or imply:",
    ...(cut.forbiddenClaims.length > 0
      ? cut.forbiddenClaims.map((claim) => `- ${claim.claim}`)
      : ["- (no additional bans)"]),
  );

  if (effects.length > 0) {
    lines.push(
      "ARMED SPEECH ACTS — enact one ONLY if your prose delivers it in meaning; list the handles you enacted in `enactedArmedEffectIds`:",
      ...effects.map(
        (effect) =>
          `- ${effect.handle}: ${nameOf(effect.actorId)} to ${effect.targetActorIds.map(nameOf).join(", ")} — ${humanizeId(effect.effectType)} — ${effect.detail}`,
      ),
    );
  }

  if (cut.speakerBeliefs.length > 0) {
    const viewpointName = nameOf(cut.viewpointActorId);
    lines.push(
      context.viewpointIsPlayer
        ? `WHAT ${viewpointName} KNOWS OR BELIEVES (context — may be false, and is ${viewpointName}'s alone; never voice it for them):`
        : `WHAT ${viewpointName} BELIEVES (voiceable, may be false):`,
      ...cut.speakerBeliefs.map(
        (belief) => `- ${humanizeId(belief.propositionKey)}: ${renderClaimedValue(belief.claimedValue)} (${belief.status})`,
      ),
    );
  }

  if (cut.relevantPressures.length > 0) {
    const viewpointName = nameOf(cut.viewpointActorId);
    lines.push(
      `PRESSURES — ${viewpointName}'s own obligations (never state a clock time):`,
      ...cut.relevantPressures.map(
        (pressure) => `- ${pressure.severity}: needs to act ${relativePressureTime(pressure.actBy - cut.fromStorySecond)}`,
      ),
    );
  }

  // Bodily reads as English sentences. The viewpoint's OWN reads are withheld for a
  // player viewpoint (their inner life is theirs); observed signs name the actor.
  const observed = cut.bodilyReads.observed;
  const bodilySentences: string[] = [];
  if (!context.viewpointIsPlayer && cut.bodilyReads.self) {
    bodilySentences.push(
      `- ${nameOf(cut.viewpointActorId)}'s own body: energy is ${humanizeId(cut.bodilyReads.self.energyBand)}; ${humanizeId(cut.bodilyReads.self.intimacyPhase)}.`,
    );
  }
  for (const read of observed) {
    bodilySentences.push(`- ${nameOf(read.actorId)} shows ${read.signs.map(humanizeId).join(", ")}.`);
  }
  if (bodilySentences.length > 0) {
    lines.push("VISIBLE ON THE BODY (perceptible signs, never numbers):", ...bodilySentences);
  }

  return lines.join("\n");
}

/** Block 4 — SIM PRESENTATION STATE (outfit projection + relationship framing). Shared with the solo cut. */
export function buildPresentationStateBlock(args: {
  primaryName: string;
  playerName: string;
  outfitLine: string | undefined;
  relationship: SimRenderRelationship | undefined;
}): string {
  const { primaryName, playerName, outfitLine, relationship } = args;
  const lines: string[] = [];
  const outfit = outfitLine?.trim();
  if (outfit) {
    lines.push(`- ${primaryName} is wearing ${outfit} right now (world truth — whatever the story has said).`);
  }
  if (relationship) {
    const fam = familiarityBandForValue(relationship.familiarity).label.toLowerCase();
    const reg = regardBandForValue(relationship.regard).label.toLowerCase();
    lines.push(
      `- Where things stand between ${primaryName} and ${playerName}: they are ${fam} to each other, and ${primaryName} feels ${reg} toward ${playerName}. Let it color warmth and how much ${primaryName} gives — never state a number or a band name.`,
    );
  }
  if (lines.length === 0) return "";
  return ["SIM PRESENTATION STATE", ...lines].join("\n");
}

/**
 * Block 5 — CONVERSATION (volatile, every untrusted string fenced). Shared with
 * the solo cut. `soloAway` reframes the player-turn instruction (the primary is
 * NOT present to respond); `context.narratorInput` reframes the whole turn as
 * storyteller narration rather than the player-character acting.
 */
export function buildConversationBlock(args: {
  primaryName: string;
  playerName: string;
  context: SimRenderContext;
  /** The primary is elsewhere this turn (solo cut) — the player's line drives block (a), not a co-present reply. */
  soloAway?: boolean;
}): string {
  const { primaryName, playerName, context, soloAway } = args;
  const blocks: string[] = ["CONVERSATION"];

  const summary = context.conversationSummary?.trim();
  if (summary) {
    blocks.push(
      `CONVERSATION SO FAR (rolling summary — continuity context, never new world facts):\n${fenceUntrusted("conversation summary", summary)}`,
    );
  }

  const memory = (context.memory ?? []).map((line) => line.trim()).filter(Boolean).slice(0, 8);
  if (memory.length > 0) {
    blocks.push(
      `WHAT ${playerName} RECALLS (context, never new facts; beliefs may be false and are labeled):\n${fenceUntrusted("viewpoint memory", memory.join("\n"))}`,
    );
  }

  const tail = (context.dialogueTail ?? [])
    .filter((line) => line.text.trim().length > 0)
    .slice(-30)
    .map((line) => `- ${line.speaker}: ${line.text.length > 300 ? `${line.text.slice(0, 300)}…` : line.text}`);
  if (tail.length > 0) {
    blocks.push(
      "RECENT TRANSCRIPT (oldest first — continuity only, never new facts; if earlier NARRATION" +
        `\nwrongly spoke or felt for ${playerName}, that was an error — never imitate it):\n${fenceUntrusted("transcript", tail.join("\n"))}`,
    );
  }

  const admitted = context.admittedAction?.trim();
  if (admitted) {
    blocks.push(
      `PLAYER ACTION — already EXECUTED in world truth this turn. Portray it as DONE (never an attempt, never reversed):\n${fenceUntrusted("player action", admitted)}`,
    );
  }

  const utterance = context.playerUtterance?.trim();
  if (utterance) {
    const respondClause = soloAway
      ? `Continue block one — how ${playerName}'s own moment unfolds and how anyone present with them reacts`
      : `Render how ${primaryName} and the scene respond`;
    blocks.push(
      context.narratorInput
        ? [
            `THE PLAYER'S TURN — STORY NARRATION from ${playerName}, written as the storyteller, NOT ${playerName} speaking or acting:`,
            fenceUntrusted("player turn", utterance),
            `Everything it describes has happened in the story. ${respondClause}, and continue the scene from where it leaves off.`,
            `Do NOT reply as if ${playerName} said or did any of it, and do not re-narrate what it already establishes.`,
          ].join("\n")
        : [
            `THE PLAYER'S TURN — this drives the scene. ${playerName}'s words/action, verbatim:`,
            fenceUntrusted("player turn", utterance),
            `This is ${playerName} speaking/acting. Treat it as already performed exactly as stated — you may embed`,
            `their words verbatim, but NEVER add further dialogue, thoughts, feelings, decisions, or actions for`,
            `${playerName}. ${respondClause}. If it implies an action or outcome the`,
            "committed truth above does not establish, portray only the attempt or the words — never the unearned outcome.",
            "",
            `FINAL RULE — ${playerName} is the player's character. Their only words and actions this turn are the ones in`,
            `THE PLAYER'S TURN above, verbatim. Do not write any new dialogue, thought, feeling, or action for ${playerName}.`,
          ].join("\n"),
    );
  }

  return blocks.filter(Boolean).join("\n\n");
}

/** Block 6 — OUTPUT CONTRACT & CRAFT (charter craft + the field-by-field JSON contract). */
function buildOutputNode(args: {
  primaryName: string;
  playerName: string;
  shape: NarrationShapeId;
  dominance: number;
  minor: boolean;
}): NarratorPromptGroup {
  const { primaryName, playerName, shape, dominance, minor } = args;
  return simBlock("sim_output_block", [
    promptLiteral("OUTPUT CONTRACT & CRAFT"),
    // The craft layer of this lane is exactly this block, so the owner's
    // instructions open it — above the craft they replace, and above the JSON
    // contract they cannot.
    narratorBehaviorSlot("sim_narrator_behavior"),
    shapingNode({ characterName: primaryName, player: playerName, shape, dominance }),
    proportionalityNode(),
    topicDisciplineNode(),
    naturalDialogueNode({ characterName: primaryName }),
    attributionTagNode({ characterName: primaryName, player: playerName }),
    messageNotationNode({ characterName: primaryName, player: playerName, playerName }),
    intimateCraftNode({ characterName: primaryName, player: playerName }, minor),
    promptUnit(
      "strict_json_contract",
      "transport_contract",
      [
        "Return STRICT JSON with exactly these fields and NOTHING else:",
        "- prose: the reply — the scene as narrated, obeying every rule above. Story ONLY: no handle (B1, E1, …),",
        "  no id, and no field name from these instructions ever appears inside it.",
        '- enactedBeatEventIds: an array of the beat HANDLES (e.g. "B1") your prose actually enacted, in meaning; [] if none.',
        '- enactedArmedEffectIds: an array of the speech-act HANDLES (e.g. "E1") your prose actually delivered; [] if none.',
        "- proposedSoftCanon: [] unless you are proposing a small reusable detail; otherwise leave it empty.",
        "Handles (B1…, E1…) belong to those two id arrays ONLY — they must NEVER appear inside prose.",
      ].join("\n"),
    ),
  ]);
}

/**
 * The blocks outside the craft layer, as nodes.
 *
 * Deliberately ONE unit each rather than a sentence-level decomposition: none of
 * them is replaceable, so finer granularity would only add ids nothing reads.
 * `sim_conversation` takes `runtime_invariant` by the strictest-authority rule —
 * it is mostly context, but the FINAL RULE paragraph and the "NEVER add further
 * dialogue, thoughts, feelings, decisions, or actions" clause are player-agency
 * law, and a block is classified by the strictest thing in it.
 */
export function buildCanonNode(args: Parameters<typeof buildCanonBlock>[0]): NarratorPromptNode {
  return promptUnit("authored_canon", "runtime_context", buildCanonBlock(args));
}

export function buildPresentationStateNode(args: Parameters<typeof buildPresentationStateBlock>[0]): NarratorPromptNode {
  return promptUnit("sim_presentation_state", "runtime_context", buildPresentationStateBlock(args));
}

export function buildConversationNode(args: Parameters<typeof buildConversationBlock>[0]): NarratorPromptNode {
  return promptUnit("sim_conversation", "runtime_invariant", buildConversationBlock(args));
}

/** The per-attempt CORRECTION block (attempt ≥2) — names exactly what the last audit rejected. */
function buildCorrectionBlock(correction: SimRenderCorrection): string {
  const lines: string[] = ["CORRECTION — your previous attempt was rejected. Fix EXACTLY this, keep everything else:"];
  const missing = correction.missingBeats ?? [];
  if (missing.length > 0) {
    lines.push(
      `- You did not enact these required beats — enact each in meaning and list its handle in enactedBeatEventIds: ${missing
        .map((beat) => `${beat.handle} (${beat.summary})`)
        .join("; ")}`,
    );
  }
  if (correction.leaked) {
    lines.push("- Your prose contained a forbidden handle or id. NEVER write a handle (B1, E1, …) or id in prose — it is story only.");
  }
  if (correction.contractEcho) {
    lines.push("- Your prose was JSON, a placeholder, or echoed the contract's field names. Write the ACTUAL scene as prose.");
  }
  if (correction.emptyProse) {
    lines.push("- Your prose was empty. Write the scene the committed truth calls for.");
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/**
 * Build the successor narrator's system/prompt pair for one cut, plus the
 * deterministic handle map the trust boundary uses to translate declared handles
 * back to real ids. `opts.attempt` ≥2 with `opts.correction` appends a targeted
 * CORRECTION block (the render loop's feedback retry — the same persisted cut,
 * ruling 8 untouched).
 */
export function buildSimRenderPrompt(
  cut: NarrativeCut,
  context: SimRenderContext = {},
  opts: { attempt?: number; correction?: SimRenderCorrection } = {},
): { system: string; prompt: string; handleMap: SimHandleMap } {
  const prompt = renderNarratorPrompt(
    buildSimRenderPromptNodes(cut, context, opts),
    narratorRenderMode(context.instructionSource),
  );
  const system = SIM_RENDER_SYSTEM;
  return { system, prompt, handleMap: buildSimHandleMap(cut) };
}

/**
 * The classified node tree behind `buildSimRenderPrompt` — the same assembly, one
 * step before rendering, so provenance can weigh it per authority layer and a test
 * can assert which units an override keeps by id.
 */
export function buildSimRenderPromptNodes(
  cut: NarrativeCut,
  context: SimRenderContext = {},
  opts: { attempt?: number; correction?: SimRenderCorrection } = {},
): readonly NarratorPromptNode[] {
  const actorNames = context.actorNames ?? {};
  const nameOf = (actorId: string): string => actorNames[actorId] ?? actorId;

  const playerName = context.player?.name?.trim() || actorNames[cut.viewpointActorId] || "the player";
  const primaryName =
    context.primary?.name?.trim() ||
    Object.entries(actorNames).find(([id]) => id !== cut.viewpointActorId)?.[1] ||
    "the character";

  const profile = context.primary?.profile;
  const minor = profile ? (lifeStageForAge(profile.age)?.minor ?? false) : false;
  const shape = context.narrationShape ?? DEFAULT_NARRATION_SHAPE;
  const dominance = profile ? effectiveTraitValue(profile.traits, "social.dominance") : 0;

  const { beats, effects } = buildSimHandles(cut);

  const attempt = opts.attempt ?? 1;
  const correctionBlock = attempt >= 2 && opts.correction ? buildCorrectionBlock(opts.correction) : "";

  return [
    simBlock("sim_render_prompt", [
      buildRoleNode({ primaryName, playerName, minor }),
      buildCanonNode({ primaryName, playerName, profile, player: context.player, minor }),
      // The committed cut: the one thing the narrator may never change.
      promptUnit("committed_truth", "runtime_context", buildTruthBlock({ cut, context, beats, effects, nameOf })),
      buildPresentationStateNode({
        primaryName,
        playerName,
        outfitLine: context.outfitLine,
        relationship: context.relationship,
      }),
      buildConversationNode({ primaryName, playerName, context }),
      buildOutputNode({ primaryName, playerName, shape, dominance, minor }),
      // The retry correction names what the audit rejected — a machine contract.
      promptUnit("render_correction", "transport_contract", correctionBlock),
    ]),
  ];
}

/**
 * The successor system message. It states the committed-truth law that governs every
 * render, so it is `runtime_invariant` by nature and stays a plain string — there is
 * no craft in it for a test prompt to replace.
 */
const SIM_RENDER_SYSTEM = [
  "You are the narrator of a live scene in a committed simulated world. You render ONLY what the",
  "committed truth below establishes — you never move anyone, create objects, reveal knowledge, or",
  "decide outcomes; the world already happened and you are telling it. Every MUST ENACT beat appears",
  "exactly once, in meaning; nothing FORBIDDEN appears in any form; failed attempts show only their",
  "public face. Reply with the strict JSON object described at the end and nothing else — the reply's",
  "prose is story only, and no handle, id, or field name from these instructions ever appears in it.",
].join(" ");

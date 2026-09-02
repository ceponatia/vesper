import { effectiveTraitValue } from "@/contracts/personality/traits";
import { lifeStageForAge } from "@/contracts/world/life-stage";
import { buildSoloDepartureLine, type SoloDeparture } from "@vesper/simulation-core/departure";
import { placeAtPhrase, type SoloCutContext } from "@vesper/simulation-core/solo-cut";
import {
  renderNarratorPrompt,
  type NarratorPromptGroup,
  type NarratorPromptNode,
} from "@/contracts/narrator-prompts";
import { DEFAULT_NARRATION_SHAPE } from "./constants";
import {
  attributionTagNode,
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
  untrustedDataNoticeNode,
} from "./charter";
import {
  buildCanonNode,
  buildConversationNode,
  buildPresentationStateNode,
  buildVisualStateNode,
  simBlock,
  worldClockLabel,
  type SimRenderContext,
} from "./sim-render";

/**
 * The successor SOLO-cut narrator prompt.
 * When a turn runs WITHOUT a co-present primary, the render is dual-block: (a) a
 * second-person player-side block reacting to the player's own zone, and (b) a
 * third-person AWAY VIGNETTE of the primary living their routine, bounded by the
 * engine-supplied routine MUSTs. This builder assembles that prompt under the
 * SAME shared charter as the co-present builder (`sim-render.ts`) — reusing its
 * AUTHORED CANON, SIM PRESENTATION STATE, and CONVERSATION blocks verbatim — and
 * only replaces the COMMITTED TRUTH block with a SOLO SCENE block and the output
 * contract with a dual-block shaping instruction.
 *
 * Pure and snapshot-testable, like `sim-render.ts`; no IO. Every zone/actor
 * label arrives resolved (charter law — display labels, never raw ids); the two
 * blocks carry no handles because a solo cut enacts no beats or armed effects.
 */

export interface SimSoloRenderContext extends SimRenderContext {
  /** The advanced branch story-second — a solo cut has no NarrativeCut to read it from. */
  storySecond: number;
  /** The dual-block payload (player-side + optional away vignette). */
  solo: SoloCutContext;
  /**
   * The chosen departure this turn is (slice 4): the player just left a scene /
   * their zone and travelled here. Present ⇒ block (a) narrates the goodbye (when
   * a farewell), the walk, and the arrival as one continuous beat.
   */
  departure?: SoloDeparture;
}

/** Legible minutes-remaining for an in-transit ETA (floor "a moment"). */
function minutesLeft(seconds: number): string {
  if (seconds <= 0) return "arriving any moment";
  if (seconds < 60) return "under a minute";
  return `about ${Math.round(seconds / 60)} min`;
}

/** Block 1 — ROLE & SAFETY, solo framing (content framing, camera law, the two-block camera). */
function buildSoloRoleNode(args: { primaryName: string; playerName: string; minor: boolean }): NarratorPromptGroup {
  const { primaryName, playerName, minor } = args;
  return simBlock("solo_role_block", [
    promptLiteral("ROLE & SAFETY"),
    contentFramingNode(minor),
    untrustedDataNoticeNode(),
    noRefusalNode({ characterName: primaryName }),
    // World fact + knowledge partition + the two-block camera in one sentence. It
    // mixes, so the strictest authority wins: the narrator must not be able to lose
    // "the primary is not here" or "the player never perceives the glimpse" because a
    // test prompt rewrote the camera.
    promptUnit(
      "solo_scene_partition",
      "runtime_invariant",
      `This turn, ${primaryName} is NOT with ${playerName}. You tell it in two blocks: first ${playerName}'s own moment where they are (second person, "you"), then a brief glimpse of ${primaryName} elsewhere (third person). The scene's knowledge is partitioned to ${playerName} — but the away glimpse is for the reader, never something ${playerName} perceives.`,
    ),
    cameraViewpointNode({ characterName: primaryName, playerName }),
    narratorCameraNode({ characterName: primaryName, player: playerName }),
    readingPlayerMessageNode({ characterName: primaryName, player: playerName }),
  ]);
}

/** Block 3 — SOLO SCENE (replaces COMMITTED TRUTH): the player's side and the away vignette. */
function buildSoloSceneNode(args: {
  playerName: string;
  primaryName: string;
  storySecond: number;
  calendarStart: SimSoloRenderContext["calendarStart"];
  solo: SoloCutContext;
  departure?: SoloDeparture;
}): NarratorPromptGroup {
  const { playerName, primaryName, storySecond, calendarStart, solo, departure } = args;
  const { playerSide, vignette } = solo;
  // The block's own `join("\n\n")` becomes the group join; the sub-blocks keep the
  // authorities they actually carry rather than collapsing to one unit.
  const blocks: NarratorPromptNode[] = [
    promptUnit(
      "solo_scene_header",
      "runtime_invariant",
      "SOLO SCENE — everything below already happened in the world; render it, never change it.",
    ),
    promptUnit(
      "solo_world_clock",
      "runtime_context",
      `WORLD CLOCK: ${worldClockLabel(storySecond, calendarStart ?? null)} — world truth; light and time-of-day follow it.`,
    ),
  ];

  // A chosen departure (slice 4): block (a) tells the whole arc — goodbye (when a
  // scene was ended), the walk, and the arrival — as one continuous beat.
  const departureLine = departure ? buildSoloDepartureLine({ departure, playerName }) : "";

  const whereLine = playerSide.inTransit
    ? `${playerName} is on the move${playerSide.transitToLabel ? ` toward the ${playerSide.transitToLabel}` : ""}${
        playerSide.arrivesInSeconds === undefined ? "" : ` — ${minutesLeft(playerSide.arrivesInSeconds)} to go`
      }.`
    : `${playerName} is ${placeAtPhrase(playerSide.zoneLabel)}.`;
  const hereLine =
    playerSide.coPresent.length > 0
      ? `Here with ${playerName}: ${playerSide.coPresent
          .map((actor) => (actor.activity ? `${actor.name} (${actor.activity})` : actor.name))
          .join("; ")}.`
      : `No one else is here with ${playerName} right now.`;
  const holdLine =
    playerSide.heldItems.length > 0 ? `In ${playerName}'s hands: ${playerSide.heldItems.join(", ")}.` : "";
  blocks.push(
    // Ends on the player-authorship law, so the whole sub-block is invariant.
    promptUnit(
      "solo_block_player_side",
      "runtime_invariant",
      [
        `BLOCK ONE — ${playerName}'s side, SECOND PERSON ("you"):`,
        ...(departureLine ? [`- ${departureLine}`] : []),
        `- ${whereLine}`,
        `- ${hereLine}`,
        ...(holdLine ? [`- ${holdLine}`] : []),
        `Show what ${playerName} sees and does and how anyone present reacts. Never speak, think, feel, or act FOR ${playerName} beyond their own words this turn.`,
      ].join("\n"),
    ),
  );

  if (vignette) {
    blocks.push(
      // The routine MUSTs and the "the player never perceives this" rule: world truth
      // plus a knowledge fence, never craft.
      promptUnit(
        "solo_block_away_vignette",
        "runtime_invariant",
        [
          `BLOCK TWO — an away glimpse of ${primaryName}, THIRD PERSON, somewhere else. These are TRUE and FIXED — color within them, never contradict them:`,
          ...vignette.routineMusts.map((must) => `- ${must}`),
          `Show ${primaryName} living this moment where they are, with whoever is around them. You may color it freely, but you CANNOT: move ${primaryName} to a different place, invent objects or events, have ${primaryName} wander off with no reason, or have ${primaryName} phone or text ${playerName} more than glancingly.`,
          `${primaryName} does NOT know what ${playerName} is doing. This glimpse is for the reader only — ${playerName} does not see or hear it.`,
        ].join("\n"),
      ),
    );
  }

  return simBlock("solo_scene_block", blocks);
}

/** Block 6 — OUTPUT CONTRACT & CRAFT (charter craft + the dual-block shaping + single-field JSON). */
function buildSoloOutputNode(args: {
  primaryName: string;
  playerName: string;
  shape: SimSoloRenderContext["narrationShape"];
  dominance: number;
  minor: boolean;
  hasVignette: boolean;
}): NarratorPromptGroup {
  const { primaryName, playerName, shape, dominance, minor, hasVignette } = args;
  return simBlock("solo_output_block", [
    promptLiteral("OUTPUT CONTRACT & CRAFT"),
    narratorBehaviorSlot("solo_narrator_behavior"),
    shapingNode({ characterName: primaryName, player: playerName, shape: shape ?? DEFAULT_NARRATION_SHAPE, dominance }),
    proportionalityNode(),
    naturalDialogueNode({ characterName: primaryName }),
    attributionTagNode({ characterName: primaryName, player: playerName }),
    messageNotationNode({ characterName: primaryName, player: playerName, playerName }),
    intimateCraftNode({ characterName: primaryName, player: playerName }, minor),
    // The dual-block instruction is part of the `prose` contract, not craft: the
    // normalizer and the audit both expect the two blocks in this shape.
    promptUnit(
      "solo_prose_contract",
      "transport_contract",
      [
        hasVignette
          ? `Write BLOCK ONE then BLOCK TWO as one flowing reply, with a clear paragraph break between ${playerName}'s side and the glimpse of ${primaryName}.`
          : `Write only BLOCK ONE — ${playerName}'s own moment.`,
        "Return STRICT JSON with exactly one field and NOTHING else:",
        "- prose: the reply as described above. Story ONLY: no id and no field name from these instructions ever appears inside it.",
      ].join("\n"),
    ),
  ]);
}

/** Build the solo-cut narrator's system/prompt pair. Pure — no IO. */
export function buildSimSoloRenderPrompt(context: SimSoloRenderContext): { system: string; prompt: string } {
  const prompt = renderNarratorPrompt(
    buildSimSoloRenderPromptNodes(context),
    narratorRenderMode(context.instructionSource),
  );

  const system = [
    "You are the narrator of a live scene in a committed simulated world. This turn the player's character is",
    "alone: you tell it in TWO blocks — the player's own moment in the second person, then a brief third-person",
    "glimpse of the other character elsewhere, living the routine the world has fixed for them. You never move",
    "that character, create objects or events, or let the player perceive the glimpse. Reply with the strict JSON",
    "object described at the end and nothing else — the prose is story only, and no id or field name ever appears in it.",
  ].join(" ");

  return { system, prompt };
}

/**
 * The classified node tree behind `buildSimSoloRenderPrompt`. The solo lane honours
 * the SAME instruction source as the co-present lane (plan §Successor solo narrator):
 * walking out of the primary's scene must not quietly restore production craft.
 */
export function buildSimSoloRenderPromptNodes(context: SimSoloRenderContext): readonly NarratorPromptNode[] {
  const playerName = context.player?.name?.trim() || context.solo.playerName || "the player";
  const primaryName = context.primary?.name?.trim() || context.solo.primaryName || "the character";
  const profile = context.primary?.profile;
  const minor = profile ? (lifeStageForAge(profile.age)?.minor ?? false) : false;
  const dominance = profile ? effectiveTraitValue(profile.traits, "social.dominance") : 0;
  // Same node, same place in the order as the co-present builder. The solo turn
  // has no committed cut and no co-presence, so nothing populates it today; the
  // field is inherited from `SimRenderContext` and renders symmetrically the day
  // an away-glimpse owner does.
  const visualStateNode = buildVisualStateNode(context.visualState);

  return [
    simBlock("solo_render_prompt", [
      buildSoloRoleNode({ primaryName, playerName, minor }),
      buildCanonNode({ primaryName, playerName, profile, player: context.player, minor }),
      buildSoloSceneNode({
        playerName,
        primaryName,
        storySecond: context.storySecond,
        calendarStart: context.calendarStart ?? null,
        solo: context.solo,
        ...(context.departure ? { departure: context.departure } : {}),
      }),
      buildPresentationStateNode({
        primaryName,
        playerName,
        outfitLine: context.outfitLine,
        relationship: context.relationship,
      }),
      ...(visualStateNode === null ? [] : [visualStateNode]),
      buildConversationNode({ primaryName, playerName, context, soloAway: true }),
      buildSoloOutputNode({
        primaryName,
        playerName,
        shape: context.narrationShape,
        dominance,
        minor,
        hasVignette: context.solo.vignette !== undefined,
      }),
    ]),
  ];
}

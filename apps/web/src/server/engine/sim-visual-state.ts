import { asc, eq } from "drizzle-orm";
import {
  affordancePerceptionView,
  characterProfileSchema,
  commitVisualNarratorCueMentions,
  DiagnosticCollector,
  emptyCharacterProfile,
} from "@/contracts";
import type { CharacterProfile } from "@/contracts/world/profile";
import { parseOr } from "@/lib/parse";
import { characters, chatParticipants, db } from "@/server/db";
import {
  degradedVisualStatePreviewPayload,
  safeBuildVisualStateShadow,
  visualStatePreviewPayload,
  visualStateShadowLogSummary,
  type VisualStatePreviewPayload,
  type VisualStateShadowBuild,
  type VisualStateShadowInput,
} from "@/server/visual-state";
import { log } from "../log";
import { chatVisualStateNarrationOn } from "./chat-visual-state-flag";
import {
  renderChatVisualStateLines,
  visualStateGarmentNames,
  type ChatVisualStateLines,
} from "./chat-visual-state-cues";
import { chatVisualStateShadowEnabled } from "./prompts/constants";
import { readBranchClock } from "./sim-beats";
import { loadChatVisualCues, saveChatVisualCues, visualCueScopeKey } from "./visual-cue-store";

/**
 * The SUCCESSOR lane's visual-state glue: one committed branch cut → the shared
 * projection, the narrator's rendered constraint/cue pair, and the branch-scoped
 * cue state that pair advances.
 *
 * ## One input builder, three consumers
 *
 * `simVisualStateInput` is the lane's ONLY description of a successor cut, and
 * the live narration path, the deferred measurement shadow and the inspector
 * preview all take it. That is the point: an inspector that previewed an
 * assembly the render would not take, or a shadow measuring a cut the narrator
 * never saw, is worse than no measurement at all.
 *
 * ## What the successor can hand over, and what it cannot
 *
 * The authored profile (attributes, species realization) and the branch clock
 * are the owners this lane has. Wardrobe as a garment store, body-surface state,
 * chat-style conditions and scene relations have no successor producer, and no
 * adapter is synthesized from sim data to fake one: each absence is RECORDED by
 * the assembly as a `visual_state.source.unavailable` suppression, which is the
 * lane's missing-owner measurement rather than a gap in it. A missing owner
 * means silence, never a plausible replacement (docs/resilience.md).
 *
 * The successor perception view therefore asserts sight and NO exposure. Exposure
 * belongs to the wardrobe owner, and an unlisted body location reads `unknown`,
 * which fails the visibility read closed for every body-locus fact. Widening that
 * view by assertion — declaring bare skin visible because no wardrobe answered —
 * is exactly the invented replacement the projection exists to prevent, so the
 * lane stays honest and stays quiet until an exposure owner exists.
 *
 * ## Cue state
 *
 * Persisted in `chat_visual_cues` under the same store and the same
 * two-generation retake law the chat lane uses, keyed by the BRANCH
 * (`visualCueScopeKey`) rather than a memory group. The prompting id is the
 * committed cut id, so re-rendering one cut is a retake that reads the previous
 * generation and cannot advance visibility twice; a different branch id is a
 * different row, so a fork starts from empty state and can never inherit another
 * branch's later mentions.
 */

/** One successor cut, as this lane can read it without re-rendering. */
export interface SimVisualStateContext {
  readonly chatId: string;
  readonly branchId: string;
  readonly playerActorId: string;
  readonly primaryActorId: string;
  /** The committed cut this turn renders. */
  readonly cutId: string;
  readonly storySecond: number;
  /** The primary's authored profile; absent ⇒ nothing to project, the build is skipped. */
  readonly primary?: { readonly name: string; readonly profile: CharacterProfile } | undefined;
}

/**
 * The row identity this branch's cue state lives under: the branch key, the
 * player actor as the viewpoint, the primary actor as the subject.
 */
export function simVisualStateCueKey(context: {
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
}): { memoryGroupId: string; viewpointId: string; subjectId: string } {
  return {
    memoryGroupId: visualCueScopeKey({ kind: "world_branch", branchId: context.branchId }),
    viewpointId: context.playerActorId,
    subjectId: context.primaryActorId,
  };
}

/** The successor cut as a visual-state build input, or `null` when no profile loaded. */
export function simVisualStateInput(
  context: SimVisualStateContext,
): Omit<VisualStateShadowInput, "sink"> | null {
  const profile = context.primary?.profile;
  if (profile === undefined) return null;
  return {
    lane: "successor",
    scope: { kind: "world_branch", branchId: context.branchId },
    cutId: context.cutId,
    atMinutes: Math.max(0, Math.floor(context.storySecond / 60)),
    subjectId: context.primaryActorId,
    attributes: profile.attributes,
    realize: {
      ...(profile.speciesId === undefined ? {} : { speciesId: profile.speciesId }),
      ...(profile.heritageId === undefined ? {} : { heritageId: profile.heritageId }),
      ...(profile.bodyPlanId === undefined ? {} : { bodyPlanId: profile.bodyPlanId }),
      ...(profile.intimateRegions === undefined ? {} : { intimateRegions: profile.intimateRegions }),
      ...(profile.bodyFeatures === undefined ? {} : { bodyFeatures: profile.bodyFeatures }),
    },
    // The player is present in the scene; sight is the one channel this lane can
    // positively assert. No wardrobe model ⇒ no exposure entries, which fails
    // body-surface visibility closed — recorded, never guessed.
    perception: affordancePerceptionView({ exposure: {}, channels: { sight: "available" } }),
    // `playerSubjectId` is deliberately absent: it exists so player-WORN garments
    // and scene facts can file under a subject, and this lane owns neither. The
    // narrator renderer is told the player's subject id directly, which is where
    // it is actually used (naming "your" in a contact clause).
    observerId: context.playerActorId,
    observer: { kind: "actor", actorId: context.playerActorId },
  };
}

/**
 * The primary's digest → the two rendered blocks, or `null` when the selection
 * committed nothing this observer can be told about.
 *
 * Pure, and it borrows the CHAT lane's renderer rather than growing a second
 * phrasing of the same typed facts: the two lanes narrate one record, and a
 * successor turn that described a rolled sleeve differently from a chat turn
 * would be two answers to one question. A render failure is caught by the
 * caller — a block is never worth a turn.
 */
export function simVisualStateLines(
  build: VisualStateShadowBuild,
  subject: { primaryActorId: string; playerActorId: string; primaryName: string },
): ChatVisualStateLines | null {
  const digest = build.narrator.digests.find((entry) => entry.subjectId === subject.primaryActorId);
  if (digest === undefined) return null;
  const lines = renderChatVisualStateLines({
    digest,
    subject: {
      characterName: subject.primaryName,
      possessive: `${subject.primaryName}'s`,
      subjectId: subject.primaryActorId,
      playerSubjectId: subject.playerActorId,
    },
    garmentNames: visualStateGarmentNames(build.snapshot),
  });
  return lines.constraints.length === 0 && lines.cues.length === 0 ? null : lines;
}

/**
 * Build the projection for one cut against its stored cue state, and log the one
 * measurement line a successor turn emits. Writes nothing; `null` on any failure.
 */
async function buildSimVisualState(
  context: SimVisualStateContext,
  narration: boolean,
): Promise<VisualStateShadowBuild | null> {
  try {
    const input = simVisualStateInput(context);
    if (input === null) {
      log.info("engine.sim", "visual-state build skipped: no primary profile", { chatId: context.chatId });
      return null;
    }
    const sink = new DiagnosticCollector();
    // Loaded on BOTH arms. Ranking against the stored state is a READ, so even a
    // measurement run reports real repetition and real newly-visible counts;
    // only the WRITE waits on the narration switch.
    const cues = await loadChatVisualCues({
      ...simVisualStateCueKey(context),
      promptingMessageId: context.cutId,
      sink,
    });
    const build = safeBuildVisualStateShadow({ ...input, cues, sink }, sink);
    if (build !== null) {
      log.info("engine.sim", "visual-state build", {
        chatId: context.chatId,
        // Which arm produced this line: the deferred measurement run, or the
        // committable narration run. Only one of the two advances the cue state.
        narration,
        ...visualStateShadowLogSummary(build),
        codes: sink.items.map((entry) => entry.code),
      });
    } else {
      log.warn("engine.sim", "visual-state build degraded to nothing", {
        chatId: context.chatId,
        codes: sink.items.map((entry) => entry.code),
      });
    }
    return build;
  } catch (error) {
    log.error("engine.sim", "visual-state build failed", {
      chatId: context.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** What a switched-on turn carries to the narrator, and what it owes the store at settle. */
export interface SimVisualStateNarration {
  /** The rendered pair for the prompt; absent when nothing resolved this cut. */
  readonly lines?: ChatVisualStateLines;
  /**
   * Commit this cut's cue state. Call ONLY once the exchange has settled — a
   * failed render must leave the state exactly as the next take needs to find
   * it. A no-op when nothing built. Fenced: a persist failure costs a log line.
   */
  readonly commit: () => Promise<void>;
}

/**
 * The successor turn's LIVE visual-state leg, run on the turn's own path before
 * the narrator renders.
 *
 * `null` means this chat's per-chat switch is off (the default) — the caller
 * keeps today's deferred measurement shadow and the prompt is unchanged. It is
 * also the answer when the switch read itself fails, which is the conservative
 * direction.
 *
 * On the turn's own path and not deferred, deliberately: a deferred build cannot
 * be captured with the cut it describes, and a cue advance for an exchange that
 * never landed is exactly the retake impurity the two-generation store exists to
 * prevent.
 */
export async function loadSimVisualStateNarration(
  context: SimVisualStateContext & { primaryName: string },
): Promise<SimVisualStateNarration | null> {
  // PER CHAT, not per deploy. Fenced: a failed read answers "off", which leaves
  // the prompt byte-identical to today.
  const on = await chatVisualStateNarrationOn(context.chatId).catch((error: unknown) => {
    log.error("engine.sim", "visual-state narration switch read failed", {
      chatId: context.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  });
  if (!on) return null;

  const build = await buildSimVisualState(context, true);
  // Nothing built (no profile, or a degraded assembly): the turn renders on its
  // ordinary path and there is no state to advance — but this is still the
  // switched-ON answer, so the caller does not also fire the measurement shadow.
  if (build === null) return { commit: () => Promise.resolve() };

  let lines: ChatVisualStateLines | null = null;
  try {
    lines = simVisualStateLines(build, {
      primaryActorId: context.primaryActorId,
      playerActorId: context.playerActorId,
      primaryName: context.primaryName,
    });
  } catch (error) {
    // A rendering failure costs the block, never the turn (docs/resilience.md).
    log.error("engine.sim", "visual-state cue render failed", {
      chatId: context.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const commit = async (): Promise<void> => {
    try {
      await saveChatVisualCues({
        ...simVisualStateCueKey(context),
        promptingMessageId: context.cutId,
        // Visibility is persisted even when nothing was said: recording what was
        // in view is what makes the NEXT cut's newly-revealed answer correct, and
        // only a cue that entered the cut moves the cooldown.
        next: commitVisualNarratorCueMentions(
          build.narrator.cueStateAfterVisibility,
          build.narrator.cueMentionCommits,
          build.narrator.spokenRepeatKeys,
        ),
      });
    } catch (error) {
      log.error("engine.sim", "visual-state cue state persist failed", {
        chatId: context.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return { ...(lines === null ? {} : { lines }), commit };
}

/**
 * The successor turn's fenced MEASUREMENT hook, for a chat whose narration
 * switch is off: build beside the settled turn, log one line, write nothing.
 * Deferred off the critical path — the player waits for none of it — and any
 * failure degrades to a log line, so it can never cost the exchange.
 */
export async function runSimVisualStateShadow(context: SimVisualStateContext): Promise<void> {
  if (!chatVisualStateShadowEnabled()) return;
  await buildSimVisualState(context, false);
}

/**
 * The primary participant's authored profile — the same sort-0 query
 * `sim-exchange.ts` runs for its canon block, duplicated here so the preview
 * glue never imports the exchange module (which would close an import cycle
 * with the turn hook above).
 */
async function loadSimPreviewProfile(
  chatId: string,
): Promise<{ name: string; profile: CharacterProfile } | undefined> {
  const [row] = await db()
    .select({ name: characters.name, profile: characters.profile })
    .from(chatParticipants)
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .where(eq(chatParticipants.chatId, chatId))
    .orderBy(asc(chatParticipants.sort))
    .limit(1);
  if (!row) return undefined;
  const profile = parseOr(characterProfileSchema, row.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
  return { name: row.name, profile };
}

/**
 * A nonce prompting id for the inspector's cue read: it matches no cut's
 * `applied_message_id`, so the two-generation store always hands back the
 * CURRENT generation — what the narrator knows now — and, because the preview
 * never writes, the generations themselves never move.
 */
const VISUAL_STATE_PREVIEW_GUARD = "visual_state_preview";

/**
 * The read-only visual-state inspector payload for one SUCCESSOR chat: the same
 * build the live turn runs, recomputed on demand from the branch's current
 * clock, the primary's authored profile, and the branch's stored cue state — so
 * the preview's repetition and newly-visible counts are the real ones rather
 * than a first-ever look. Stores nothing and reports `CHAT_VISUAL_STATE_SHADOW`
 * rather than obeying it.
 */
export async function previewSimVisualState(input: {
  chatId: string;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
}): Promise<VisualStatePreviewPayload> {
  const sink = new DiagnosticCollector();
  const [primary, clock, cues] = await Promise.all([
    loadSimPreviewProfile(input.chatId),
    readBranchClock(input.branchId),
    loadChatVisualCues({
      ...simVisualStateCueKey(input),
      promptingMessageId: VISUAL_STATE_PREVIEW_GUARD,
      sink,
    }),
  ]);
  const previewInput = simVisualStateInput({
    chatId: input.chatId,
    branchId: input.branchId,
    playerActorId: input.playerActorId,
    primaryActorId: input.primaryActorId,
    cutId: VISUAL_STATE_PREVIEW_GUARD,
    storySecond: clock?.storySecond ?? 0,
    primary,
  });
  const build =
    previewInput === null ? null : safeBuildVisualStateShadow({ ...previewInput, cues, sink }, sink);
  if (build === null) {
    return degradedVisualStatePreviewPayload({
      lane: "successor",
      shadowFlagEnabled: chatVisualStateShadowEnabled(),
      diagnostics: sink.items,
    });
  }
  return visualStatePreviewPayload({
    build,
    shadowFlagEnabled: chatVisualStateShadowEnabled(),
    diagnostics: sink.items,
  });
}

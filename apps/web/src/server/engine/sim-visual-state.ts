import { asc, eq } from "drizzle-orm";
import {
  affordancePerceptionView,
  characterProfileSchema,
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
  type VisualStateShadowInput,
} from "@/server/visual-state";
import { log } from "../log";
import { chatVisualStateShadowEnabled } from "./prompts/constants";
import { readBranchClock } from "./sim-beats";

/**
 * The SUCCESSOR lane's visual-state shadow glue (visual-state.plan.md slice 6).
 *
 * The successor can hand the projection far less than the chat lane: the
 * authored profile (attributes, species realization) is the one visual owner
 * both lanes share, while wardrobe, body-surface, conditions, scene relations
 * and affordance observations have no successor producer wired here yet. Each
 * absence is RECORDED by the assembly as a `visual_state.source.unavailable`
 * suppression — that record is the lane's missing-owner measurement, not a gap
 * in it.
 *
 * Successor observer memory: none is persisted for the `world_branch` scope
 * yet, so the narrator selection runs against empty memory under a matching
 * branch-scoped binding — scope-consistent, read-only, and never written.
 */

/** One successor cut, as the shadow can read it without re-rendering. */
export interface SimVisualStateShadowContext {
  readonly chatId: string;
  readonly branchId: string;
  readonly playerActorId: string;
  readonly primaryActorId: string;
  /** The committed cut this turn rendered. */
  readonly cutId: string;
  readonly storySecond: number;
  /** The primary's authored profile; absent ⇒ nothing to project, shadow skipped. */
  readonly primary?: { readonly name: string; readonly profile: CharacterProfile } | undefined;
}

/** The successor cut as a shadow-build input, or `null` when no profile loaded. */
export function simVisualStateShadowInput(
  context: SimVisualStateShadowContext,
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
    observerId: context.playerActorId,
    observer: { kind: "actor", actorId: context.playerActorId },
  };
}

/**
 * The successor turn's fenced shadow hook: build beside the settled turn, log
 * one measurement line, write nothing. Any failure degrades to a log line and
 * can never cost the exchange (docs/resilience.md).
 */
export async function runSimVisualStateShadow(context: SimVisualStateShadowContext): Promise<void> {
  if (!chatVisualStateShadowEnabled()) return;
  try {
    const input = simVisualStateShadowInput(context);
    if (input === null) {
      log.info("engine.sim", "visual-state shadow skipped: no primary profile", { chatId: context.chatId });
      return;
    }
    const sink = new DiagnosticCollector();
    const build = safeBuildVisualStateShadow({ ...input, sink }, sink);
    if (build !== null) {
      log.info("engine.sim", "visual-state shadow", {
        chatId: context.chatId,
        ...visualStateShadowLogSummary(build),
        codes: sink.items.map((entry) => entry.code),
      });
    } else {
      log.warn("engine.sim", "visual-state shadow degraded to nothing", {
        chatId: context.chatId,
        codes: sink.items.map((entry) => entry.code),
      });
    }
  } catch (error) {
    log.error("engine.sim", "visual-state shadow failed", {
      chatId: context.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
 * The read-only visual-state inspector payload for one SUCCESSOR chat: the same
 * shadow build the flagged live turn runs, recomputed on demand from the
 * branch's current clock and the primary's authored profile. Stores nothing and
 * reports `CHAT_VISUAL_STATE_SHADOW` rather than obeying it.
 */
export async function previewSimVisualState(input: {
  chatId: string;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
}): Promise<VisualStatePreviewPayload> {
  const sink = new DiagnosticCollector();
  const [primary, clock] = await Promise.all([
    loadSimPreviewProfile(input.chatId),
    readBranchClock(input.branchId),
  ]);
  const shadowInput = simVisualStateShadowInput({
    chatId: input.chatId,
    branchId: input.branchId,
    playerActorId: input.playerActorId,
    primaryActorId: input.primaryActorId,
    cutId: "visual_state_preview",
    storySecond: clock?.storySecond ?? 0,
    primary,
  });
  const build = shadowInput === null ? null : safeBuildVisualStateShadow({ ...shadowInput, sink }, sink);
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

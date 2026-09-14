import { asc, eq } from "drizzle-orm";
import {
  affordancePerceptionView,
  characterProfileSchema,
  DiagnosticCollector,
  emptyCharacterProfile,
  type AffordanceExposure,
  type RegionCoverage,
  exposureRegionLocations,
  exposureRegionOrder,
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
import { readSimChatGarments, type SimChatGarments } from "./sim-surfaces";

/**
 * The SUCCESSOR lane's visual-state shadow glue.
 *
 * The successor can hand the projection far less than the chat lane: the
 * authored profile (attributes, species realization) and, since #297, the
 * primary's structured garment read (`readSimChatGarments`) are the visual
 * owners this lane has; body-surface conditions, scene relations and
 * affordance observations still have no successor producer wired here. Each
 * absence is RECORDED by the assembly as a `visual_state.source.unavailable`
 * suppression — that record is the lane's missing-owner measurement, not a gap
 * in it. The garment read only ever feeds the BODY-SURFACE exposure question
 * ("is skin visible here") — it is never turned into a garment-domain
 * observation of its own.
 *
 * Successor observer memory: none is persisted for the `world_branch` scope
 * yet, so the narrator selection runs against empty memory under a matching
 * branch-scoped binding — scope-consistent, read-only, and never written.
 */

/**
 * Region coverage as a body-surface exposure: bare skin is `visible` to sight,
 * a sheer covering only `hinted`, and an opaque one `hidden` — the same reading
 * the wardrobe garment domain gives for a garment's OWN surface
 * (`chat-garment-affordances.ts`'s `garmentExposure`), asked here for the
 * BODY instead. Which body locations a region stands for is the contract's
 * own table, read through `exposureRegionLocations` rather than copied.
 */
const AFFORDANCE_EXPOSURE_OF_REGION: Readonly<Record<RegionCoverage, AffordanceExposure>> = {
  bare: "visible",
  sheer: "hinted",
  covered: "hidden",
};

/**
 * The primary's #297 structured, reliable garment read as a body-surface
 * exposure map — `{}` (fails closed) for every other status, exactly the prior
 * `no wardrobe model` default. A mixed-reliability read (`reliable: false`)
 * stays `{}` too: its `exposure` is already the fully-covered default, and
 * echoing that here would assert "hidden" for locations the read could not
 * actually vouch for.
 */
function bodyExposureFromGarments(garments: SimChatGarments | undefined): Record<string, AffordanceExposure> {
  if (!garments || garments.status !== "structured" || !garments.reliable) return {};
  const exposure: Record<string, AffordanceExposure> = {};
  for (const region of exposureRegionOrder) {
    const band = AFFORDANCE_EXPOSURE_OF_REGION[garments.exposure[region]];
    for (const locationId of exposureRegionLocations(region)) exposure[locationId] = band;
  }
  return exposure;
}

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
  /** #297's structured garment read; absent or non-structured/unreliable ⇒ the fail-closed empty exposure. */
  readonly garments?: SimChatGarments | undefined;
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
    // positively assert. A structured, reliable garment read answers which body
    // locations are visible/hinted/hidden; anything else fails body-surface
    // visibility closed — recorded, never guessed.
    perception: affordancePerceptionView({
      exposure: bodyExposureFromGarments(context.garments),
      channels: { sight: "available" },
    }),
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
 * `sim-exchange/context.ts` runs for its canon block. The preview retains its
 * own read and failure handling; it does not resolve an exchange context.
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
  const [primary, clock, garments] = await Promise.all([
    loadSimPreviewProfile(input.chatId),
    readBranchClock(input.branchId),
    // Self-degrading (sim-surfaces' own guard); `null` reads as "absent" below,
    // same as every other optional field this preview assembles.
    readSimChatGarments(input.chatId),
  ]);
  const shadowInput = simVisualStateShadowInput({
    chatId: input.chatId,
    branchId: input.branchId,
    playerActorId: input.playerActorId,
    primaryActorId: input.primaryActorId,
    cutId: "visual_state_preview",
    storySecond: clock?.storySecond ?? 0,
    primary,
    ...(garments ? { garments } : {}),
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

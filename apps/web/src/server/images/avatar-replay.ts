import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";

/**
 * Same-composition retry eligibility (issue #248) — a PURE decision over a
 * source row's stored `meta`, the current render resolution, and (only for
 * the full, request-time check) the freshly compiled program's fingerprint.
 *
 * "Same composition" is a REPRODUCIBILITY REQUEST, never a pixel guarantee
 * (docs/images/providers/render-intents.md §Seeds and the render record):
 * replaying an explicit seed is honest reuse of the settings that produced the
 * source row, not a promise that the provider returns the same bytes. A
 * changed model or version, or a world that moved (appearance, wardrobe,
 * prompt) since the source rendered, must never pass silently as "the same
 * composition" — each fails the row BEFORE provider spend, naming why.
 *
 * Portraits send no references (every portrait profile's reference policy
 * allows none), so the issue's "missing reference" refusal arm is
 * structurally impossible on this lane — there is no reference to go missing.
 */

export const AVATAR_REPLAY_REFUSAL_REASONS = [
  "no_recorded_seed",
  "model_changed",
  "version_changed",
  "world_changed",
  "source_unavailable",
] as const;
export type AvatarReplayRefusalReason = (typeof AVATAR_REPLAY_REFUSAL_REASONS)[number];

/** The sentence a refusal fails the row with — also what the studio's disabled menu item explains. */
export const AVATAR_REPLAY_REFUSAL_TEXT: Record<AvatarReplayRefusalReason, string> = {
  no_recorded_seed: "this portrait was rendered without a seed; only a new variation is possible",
  model_changed: "the image model changed since this portrait was rendered, so the same composition is no longer available",
  version_changed: "the model version changed since this portrait was rendered, so the same composition is no longer available",
  world_changed: "the character's appearance, wardrobe or world state changed since this portrait was rendered, so the same composition is no longer available",
  source_unavailable: "this portrait is not available to replay",
};

export type AvatarReplayEligibility =
  | { readonly ok: true; readonly seed: number }
  | { readonly ok: false; readonly reason: AvatarReplayRefusalReason };

/**
 * The deliberately small slice of an `images` row this module reads — never
 * the whole drizzle row shape, so a caller (a fixture, a hand-built query
 * projection) never has to construct one it doesn't have.
 */
export interface AvatarReplaySourceRow {
  readonly id: string;
  readonly ownerId: string;
  readonly entityKind: string | null;
  readonly entityId: string | null;
  readonly kind: string;
  readonly status: string;
  readonly meta: unknown;
}

/** What the CURRENT render resolution says this replay would run under, if allowed. */
export interface AvatarReplayCurrentModel {
  readonly modelSlug: string;
  readonly profileId: string;
  /** `pinnedImageModelVersion(model)` for the CURRENT model — both null counts as equal. */
  readonly executedVersionId: string | null;
}

export interface AvatarReplayEligibilityInput {
  /** The row named by the retry request, or undefined for a missing/foreign id. */
  readonly source: AvatarReplaySourceRow | undefined;
  readonly ownerId: string;
  readonly characterId: string;
  readonly current: AvatarReplayCurrentModel;
  /**
   * The freshly compiled program's `promptProgram.programFingerprint`. Omit
   * this for the CHEAP, list-time check (seed recorded; model/profile/version
   * unchanged) — it cannot detect a changed appearance, wardrobe, or world
   * state without compiling a program, and that arm surfaces only at request
   * time, as the refused row's own error text, never a silent fallback to a
   * new variation.
   */
  readonly programFingerprint?: string;
}

/** `meta.render`, read loosely — a malformed or absent record reads as "nothing recorded" rather than throwing. */
const renderMetaSchema = z
  .object({
    seed: z.number().nullable().optional(),
    modelSlug: z.string().optional(),
    profileId: z.string().optional(),
    executedVersionId: z.string().nullable().optional(),
  })
  .catch({});

/** `meta.promptProgram`, read loosely for the one field this module compares. */
const promptProgramMetaSchema = z.object({ programFingerprint: z.string().optional() }).catch({});

function readMetaField(meta: unknown, key: string): unknown {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  return (meta as Record<string, unknown>)[key];
}

/**
 * The eligibility table (issue #248 acceptance #2–#3): whether replaying
 * `source` as "same composition" is honest for the CURRENT resolution, and
 * the seed to replay with when it is. Every refusal reason below is checked
 * in the order a caller should trust: a row that fails an earlier check never
 * reaches a later one that would need to read more of it.
 *
 * | condition (checked in this order)                                                   | result              |
 * | ------------------------------------------------------------------------------------ | ------------------- |
 * | row missing, foreign owner/character, not `avatar` kind, or not `ready`              | `source_unavailable`|
 * | `meta.render.seed` is not a number                                                   | `no_recorded_seed`  |
 * | `meta.render.modelSlug` or `.profileId` differ from the current resolution           | `model_changed`     |
 * | `meta.render.executedVersionId` differs from the current pinned/probed version       | `version_changed`   |
 * | (full check only) the freshly compiled program's fingerprint differs                 | `world_changed`     |
 * | everything above holds                                                               | `{ ok: true, seed }`|
 */
export function avatarReplayEligibility(input: AvatarReplayEligibilityInput): AvatarReplayEligibility {
  const { source, ownerId, characterId, current, programFingerprint } = input;
  if (
    source === undefined ||
    source.ownerId !== ownerId ||
    source.entityKind !== "character" ||
    source.entityId !== characterId ||
    source.kind !== "avatar" ||
    source.status !== "ready"
  ) {
    return { ok: false, reason: "source_unavailable" };
  }

  const render = renderMetaSchema.parse(readMetaField(source.meta, "render") ?? {});
  if (typeof render.seed !== "number") return { ok: false, reason: "no_recorded_seed" };

  const modelSlug = render.modelSlug ?? "";
  const profileId = render.profileId ?? "";
  if (modelSlug !== current.modelSlug || profileId !== current.profileId) {
    return { ok: false, reason: "model_changed" };
  }

  const executedVersionId = render.executedVersionId ?? null;
  if (executedVersionId !== current.executedVersionId) {
    return { ok: false, reason: "version_changed" };
  }

  if (programFingerprint !== undefined) {
    const promptProgram = promptProgramMetaSchema.parse(readMetaField(source.meta, "promptProgram") ?? {});
    if (promptProgram.programFingerprint !== programFingerprint) return { ok: false, reason: "world_changed" };
  }

  return { ok: true, seed: render.seed };
}

/**
 * Push the refused-replay diagnostic and return the sentence a row fails
 * with — the single call site both `generateAvatar`'s precondition and its
 * "never a silent fallback" rule share, so the diagnostic and the row's
 * failure text can never drift apart. Returns null for an eligible (or
 * unattempted, `eligibility: null`) replay, so a caller can fold it directly
 * into its precondition chain.
 */
export function avatarReplayPrecondition(
  eligibility: AvatarReplayEligibility | null,
  characterId: string,
  sink?: DiagnosticSink,
): string | null {
  if (eligibility === null || eligibility.ok) return null;
  const message = AVATAR_REPLAY_REFUSAL_TEXT[eligibility.reason];
  sink?.push(
    diag("warn", "images.avatar.replay_refused", message, {
      path: "images.avatar",
      context: { characterId, reason: eligibility.reason },
    }),
  );
  return message;
}

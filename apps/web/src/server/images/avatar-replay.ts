import { z } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";

/**
 * Same-composition retry eligibility (issue #248; correction round 2) — a
 * PURE decision over a source row's stored `meta`, the current render
 * resolution, and (only for the full, request-time check) the freshly
 * compiled program's fingerprint.
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
 *
 * The version check compares a PIN against a PIN, never a pin against a
 * provider echo: `current.pinnedVersionId` is `pinnedImageModelVersion(model)`
 * for the model this replay would run under today, and the row's own
 * `meta.render.requestedVersionId` is the version the ORIGINAL render asked
 * for (falling back to its `executedVersionId` echo only for a row written
 * before `requestedVersionId` existed — for a pinned request the echo equals
 * the pin). A model the app cannot pin today is eligible only against a row
 * that was ALSO an unpinned request, regardless of what that row's provider
 * echo happened to be.
 *
 * A program fingerprint that could not be read degrades to `null`, never
 * `undefined` — the two full-check refusal reasons below are named
 * differently on purpose: `program_unrecorded` is "we cannot tell", never
 * silently approved as if nothing needed checking.
 */

export const AVATAR_REPLAY_REFUSAL_REASONS = [
  "no_recorded_seed",
  "model_changed",
  "version_changed",
  "world_changed",
  "program_unrecorded",
  "demo_mode",
  "source_unavailable",
] as const;
export type AvatarReplayRefusalReason = (typeof AVATAR_REPLAY_REFUSAL_REASONS)[number];

/** The sentence a refusal fails the row with — also what the studio's disabled menu item explains. */
export const AVATAR_REPLAY_REFUSAL_TEXT: Record<AvatarReplayRefusalReason, string> = {
  no_recorded_seed: "this portrait was rendered without a seed; only a new variation is possible",
  model_changed: "the image model changed since this portrait was rendered, so the same composition is no longer available",
  version_changed: "the model version changed since this portrait was rendered, so the same composition is no longer available",
  world_changed: "the character's appearance, wardrobe or world state changed since this portrait was rendered, so the same composition is no longer available",
  program_unrecorded: "this portrait's prompt program cannot be compared, so the same composition is not available",
  demo_mode: "demo mode renders a placeholder; there is no composition to replay",
  source_unavailable: "this portrait is not available to replay",
};

export type AvatarReplayEligibility =
  | { readonly ok: true; readonly seed: number; readonly version: { readonly pinned: string | null } }
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
  /**
   * `pinnedImageModelVersion(model)` for the CURRENT model — the version the
   * app itself would ask for, never a provider echo. `null` when the app
   * pins nothing for this model (renamed from `executedVersionId`, which
   * this field never was: comparing a pin to an echo is exactly the bug
   * correction round 2's finding 1 closes).
   */
  readonly pinnedVersionId: string | null;
}

/** Fields every eligibility check needs, whether or not it can also check world state. */
interface AvatarReplayBaseInput {
  /** The row named by the retry request, or undefined for a missing/foreign id. */
  readonly source: AvatarReplaySourceRow | undefined;
  readonly ownerId: string;
  readonly characterId: string;
  readonly current: AvatarReplayCurrentModel;
}

export interface AvatarReplayEligibilityInput extends AvatarReplayBaseInput {
  /**
   * The freshly compiled program's `promptProgram.programFingerprint`, or
   * `null` when it could not be read. Never optional and never `undefined`:
   * a caller that cannot answer must say so explicitly, so a parse failure
   * fails CLOSED as `program_unrecorded` rather than silently skipping the
   * world-state check it was meant to gate (correction round 2, finding 2).
   */
  readonly programFingerprint: string | null;
}

/**
 * The CHEAP, list-time check's input — no `programFingerprint` at all, never
 * even `null`: this call site (the portraits list) has not compiled a
 * program and structurally cannot answer the world-state question, which is
 * different from a full check that tried and failed to read one.
 */
export type AvatarReplayCheapEligibilityInput = AvatarReplayBaseInput;

/** `meta.render`, read loosely — a malformed or absent record reads as "nothing recorded" rather than throwing. */
const renderMetaSchema = z
  .object({
    seed: z.number().nullable().optional(),
    modelSlug: z.string().optional(),
    profileId: z.string().optional(),
    /** The version the ORIGINAL render asked for — absent on a row written
     * before this field existed, in which case only the echo below survives. */
    requestedVersionId: z.string().nullable().optional(),
    /** The provider's echo of the version it executed — never itself the
     * comparison target; only a stand-in for `requestedVersionId` on an old row. */
    executedVersionId: z.string().nullable().optional(),
  })
  .catch({});

/** `meta.promptProgram`, read loosely for the one field this module compares. */
const promptProgramMetaSchema = z.object({ programFingerprint: z.string().optional() }).catch({});

function readMetaField(meta: unknown, key: string): unknown {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  return (meta as Record<string, unknown>)[key];
}

/** Whether this dimension also checks world state, and what it compares against when it does. */
type WorldCheck = { readonly kind: "full"; readonly programFingerprint: string | null } | { readonly kind: "cheap" };

/**
 * The shared eligibility logic (issue #248 acceptance #2–#3; correction round
 * 2 findings 1–2): whether replaying `source` as "same composition" is
 * honest for the CURRENT resolution, and the seed to replay with when it is.
 * Every refusal reason below is checked in the order a caller should trust: a
 * row that fails an earlier check never reaches a later one that would need
 * to read more of it. `demo_mode` never reaches this function — the caller
 * (`generateAvatar`) decides it before there is a program to check anything
 * against, through the same refusal path and diagnostic.
 *
 * | condition (checked in this order)                                                      | result               |
 * | --------------------------------------------------------------------------------------- | -------------------- |
 * | row missing, foreign owner/character, not `avatar` kind, or not `ready`                 | `source_unavailable` |
 * | `meta.render.seed` is not a number                                                      | `no_recorded_seed`   |
 * | `meta.render.modelSlug` or `.profileId` differ from the current resolution               | `model_changed`      |
 * | the app pins a version now, and the row's requested-or-echoed version differs from it    | `version_changed`    |
 * | the app pins NO version now, and the row's own requested version was not also null/absent| `version_changed`    |
 * | (full check only) the freshly compiled program's fingerprint could not be read           | `program_unrecorded` |
 * | (full check only) the freshly compiled program's fingerprint differs from the row's own  | `world_changed`      |
 * | everything above holds                                                                   | `{ ok: true, seed, version }` |
 */
function eligibilityFor(input: AvatarReplayBaseInput, world: WorldCheck): AvatarReplayEligibility {
  const { source, ownerId, characterId, current } = input;
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

  if (current.pinnedVersionId !== null) {
    // Rows written before `requestedVersionId` existed recorded only the
    // provider's echo — for a pinned request the echo equals the pin, so this
    // fallback reads old and new rows alike.
    const versionThen = render.requestedVersionId ?? render.executedVersionId ?? null;
    if (versionThen !== current.pinnedVersionId) return { ok: false, reason: "version_changed" };
  } else {
    // The app cannot pin this model today. Eligible only if the stored row
    // was ALSO an unpinned request — whatever the provider's echo says: an
    // echoed hash on an unpinned request describes the provider's floating
    // default at render time, not a version either side asked for.
    const storedRequestWasUnpinned = render.requestedVersionId === null || render.requestedVersionId === undefined;
    if (!storedRequestWasUnpinned) return { ok: false, reason: "version_changed" };
  }

  if (world.kind === "full") {
    if (world.programFingerprint === null) return { ok: false, reason: "program_unrecorded" };
    const promptProgram = promptProgramMetaSchema.parse(readMetaField(source.meta, "promptProgram") ?? {});
    if (promptProgram.programFingerprint !== world.programFingerprint) return { ok: false, reason: "world_changed" };
  }

  return { ok: true, seed: render.seed, version: { pinned: current.pinnedVersionId } };
}

/** The full, request-time check: everything `eligibilityFor` checks, including world state. */
export function avatarReplayEligibility(input: AvatarReplayEligibilityInput): AvatarReplayEligibility {
  return eligibilityFor(input, { kind: "full", programFingerprint: input.programFingerprint });
}

/**
 * The CHEAP, list-time check the portraits list reads for its per-row
 * Regenerate-menu hint: seed recorded, and model/profile/version still what
 * the surface would resolve to today. A world-state change (appearance,
 * wardrobe, prompt) is undetectable without compiling a fresh program, so it
 * is never reported here — it surfaces only at request time, as the refused
 * row's own error text, never a silent fallback to a new variation.
 */
export function avatarReplayCheapEligibility(input: AvatarReplayCheapEligibilityInput): AvatarReplayEligibility {
  return eligibilityFor(input, { kind: "cheap" });
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

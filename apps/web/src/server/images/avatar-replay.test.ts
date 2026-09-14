import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { expectDiagnostic } from "@/test/diagnostics";
import {
  AVATAR_REPLAY_REFUSAL_REASONS,
  AVATAR_REPLAY_REFUSAL_TEXT,
  avatarReplayCheapEligibility,
  avatarReplayEligibility,
  avatarReplayPrecondition,
  type AvatarReplaySourceRow,
} from "./avatar-replay";

/**
 * Kills a same-composition replay that passes silently — a changed model,
 * version or world state (issue #248 acceptance #3), an unrecorded seed or
 * program, or a demo-mode request, must each refuse with its own named
 * reason rather than quietly falling back to a fresh, differently-seeded
 * render. One case per row of the eligibility table in `avatar-replay.ts`'s
 * own doc comment (correction round 2 findings 1, 2 and 4).
 */

const OWNER = "user-1";
const CHARACTER = "chr-1";

const CURRENT_PINNED = { modelSlug: "replicate/qwen-image-2512", profileId: "profile-portrait-standard", pinnedVersionId: "v-current" };
const CURRENT_UNPINNED = { ...CURRENT_PINNED, pinnedVersionId: null };

function readyAvatarRow(overrides: Partial<AvatarReplaySourceRow> = {}, meta: Record<string, unknown> = {}): AvatarReplaySourceRow {
  return {
    id: "img-source",
    ownerId: OWNER,
    entityKind: "character",
    entityId: CHARACTER,
    kind: "avatar",
    status: "ready",
    meta: {
      render: { seed: 42, modelSlug: CURRENT_PINNED.modelSlug, profileId: CURRENT_PINNED.profileId, requestedVersionId: "v-current" },
      promptProgram: { programFingerprint: "fp-1" },
      ...meta,
    },
    ...overrides,
  };
}

describe("avatarReplayEligibility (issue #248 table; correction round 2 findings 1–2)", () => {
  it("ok: every condition holds, pinned now and the row recorded that same pin — returns the seed and the pin", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow(),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: true, seed: 42, version: { pinned: "v-current" } });
  });

  it("ok: pinned now, an OLD row that only recorded the provider's echo (no requestedVersionId) — the echo equals the pin", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: { seed: 42, modelSlug: CURRENT_PINNED.modelSlug, profileId: CURRENT_PINNED.profileId, executedVersionId: "v-current" } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: true, seed: 42, version: { pinned: "v-current" } });
  });

  it("version_changed: pinned now, the row's requested version was explicitly null (an unpinned request under an old pinned model)", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: { seed: 42, modelSlug: CURRENT_PINNED.modelSlug, profileId: CURRENT_PINNED.profileId, requestedVersionId: null } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "version_changed" });
  });

  it("version_changed: pinned now, the row's requested version pins a DIFFERENT version", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: { seed: 42, modelSlug: CURRENT_PINNED.modelSlug, profileId: CURRENT_PINNED.profileId, requestedVersionId: "v-older" } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "version_changed" });
  });

  it("ok: the app pins NOTHING today, and the row was also an unpinned request — eligible regardless of the echo, and the pin reads null", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: { seed: 42, modelSlug: CURRENT_PINNED.modelSlug, profileId: CURRENT_PINNED.profileId, requestedVersionId: null, executedVersionId: "some-hash-the-provider-picked" } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_UNPINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: true, seed: 42, version: { pinned: null } });
  });

  it("version_changed: the app pins NOTHING today, but the row's own request WAS pinned — refused whatever the app pins now", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: { seed: 42, modelSlug: CURRENT_PINNED.modelSlug, profileId: CURRENT_PINNED.profileId, requestedVersionId: "v-old-pin" } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_UNPINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "version_changed" });
  });

  it("no_recorded_seed: meta.render.seed is null", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: { seed: null, modelSlug: CURRENT_PINNED.modelSlug, profileId: CURRENT_PINNED.profileId, requestedVersionId: "v-current" } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "no_recorded_seed" });
  });

  it("no_recorded_seed: meta.render is absent entirely", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: undefined }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "no_recorded_seed" });
  });

  it("no_recorded_seed: a malformed render bag degrades rather than throwing a parse", () => {
    // Schema-legal-input resilience: garbage in a jsonb column must degrade,
    // not throw, at a trust boundary (docs/resilience.md).
    expect(() =>
      avatarReplayEligibility({
        source: readyAvatarRow({}, { render: "not an object" }),
        ownerId: OWNER,
        characterId: CHARACTER,
        current: CURRENT_PINNED,
        programFingerprint: "fp-1",
      }),
    ).not.toThrow();
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: "not an object" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "no_recorded_seed" });
  });

  it("model_changed: the current resolution's model slug differs", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow(),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: { ...CURRENT_PINNED, modelSlug: "replicate/some-other-model" },
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "model_changed" });
  });

  it("model_changed: the current resolution's profile id differs (same model slug)", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow(),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: { ...CURRENT_PINNED, profileId: "profile-portrait-quality" },
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "model_changed" });
  });

  it("world_changed: the freshly compiled program's fingerprint differs (appearance, wardrobe or world state moved)", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { promptProgram: { programFingerprint: "stale-fp" } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fresh-fp",
    });
    expect(result).toEqual({ ok: false, reason: "world_changed" });
  });

  /**
   * Correction round 2, finding 2: the ORIGINAL bug was `avatar.ts` reading
   * `safeParse(...).data?.programFingerprint`, whose `undefined` on a parse
   * failure made the full check skip `world_changed` and silently approve.
   * The fix moved the degradation to `null` on the CALLER's side; this
   * module's own job is to refuse a `null` fingerprint outright rather than
   * treat it as "nothing to compare" the way the old optional field did.
   */
  it("program_unrecorded: the freshly compiled program's fingerprint could not be read (a caller-side parse failure degraded to null)", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow(),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: null,
    });
    expect(result).toEqual({ ok: false, reason: "program_unrecorded" });
  });

  it("source_unavailable: the row does not exist", () => {
    const result = avatarReplayEligibility({
      source: undefined,
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("source_unavailable: the row belongs to a different owner", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ ownerId: "someone-else" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("source_unavailable: the row is filed against a different character", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ entityId: "chr-2" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  /**
   * Correction round 2, finding 4(b): only `entityId` had a dedicated case —
   * `entityKind` was exercised solely through the row's happy-path default,
   * so a row filed against the right id under the WRONG kind (a scene keyed
   * to a character id, say) was never actually proven to refuse.
   */
  it("source_unavailable: the row's entityKind is not \"character\" (same entityId, e.g. a scene)", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ entityKind: "scene" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("source_unavailable: the row is a portrait_variant, not an avatar", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ kind: "portrait_variant" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("source_unavailable: the row has not finished rendering", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ status: "pending" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("source_unavailable: the row failed", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ status: "failed" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });
});

describe("avatarReplayCheapEligibility (the list-time hint)", () => {
  it("ok: the same row the full check accepts, with no fingerprint to pass at all", () => {
    const result = avatarReplayCheapEligibility({
      source: readyAvatarRow(),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
    });
    expect(result).toEqual({ ok: true, seed: 42, version: { pinned: "v-current" } });
  });

  it("never reports world_changed or program_unrecorded — it structurally cannot compile a program to compare against", () => {
    // Same source row the full check refuses as `world_changed` above (its
    // stored fingerprint is stale) — the cheap check has no fresh fingerprint
    // to compare it to at all, so it reports the row as replayable.
    const result = avatarReplayCheapEligibility({
      source: readyAvatarRow({}, { promptProgram: { programFingerprint: "stale-fp" } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT_PINNED,
    });
    expect(result).toEqual({ ok: true, seed: 42, version: { pinned: "v-current" } });
  });

  it("still refuses everything the shared checks catch: no_recorded_seed, model_changed, source_unavailable", () => {
    expect(
      avatarReplayCheapEligibility({
        source: readyAvatarRow({}, { render: { seed: null, modelSlug: CURRENT_PINNED.modelSlug, profileId: CURRENT_PINNED.profileId } }),
        ownerId: OWNER,
        characterId: CHARACTER,
        current: CURRENT_PINNED,
      }),
    ).toEqual({ ok: false, reason: "no_recorded_seed" });
    expect(
      avatarReplayCheapEligibility({
        source: readyAvatarRow(),
        ownerId: OWNER,
        characterId: CHARACTER,
        current: { ...CURRENT_PINNED, modelSlug: "replicate/some-other-model" },
      }),
    ).toEqual({ ok: false, reason: "model_changed" });
    expect(
      avatarReplayCheapEligibility({
        source: undefined,
        ownerId: OWNER,
        characterId: CHARACTER,
        current: CURRENT_PINNED,
      }),
    ).toEqual({ ok: false, reason: "source_unavailable" });
  });
});

describe("AVATAR_REPLAY_REFUSAL_REASONS and AVATAR_REPLAY_REFUSAL_TEXT stay in sync (correction round 2, finding 4a)", () => {
  it("every reason has a non-empty sentence, and neither list carries a key the other lacks", () => {
    const reasonKeys = [...AVATAR_REPLAY_REFUSAL_REASONS].sort();
    const textKeys = Object.keys(AVATAR_REPLAY_REFUSAL_TEXT).sort();
    expect(textKeys).toEqual(reasonKeys);
    for (const reason of AVATAR_REPLAY_REFUSAL_REASONS) {
      expect(AVATAR_REPLAY_REFUSAL_TEXT[reason].trim().length).toBeGreaterThan(0);
    }
  });
});

describe("avatarReplayPrecondition", () => {
  it("returns null and pushes nothing for an eligible replay", () => {
    const sink = new DiagnosticCollector();
    expect(avatarReplayPrecondition({ ok: true, seed: 7, version: { pinned: null } }, CHARACTER, sink)).toBeNull();
    expect(sink.items).toEqual([]);
  });

  it("returns null and pushes nothing when no replay was attempted", () => {
    const sink = new DiagnosticCollector();
    expect(avatarReplayPrecondition(null, CHARACTER, sink)).toBeNull();
    expect(sink.items).toEqual([]);
  });

  it("a refusal returns its sentence AND records images.avatar.replay_refused with the reason code", () => {
    const sink = new DiagnosticCollector();
    const text = avatarReplayPrecondition({ ok: false, reason: "model_changed" }, CHARACTER, sink);
    expect(text).toBe(AVATAR_REPLAY_REFUSAL_TEXT.model_changed);
    expectDiagnostic(sink, "images.avatar.replay_refused");
    expect(sink.items[0]?.context).toMatchObject({ characterId: CHARACTER, reason: "model_changed" });
  });

  it("surfaces the two new reasons (program_unrecorded, demo_mode) through the same path", () => {
    for (const reason of ["program_unrecorded", "demo_mode"] as const) {
      const sink = new DiagnosticCollector();
      const text = avatarReplayPrecondition({ ok: false, reason }, CHARACTER, sink);
      expect(text).toBe(AVATAR_REPLAY_REFUSAL_TEXT[reason]);
      expectDiagnostic(sink, "images.avatar.replay_refused");
      expect(sink.items[0]?.context).toMatchObject({ characterId: CHARACTER, reason });
    }
  });
});

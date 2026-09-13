import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { expectDiagnostic } from "@/test/diagnostics";
import {
  AVATAR_REPLAY_REFUSAL_TEXT,
  avatarReplayEligibility,
  avatarReplayPrecondition,
  type AvatarReplaySourceRow,
} from "./avatar-replay";

/**
 * Kills a same-composition replay that passes silently — a changed model,
 * version or world state (issue #248 acceptance #3), or a source with no
 * recorded seed, must each refuse with its own named reason rather than
 * quietly falling back to a fresh, differently-seeded render. One case per
 * row of the eligibility table in `avatar-replay.ts`'s own doc comment.
 */

const OWNER = "user-1";
const CHARACTER = "chr-1";

const CURRENT = { modelSlug: "replicate/qwen-image-2512", profileId: "profile-portrait-standard", executedVersionId: "v-current" };

function readyAvatarRow(overrides: Partial<AvatarReplaySourceRow> = {}, meta: Record<string, unknown> = {}): AvatarReplaySourceRow {
  return {
    id: "img-source",
    ownerId: OWNER,
    entityKind: "character",
    entityId: CHARACTER,
    kind: "avatar",
    status: "ready",
    meta: {
      render: { seed: 42, modelSlug: CURRENT.modelSlug, profileId: CURRENT.profileId, executedVersionId: CURRENT.executedVersionId },
      promptProgram: { programFingerprint: "fp-1" },
      ...meta,
    },
    ...overrides,
  };
}

describe("avatarReplayEligibility (issue #248 table)", () => {
  it("ok: every condition holds — returns the recorded seed", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow(),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: true, seed: 42 });
  });

  it("ok without a programFingerprint: the cheap list-time check cannot see world_changed", () => {
    // A world change is undetectable without a freshly compiled program — the
    // list endpoint's cheap check omits `programFingerprint` and must not
    // report `world_changed` it cannot possibly have observed.
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { promptProgram: { programFingerprint: "stale-fp" } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
    });
    expect(result).toEqual({ ok: true, seed: 42 });
  });

  it("no_recorded_seed: meta.render.seed is null", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: { seed: null, modelSlug: CURRENT.modelSlug, profileId: CURRENT.profileId, executedVersionId: CURRENT.executedVersionId } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "no_recorded_seed" });
  });

  it("no_recorded_seed: meta.render is absent entirely", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: undefined }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "no_recorded_seed" });
  });

  it("model_changed: the current resolution's model slug differs", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow(),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: { ...CURRENT, modelSlug: "replicate/some-other-model" },
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "model_changed" });
  });

  it("model_changed: the current resolution's profile id differs (same model slug)", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow(),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: { ...CURRENT, profileId: "profile-portrait-quality" },
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "model_changed" });
  });

  it("version_changed: the executed version no longer matches the current pinned/probed version", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow(),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: { ...CURRENT, executedVersionId: "v-newer" },
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "version_changed" });
  });

  it("version_changed is NOT raised when both sides are null (no probed/pinned version at all)", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: { seed: 42, modelSlug: CURRENT.modelSlug, profileId: CURRENT.profileId, executedVersionId: null } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: { ...CURRENT, executedVersionId: null },
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: true, seed: 42 });
  });

  it("world_changed: the freshly compiled program's fingerprint differs (appearance, wardrobe or world state moved)", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { promptProgram: { programFingerprint: "stale-fp" } }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fresh-fp",
    });
    expect(result).toEqual({ ok: false, reason: "world_changed" });
  });

  it("source_unavailable: the row does not exist", () => {
    const result = avatarReplayEligibility({
      source: undefined,
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("source_unavailable: the row belongs to a different owner", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ ownerId: "someone-else" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("source_unavailable: the row is filed against a different character", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ entityId: "chr-2" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("source_unavailable: the row is a portrait_variant, not an avatar", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ kind: "portrait_variant" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("source_unavailable: the row has not finished rendering", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ status: "pending" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("source_unavailable: the row failed", () => {
    const result = avatarReplayEligibility({
      source: readyAvatarRow({ status: "failed" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "source_unavailable" });
  });

  it("a malformed meta object degrades to source_unavailable-adjacent refusals, never a thrown parse", () => {
    // Schema-legal-input resilience: garbage in a jsonb column must degrade,
    // not throw, at a trust boundary (docs/resilience.md).
    expect(() =>
      avatarReplayEligibility({
        source: readyAvatarRow({}, { render: "not an object" }),
        ownerId: OWNER,
        characterId: CHARACTER,
        current: CURRENT,
        programFingerprint: "fp-1",
      }),
    ).not.toThrow();
    const result = avatarReplayEligibility({
      source: readyAvatarRow({}, { render: "not an object" }),
      ownerId: OWNER,
      characterId: CHARACTER,
      current: CURRENT,
      programFingerprint: "fp-1",
    });
    expect(result).toEqual({ ok: false, reason: "no_recorded_seed" });
  });
});

describe("avatarReplayPrecondition", () => {
  it("returns null and pushes nothing for an eligible replay", () => {
    const sink = new DiagnosticCollector();
    expect(avatarReplayPrecondition({ ok: true, seed: 7 }, CHARACTER, sink)).toBeNull();
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
});

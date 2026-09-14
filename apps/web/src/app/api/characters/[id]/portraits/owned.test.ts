import { describe, expect, it, vi } from "vitest";
import { imageModelProfileSchema, imageModelSchema, type ResolvedImageProfile } from "@vesper/image-core";

/**
 * Owns `avatarReplayMapForPortraits` (issue #248 correction round 2, finding
 * 4c) — the studio's Regenerate-menu hint had no test at its own layer, so a
 * broken mapping (a reason lost in translation, a resolved-profile miss
 * silently returning every row as replayable rather than an empty map) could
 * ship unnoticed. Kept minimal: the eligibility TABLE itself is owned by
 * `avatar-replay.test.ts`; this proves only that the mapping wires
 * `avatarReplayCheapEligibility` correctly over a real row set.
 *
 * Codex review round 1, finding B: also owns the `modelId` parameter added
 * so the hint judges a row against the studio's CURRENT profile-picker
 * selection rather than always the task default — without it, a portrait
 * rendered on a non-default profile reported `model_changed` even while
 * that exact profile was selected.
 */

vi.mock("@/server/images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/images")>();
  return { ...actual, resolveImageProfileForTask: vi.fn() };
});

import { resolveImageProfileForTask, type AvatarReplaySourceRow } from "@/server/images";
import { avatarReplayMapForPortraits } from "./owned";

const mockResolve = vi.mocked(resolveImageProfileForTask);

const OWNER = "user-1";
const CHARACTER = "chr-1";
const MODEL_SLUG = "replicate/qwen-image-2512";
const PROFILE_ID = "profile-portrait-standard";

function resolvedProfile(): ResolvedImageProfile {
  return {
    model: imageModelSchema.parse({
      id: "mdl-1",
      slug: MODEL_SLUG,
      label: "Fixture",
      canGenerate: true,
      canEdit: true,
      referenceField: "image",
      referenceArity: "array",
      maxReferences: 1,
      supportedAspects: ["3:4"],
    }),
    profile: imageModelProfileSchema.parse({
      id: PROFILE_ID,
      imageModelId: "mdl-1",
      key: "portrait-standard",
      label: "Portrait Standard",
      task: "portrait",
      operation: "generate",
      promptStrategy: "text_to_image_description",
      controlDefaults: { seedPolicy: "random" },
    }),
  };
}

const ALT_MODEL_SLUG = "replicate/some-alt-model";
const ALT_PROFILE_ID = "profile-portrait-alt";
const ALT_MODEL_ID = "alt-model-profile";

function altResolvedProfile(): ResolvedImageProfile {
  return {
    model: imageModelSchema.parse({
      id: "mdl-2",
      slug: ALT_MODEL_SLUG,
      label: "Alt Fixture",
      canGenerate: true,
      canEdit: true,
      referenceField: "image",
      referenceArity: "array",
      maxReferences: 1,
      supportedAspects: ["3:4"],
    }),
    profile: imageModelProfileSchema.parse({
      id: ALT_PROFILE_ID,
      imageModelId: "mdl-2",
      key: "portrait-alt",
      label: "Portrait Alt",
      task: "portrait",
      operation: "generate",
      promptStrategy: "text_to_image_description",
      controlDefaults: { seedPolicy: "random" },
    }),
  };
}

function row(id: string, render: Record<string, unknown> | undefined): AvatarReplaySourceRow {
  return {
    id,
    ownerId: OWNER,
    entityKind: "character",
    entityId: CHARACTER,
    kind: "avatar",
    status: "ready",
    meta: render ? { render } : {},
  };
}

describe("avatarReplayMapForPortraits", () => {
  it("maps a replayable row, a no_recorded_seed row and a model_changed row", async () => {
    mockResolve.mockResolvedValue(resolvedProfile());
    const rows = [
      row("img-ok", { seed: 1, modelSlug: MODEL_SLUG, profileId: PROFILE_ID, requestedVersionId: null }),
      row("img-no-seed", { seed: null, modelSlug: MODEL_SLUG, profileId: PROFILE_ID, requestedVersionId: null }),
      row("img-model-changed", { seed: 1, modelSlug: "replicate/some-other-model", profileId: PROFILE_ID, requestedVersionId: null }),
    ];

    const map = await avatarReplayMapForPortraits(rows, OWNER, CHARACTER);

    expect(map).toEqual({
      "img-ok": { ok: true },
      "img-no-seed": { ok: false, reason: "no_recorded_seed" },
      "img-model-changed": { ok: false, reason: "model_changed" },
    });
  });

  it("never reports world_changed or program_unrecorded — the cheap check has no fresh program to compare against", async () => {
    mockResolve.mockResolvedValue(resolvedProfile());
    // A stored programFingerprint is irrelevant here: the mapping never wires
    // one to the cheap check at all.
    const rows = [row("img-1", { seed: 1, modelSlug: MODEL_SLUG, profileId: PROFILE_ID, requestedVersionId: null })];

    const map = await avatarReplayMapForPortraits(rows, OWNER, CHARACTER);

    expect(map).toEqual({ "img-1": { ok: true } });
  });

  it("returns an empty map when no portrait profile resolves (no offered model for the task)", async () => {
    mockResolve.mockResolvedValue(null);
    const map = await avatarReplayMapForPortraits([row("img-1", { seed: 1 })], OWNER, CHARACTER);
    expect(map).toEqual({});
  });

  it("judges against the caller's selected profile, not always the task default (codex review round 1, finding B)", async () => {
    mockResolve.mockImplementation(async (_task, modelId) => (modelId === ALT_MODEL_ID ? altResolvedProfile() : resolvedProfile()));
    // Rendered on the ALT profile, not the task default.
    const rows = [row("img-1", { seed: 1, modelSlug: ALT_MODEL_SLUG, profileId: ALT_PROFILE_ID, requestedVersionId: null })];

    const againstDefault = await avatarReplayMapForPortraits(rows, OWNER, CHARACTER);
    expect(againstDefault).toEqual({ "img-1": { ok: false, reason: "model_changed" } });

    const againstSelected = await avatarReplayMapForPortraits(rows, OWNER, CHARACTER, ALT_MODEL_ID);
    expect(againstSelected).toEqual({ "img-1": { ok: true } });
  });
});

import type { NextRequest } from "next/server";
import {
  identityPackAdminOverrideRequestSchema,
  type IdentityPackAdminRevision,
  type IdentityPackNormalizedCropWire,
} from "@vesper/image-core";
import { jsonError, readBody } from "@/server/api";
import { saveManualIdentityCrop, type ManualIdentityCropInput } from "@/server/images";
// The pack-write response vocabulary, imported rather than restated: a stale
// save must answer 409 with a fresh summary here exactly as it does on the owner
// route, and two copies of that mapping are two chances for one of them to drift
// into a different status or a different body.
import {
  identityPackFailure,
  identityPackSummaryResponse,
  identityPackWriteFailure,
  manualCropInput,
} from "@/app/api/characters/[id]/identity-pack/shared";
import { withOwnPackHistory, type IdentityPackParams } from "../../owned";

/**
 * A recorded admin override of a reviewed quality threshold
 * (image-identity-packs.spec.lifecycle.md §"Admin routes",
 * `.spec.derivation.md` §"Manual crop revisions").
 *
 * What an override may do is narrow on purpose: waive a REVIEWED THRESHOLD, and
 * nothing else. Ownership, a missing source, invalid geometry and a stale hash
 * are hard checks inside the service, refused whoever asks and whatever reason
 * they give — an administrator who can crop past a bounds check can store a
 * rectangle that is not inside the image. Those refusals are surfaced verbatim
 * here rather than being retried without the override flag.
 *
 * An absent `crop` re-approves the current revision's coordinates: the support
 * case where the framing is right and only the threshold is in the way. It is
 * still a new `manual` revision, measured again, stamped with the actor, the
 * reason and the `manual_admin_override` warning — which travels into profile
 * evaluation, so a profile that forbids overrides still refuses the pack.
 */
export const POST = withOwnPackHistory<IdentityPackParams>(async (user, history, req: NextRequest) => {
  const body = await readBody(req, identityPackAdminOverrideRequestSchema);
  if (!body.ok) return body.response;
  if (body.value.packId !== history.packId) {
    return jsonError("pack_mismatch", "the body names a different pack than the URL", 400);
  }

  const crop = resolveOverrideCrop(body.value.crop, history.revisions);
  if (crop === null) {
    return identityPackFailure(
      422,
      "no_current_crop",
      "this pack has no current crop coordinates to re-approve; submit one",
      { blockers: [] },
    );
  }

  const result = await saveManualIdentityCrop({
    ownerId: user.id,
    characterId: history.characterId,
    expectedPackId: body.value.packId,
    expectedRevision: body.value.revision,
    expectedSourceHash: body.value.sourceContentHash,
    crop,
    actorUserId: user.id,
    reason: body.value.reason,
    adminOverride: true,
  });
  if (result.status !== "ready") return identityPackWriteFailure(result, history.characterId, user.id);
  return identityPackSummaryResponse(history.characterId, user.id);
});

/**
 * The rectangle this override applies: the submitted one, or the current
 * revision's stored source pixels when the request carries none.
 *
 * `null` means there is nothing to re-approve — a pack that never produced a
 * rectangle (a refusal before geometry) cannot be waived into existence, and an
 * override that quietly invented coordinates would be the one thing this surface
 * must never do.
 */
function resolveOverrideCrop(
  submitted: IdentityPackNormalizedCropWire | undefined,
  revisions: readonly IdentityPackAdminRevision[],
): ManualIdentityCropInput | null {
  if (submitted !== undefined) return manualCropInput(submitted);
  const current = revisions.find((revision) => revision.current)?.crop ?? null;
  return current === null ? null : { space: "source_pixels", crop: current };
}

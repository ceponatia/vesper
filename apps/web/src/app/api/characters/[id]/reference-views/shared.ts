import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  normalizeReferenceViewTargets,
  referenceViewAngleIdSchema,
  referenceViewSchema,
  referenceViewReviewRequestSchema,
  referenceViewWardrobeSchema,
  type ReferenceView,
  type ReferenceViewQueueOutcome,
} from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { imageRenderRejection, jsonError, jsonOk, startJobAfterAdmission } from "@/server/api";
import {
  buildReferenceViews,
  claimReferenceViewLeases,
  getReferenceViewSet,
  plannedReferenceViewsForCharacter,
  type ReferenceViewLeaseClaim,
} from "@/server/images";
import { log } from "@/server/log";
import { findOwnedCharacter } from "../owned";

/**
 * The vocabulary every reference-view route speaks.
 *
 * Five owner routes share one authorization root, one slot parser, and one
 * decision about whether a build may start. Written out five times that is five
 * chances for one route to charge a different budget, skip per-slot admission,
 * or answer a refusal as a failure — so each is stated once, here.
 *
 * **Nothing in this file may turn a refusal into an error.** A build that cannot
 * start is an outcome the caller reports and the studio offers to retry; the
 * acceptance, the portrait and the page are unaffected.
 */

export type ReferenceViewParams = { id: string };
export type ReferenceViewSlotParams = { id: string; angleId: string; wardrobe: string };

export type OwnedCharacter = NonNullable<Awaited<ReturnType<typeof findOwnedCharacter>>>;

/**
 * The authorization root for every view operation: the CHARACTER in the URL,
 * never a view id a client supplied. `withAuthorizedResource` collapses "not
 * yours" and "does not exist" into one 404, which is also the shape
 * `pnpm lint:authz` requires of a resource-ID route.
 */
export const ownedCharacter = async (user: { id: string }, params: ReferenceViewParams) =>
  (await findOwnedCharacter(params.id, user.id)) ?? null;

/**
 * The slot named by the URL, or null for ids the registry has no entry for.
 *
 * A 404 rather than a 400: `/reference-views/from_above/clothed` names a
 * resource that does not exist, exactly like an unknown character id, and
 * nothing about the request body is wrong.
 */
export function parseSlot(params: { angleId: string; wardrobe: string }): ReferenceView | null {
  const angle = parseOrNull(referenceViewAngleIdSchema, params.angleId);
  const wardrobe = parseOrNull(referenceViewWardrobeSchema, params.wardrobe);
  return angle === null || wardrobe === null ? null : { angle, wardrobe };
}

/** `{ dataUrl }` — the owner-supplied view. The same string cap as the avatar upload,
 * for its reason: reject an oversized payload before anything decodes it, with the
 * decoded byte cap enforced independently in the service. */
export const referenceViewUploadBodySchema = z.object({
  dataUrl: z
    .string()
    .min(1)
    .max(3_000_000)
    .refine((value) => value.startsWith("data:image/"), "dataUrl must be an image data URL"),
});

export const referenceViewReviewBodySchema = referenceViewReviewRequestSchema;

/**
 * `{ targets }` — the slots an explicit regeneration names.
 *
 * Bounded well above the sheet's own size so a registry that grows an angle
 * needs no edit here, and far below anything that could turn one request into a
 * denial of service: the cap is a parse guard, not the spend rule. What may
 * actually be built is decided by the plan and the admission that follows.
 */
export const referenceViewRegenerateBodySchema = z.object({
  targets: z.array(referenceViewSchema).min(1).max(32),
});

/** How many views this character's next full build would render. */
export function plannedCount(characterId: string, ownerId: string): Promise<number> {
  return plannedReferenceViewsForCharacter(characterId, ownerId).then((views) => views.length);
}

export interface QueueReferenceViewBuildInput {
  characterId: string;
  ownerId: string;
  req: NextRequest;
  user: { id: string };
  /** The slots to build. Its LENGTH is what the daily budget is charged. */
  targets: readonly ReferenceView[];
  /** What a full build of this character would be — reported back for the studio's copy. */
  planned: number;
}

/**
 * Admit, charge and start one build — the one place any route decides a
 * reference-view render may happen.
 *
 * Three guards, in this order and no other:
 *
 * 1. **Nothing to do** ⇒ queued `false` with no reason. Every slot is already
 *    what it should be; charging for that would bill an owner for a no-op.
 * 2. **Capacity, then slot admission.** `startJobAfterAdmission` atomically claims the
 *    per-user job slot BEFORE `imageRenderRejection` can consume the daily
 *    provider budget. The claimed row is only a reservation until admission
 *    passes; a refusal deletes it and starts no provider work. Admission charges
 *    exactly the newly leased targets and declares the hidden output kind so the
 *    storage leg is skipped: these bytes are excluded from the owner's quota, so
 *    their admission must not spend visible headroom either. Overlapping targets
 *    report `busy` while disjoint targets proceed in the same request. Backpressure and
 *    the daily provider budget still apply, because they are about spend and
 *    queue depth rather than disk.
 *
 * A refusal is a VALUE. The explicit build or regenerate route reports it in
 * the response body and leaves the accepted portrait exactly as it was.
 */
export async function queueReferenceViewBuild(
  input: QueueReferenceViewBuildInput,
): Promise<ReferenceViewQueueOutcome> {
  const { characterId, ownerId, targets, planned } = input;
  if (targets.length === 0) return { queued: false, reason: null, planned, admitted: 0, targets: [] };

  const payload: {
    characterId: string;
    targets: string[];
    leases: ReferenceViewLeaseClaim["claimed"];
    referenceViewAttemptIds: string[];
  } = {
    characterId,
    targets: [],
    leases: [],
    referenceViewAttemptIds: [],
  };
  type Admission = { reason: "budget" | "busy"; claim: ReferenceViewLeaseClaim };
  let claim: ReferenceViewLeaseClaim = { claimed: [], busy: [] };
  let leaseJobId: string | null = null;

  const started = await startJobAfterAdmission<Admission>(
    {
      type: "reference_views",
      ownerId,
      payload,
      run: () => {
        if (leaseJobId === null) throw new Error("reference view job launched without admitted leases");
        return buildReferenceViews({
          jobId: leaseJobId,
          characterId,
          ownerId,
          targets: claim.claimed,
        }).then((result) => ({ ...result }));
      },
    },
    async (jobId) => {
      leaseJobId = jobId;
      claim = await claimReferenceViewLeases({ characterId, ownerId, jobId, targets });
      payload.targets = claim.claimed.map((view) => `${view.angle}:${view.wardrobe}`);
      payload.leases = claim.claimed;
      if (claim.claimed.length === 0) return { reason: "busy", claim };

      const refused = await imageRenderRejection(input.user, input.req, {
        count: claim.claimed.length,
        outputKind: "reference_view",
      });
      if (!refused) return null;

      // The refusal's own code says which guard fired. `storage` cannot arise for
      // a hidden kind, but the route-level vocabulary intentionally collapses
      // every spend/backpressure refusal to the existing `budget` outcome.
      log.warn("images", "reference view build refused before it started", {
        code: "images.reference_views.budget_refused",
        characterId,
        requested: targets.length,
        claimed: claim.claimed.length,
        status: refused.status,
      });
      return { reason: "budget", claim };
    },
  );

  if (!started.ok) {
    if ("admission" in started) {
      const admission = started.admission;
      const busy = new Set(admission.claim.busy.map((view) => `${view.angle}:${view.wardrobe}`));
      return {
        queued: false,
        reason: admission.reason,
        planned,
        admitted: 0,
        targets: targets.map((view) => ({
          ...view,
          state: busy.has(`${view.angle}:${view.wardrobe}`) ? "busy" : admission.reason,
        })),
      };
    }
    // The per-user job cap refused the reservation. The admission callback did
    // not run, so no daily provider budget was consumed.
    return {
      queued: false,
      reason: "busy",
      planned,
      admitted: 0,
      targets: targets.map((view) => ({ ...view, state: "busy" })),
    };
  }
  const busy = new Set(claim.busy.map((view) => `${view.angle}:${view.wardrobe}`));
  return {
    queued: true,
    reason: null,
    planned,
    admitted: claim.claimed.length,
    targets: targets.map((view) => ({
      ...view,
      state: busy.has(`${view.angle}:${view.wardrobe}`) ? "busy" : "queued",
    })),
  };
}

/**
 * The one explicit-regeneration path: validate the named slots against the
 * character's plan, then hand the surviving list to {@link queueReferenceViewBuild}
 * as ONE batch.
 *
 * Both regenerate routes are callers — the per-slot route passes a single-element
 * list — so there is exactly one implementation of what "rebuild these" means and
 * exactly one place the age gate is re-checked at the door.
 *
 * Unlike the bulk build this will happily re-render a `rejected` slot: the owner
 * asked for these views by name, which is the difference between reviving a
 * verdict they gave and honoring one. It adds nothing they did not name.
 *
 * **A refused slot refuses the whole request, with nothing charged.** Naming a
 * slot the plan has no entry for — unknown, or intimate on a character the age
 * gate withholds them from — is a 404 the way an unknown character id is: the
 * resource does not exist. Building the rest and staying quiet about the refusal
 * would let a client discover the age gate by counting renders.
 */
export async function regenerateReferenceViews(input: {
  characterId: string;
  ownerId: string;
  req: NextRequest;
  user: { id: string };
  /** The slots as asked for, in the client's order. Deduplicated here. */
  requested: readonly ReferenceView[];
}): Promise<Response> {
  const { characterId, ownerId } = input;
  const set = await getReferenceViewSet(characterId, ownerId);
  if (set.acceptedImageId === null) {
    return jsonError("not_accepted", "accept a portrait before building its reference views", 409);
  }

  const planned = await plannedReferenceViewsForCharacter(characterId, ownerId);
  const { targets, refused } = normalizeReferenceViewTargets(input.requested, planned);
  if (refused.length > 0) {
    const named = refused.map((view) => `${view.angle}/${view.wardrobe}`).join(", ");
    return jsonError("not_found", `no such reference view: ${named}`, 404);
  }

  const outcome = await queueReferenceViewBuild({
    characterId,
    ownerId,
    req: input.req,
    user: input.user,
    targets,
    planned: planned.length,
  });
  return jsonOk({ views: outcome });
}

/** Expected conflicts tell an open reviewer how to recover without silently changing its target. */
export const referenceViewWriteMessages = {
  not_found: "This character or attempt is no longer available.",
  not_ready: "This image cannot be reviewed yet. Refresh to see its current status.",
  changed: "This view changed elsewhere. Refresh and review the current image before trying again.",
  incompatible: "This image does not match the accepted portrait or current reference version. Choose a compatible image or regenerate.",
  ineligible: "Undressed references require a recognized adult apparent age. Update the character profile before using this slot.",
  busy: "Reference views are still being built. Wait for them to finish, then refresh.",
  expired: "This image is outside the history retention window. Choose a more recent image or regenerate.",
  unavailable: "This image could not be read. Refresh, choose another image, or regenerate.",
} as const;

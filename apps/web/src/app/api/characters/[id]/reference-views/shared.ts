import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  referenceViewAngleIdSchema,
  referenceViewWardrobeSchema,
  type ReferenceView,
  type ReferenceViewQueueOutcome,
} from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { imageRenderRejection, startJobAfterAdmission } from "@/server/api";
import { hasLiveCharacterJob } from "@/server/db";
import { buildReferenceViews, plannedReferenceViewsForCharacter } from "@/server/images";
import { log } from "@/server/log";
import { findOwnedCharacter } from "../owned";

/**
 * The vocabulary every reference-view route speaks.
 *
 * Five owner routes share one authorization root, one slot parser, and one
 * decision about whether a build may start. Written out five times that is five
 * chances for one route to charge a different budget, skip the single-flight
 * guard, or answer a refusal as a failure — so each is stated once, here.
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

export const referenceViewReviewBodySchema = z.object({ verdict: z.enum(["approve", "reject"]) });

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
 * 2. **Single flight.** One build per character at a time
 *    (`hasLiveCharacterJob`, which is staleness-bounded so a deploy that kills a
 *    build cannot wedge the character forever). Refused as `busy` — the work the
 *    caller wants is already happening.
 * 3. **Capacity, then admission.** `startJobAfterAdmission` atomically claims the
 *    per-user job slot BEFORE `imageRenderRejection` can consume the daily
 *    provider budget. The claimed row is only a reservation until admission
 *    passes; a refusal deletes it and starts no provider work. Admission charges
 *    exactly `targets.length` renders and declares the hidden output kind so the
 *    storage leg is skipped: these bytes are excluded from the owner's quota, so
 *    their admission must not spend visible headroom either. Backpressure and
 *    the daily provider budget still apply, because they are about spend and
 *    queue depth rather than disk.
 *
 * A refusal is a VALUE. The caller — the accept route above all — reports it in
 * the response body and leaves everything else exactly as it was.
 */
export async function queueReferenceViewBuild(
  input: QueueReferenceViewBuildInput,
): Promise<ReferenceViewQueueOutcome> {
  const { characterId, ownerId, targets, planned } = input;
  if (targets.length === 0) return { queued: false, reason: null, planned };

  if (await hasLiveCharacterJob("reference_views", characterId)) {
    return { queued: false, reason: "busy", planned };
  }

  const started = await startJobAfterAdmission<"budget">(
    {
      type: "reference_views",
      ownerId,
      payload: { characterId, targets: targets.map((view) => `${view.angle}:${view.wardrobe}`) },
      run: () =>
        buildReferenceViews({ characterId, ownerId, targets }).then((result) => ({ ...result })),
    },
    async () => {
      const refused = await imageRenderRejection(input.user, input.req, {
        count: targets.length,
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
        status: refused.status,
      });
      return "budget";
    },
  );

  if (!started.ok) {
    if ("admission" in started) return { queued: false, reason: started.admission, planned };
    // The per-user job cap refused the reservation. The admission callback did
    // not run, so no daily provider budget was consumed.
    return { queued: false, reason: "busy", planned };
  }
  return { queued: true, reason: null, planned };
}

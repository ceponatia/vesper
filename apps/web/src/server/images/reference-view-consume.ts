import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  referenceViewAngleById,
  referenceViewFaceVisibility,
  type ReferenceView,
  type ReferenceViewState,
} from "@/contracts";
import type { SceneFaceVisibility } from "@vesper/image-core";
import { readOwnedImageBytes } from "./owned-image-reads";
import { getReferenceViewSet } from "./reference-view-store";

/**
 * **The one way a render gets a reference view's bytes.**
 *
 * The selection rule (`contracts/images/reference-views.ts`) says which slot a
 * shot wants; this says whether that slot may be sent, and hands over the bytes
 * if it may. Nothing else queries `kind: "reference_view"`, and nothing else
 * decides consumability: the four conditions live in `isConsumableReferenceView`
 * and reach here through the store's own summary, because a second reading of
 * "usable" is exactly how an unreviewed or stale view reaches a scene.
 *
 * **Every refusal is a value, and every refusal is ordinary.** A character with
 * no sheet, a slot nobody has reviewed, a view whose portrait moved on, an asset
 * whose bytes will not read — all of them mean the render proceeds exactly as it
 * does today, anchored on the front-facing portrait, with an INFO diagnostic
 * naming which of them it was. A missing view may never become a missing image.
 */

/** A view was wanted and there was none to send. INFO: this is the ordinary path, not a fault. */
export const REFERENCE_VIEW_UNAVAILABLE = "images.reference_views.view_unavailable";

/**
 * A consumable view existed and the model's reference capacity had no room for
 * it. Also INFO, and for the same reason: the render is the one it would have
 * made without the sheet, which is a picture rather than an incident.
 */
export const REFERENCE_VIEW_DROPPED_FOR_CAPACITY = "images.reference_views.dropped_for_capacity";

/**
 * Why a wanted view was not sent.
 *
 * Six of the seven are the projected slot states, renamed only where the store's
 * word would read wrong to a render operator (`missing` ⇒ `none_built`); the
 * seventh is the asset read failing under a slot that projected `approved`.
 */
export type ReferenceViewUnavailableReason =
  | "none_built"
  | "stale"
  | "rejected"
  | "unreviewed"
  | "pending"
  | "failed"
  | "missing_bytes";

export type LoadConsumableReferenceViewResult =
  | {
      readonly ok: true;
      /** The view asset — the bytes the render sends. */
      readonly imageId: string;
      readonly buffer: Buffer;
      /** The accepted portrait this view was derived from — the pack's own identity source. */
      readonly sourceImageId: string;
      /** How much of the face this angle shows; `hidden` is what earns the anchor substitution. */
      readonly faceVisibility: SceneFaceVisibility;
    }
  | { readonly ok: false; readonly reason: ReferenceViewUnavailableReason };

/** The store's slot state as the reason a render reports. */
function reasonOf(state: ReferenceViewState): ReferenceViewUnavailableReason {
  switch (state) {
    case "missing":
      return "none_built";
    case "approved":
      // Unreachable through the consumability rule — `approved` IS consumable,
      // and a consumable slot has an asset and an accepted portrait. Answered as
      // `stale` anyway, because a slot projecting `approved` with nothing behind
      // it is a row the owner repairs by building it again.
      return "stale";
    default:
      return state;
  }
}

export interface LoadConsumableReferenceViewInput {
  readonly ownerId: string;
  readonly characterId: string;
  readonly view: ReferenceView;
  readonly sink?: DiagnosticSink;
}

/**
 * This character's view for one slot, if it may be sent.
 *
 * Owner-scoped through the store and the byte reader alike, so a foreign
 * character is indistinguishable from one with no views — the same rule every
 * character surface keeps.
 *
 * One read answers both questions the caller has: the set carries the slot's
 * `consumable` verdict AND the portrait it is measured against. They are not two
 * facts here — a consumable view is by definition one rendered from the portrait
 * the character has accepted right now — so the accepted pointer IS the view's
 * source, and reading the row again to confirm it would only create a window in
 * which the two could disagree.
 */
export async function loadConsumableReferenceView(
  input: LoadConsumableReferenceViewInput,
): Promise<LoadConsumableReferenceViewResult> {
  const { ownerId, characterId, view, sink } = input;
  const refuse = (reason: ReferenceViewUnavailableReason): LoadConsumableReferenceViewResult => {
    sink?.push(
      diag("info", REFERENCE_VIEW_UNAVAILABLE, `no ${view.angle} / ${view.wardrobe} reference view is available (${reason})`, {
        context: { characterId, angle: view.angle, wardrobe: view.wardrobe, reason },
      }),
    );
    return { ok: false, reason };
  };

  const set = await getReferenceViewSet(characterId, ownerId, sink);
  const summary = set.views.find((entry) => entry.angle === view.angle && entry.wardrobe === view.wardrobe);
  // A slot the registry no longer carries is a slot the set never reports; the
  // selection could only have named it from a registry this build does not have.
  if (summary === undefined) return refuse("none_built");
  if (!summary.consumable || summary.imageId === null || set.acceptedImageId === null) {
    return refuse(reasonOf(summary.state));
  }

  const buffer = await readOwnedImageBytes(summary.imageId, ownerId);
  if (buffer === null) return refuse("missing_bytes");

  const angle = referenceViewAngleById(view.angle);
  return {
    ok: true,
    imageId: summary.imageId,
    buffer,
    sourceImageId: set.acceptedImageId,
    // An angle the registry dropped promises no face — the fail-closed answer
    // the registry itself gives, rather than a second mapping here.
    faceVisibility: angle === undefined ? "hidden" : referenceViewFaceVisibility(angle),
  };
}

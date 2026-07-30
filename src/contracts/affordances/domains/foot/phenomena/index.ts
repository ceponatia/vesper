import type { RegisteredAffordancePhenomenon } from "../../../core";
import type { FootAffordanceFrame } from "../frame";
import { footContactPressure } from "./pressure";
import { footSurfaceTextureContact } from "./texture";
import { footGlideResponse } from "./glide";
import { footNailContact } from "./nail";
import { footArticulationObservation } from "./articulation";

export * from "./bands";
export * from "./pressure";
export * from "./texture";
export * from "./glide";
export * from "./nail";
export * from "./articulation";

/**
 * The foot corpus, in resolution order. Order is stable and meaningful: cue
 * ranking's tie-break is `Array#sort`'s stability, so two `clear` reads from the
 * same cut always compete in this order.
 *
 * The sequence is the order a person notices a touch — that it happened, what it
 * felt like, what it did as it moved, then the two narrower reads. Articulation
 * is last because it is the one phenomenon that is not about the contact at all.
 *
 * Four phenomena the spec names are deliberately absent:
 * `foot.contact_temperature` (no temperature owner in either lane),
 * `foot.scent_proximity` (no current-cleanliness or olfactory-access owner),
 * and `foot.pressure_mark_surface_state` / `foot.surface_transfer` (slice 4 —
 * they require a committed effect, and proposing one is not this slice's job).
 */
export const footPhenomena: readonly RegisteredAffordancePhenomenon<FootAffordanceFrame>[] = [
  footContactPressure,
  footSurfaceTextureContact,
  footGlideResponse,
  footNailContact,
  footArticulationObservation,
];
